import { createPublicClient, fallback, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { tokenAbi,pairAbi,routerAbi,factoryAbi,executorAbi,IMPLEMENTATION_SLOT,UNIT,type WalletSnapshot,type PriceSnapshot,type SellTaxSnapshot,type TaskView,type PlanInput } from '../../../packages/shared/src/index.js';
import { existsSync,readFileSync } from 'node:fs';
import type { Runtime } from './config.js';
import type { Store } from './store.js';
import { poolSpotPrice } from './price.js';
export const publicClient=(url:string)=>createPublicClient({pollingInterval:url.startsWith('http://127.0.0.1:')?100:4000,transport:http(url,{timeout:15000,retryCount:1})});
/** Read failures can use another configured node. JSON-RPC batching does not change eth_call's sender or block. */
export function readClient(urls:string[]){
  if(!urls.length)throw new Error('没有配置读取 RPC');
  return createPublicClient({pollingInterval:urls[0]!.startsWith('http://127.0.0.1:')?100:4000,
    transport:fallback(urls.map(url=>http(url,{timeout:15000,retryCount:0,batch:{wait:5,batchSize:20}})),{rank:false,retryCount:1})});
}
export const params=(p:PlanInput)=>({executor:p.executor,notBefore:BigInt(p.notBefore),expiresAt:BigInt(p.expiresAt),maxChunks:p.maxChunks,maxTotalInput:BigInt(p.maxTotalInput),minUSDTPerToken:BigInt(p.minUSDTPerToken),maxDustTokens:BigInt(p.maxDustTokens),maxGasPrice:BigInt(p.maxGasPrice)});
export function message(e:unknown){let s=e instanceof Error?e.message:String(e);s=s.replace(/https?:\/\/[^\s)]+/g,'[RPC]').replace(/0x[0-9a-fA-F]{64}/g,'[hash]');return s.slice(0,1200);}
export type SellFeeState={timestamp:bigint;reserveUSDT:bigint;reserveToken:bigint;poolTimestamp:bigint;lastDayReserves:readonly [bigint,bigint,bigint,bigint];lastMiningDay:bigint;totalPower:bigint;actualUSDTBalance:bigint};
/** Exact basic fee order in the verified NBDAO sync(true) and getSellFee. Full executeChunk simulation still checks token-side effects and profit fees. */
export function predictPostSyncSellFee(s:SellFeeState){
  if([s.timestamp,s.reserveUSDT,s.reserveToken,s.poolTimestamp,...s.lastDayReserves,s.lastMiningDay,s.totalPower,s.actualUSDTBalance].some(v=>typeof v!=='bigint'||v<0n))throw new Error('税率预测字段缺失或无效');
  let [baselineU,baselineT,day,previousU]=s.lastDayReserves;
  const poolDay=s.poolTimestamp/86400n,rolled=s.reserveUSDT>0n&&day<poolDay;
  if(rolled){previousU=baselineU;baselineU=s.reserveUSDT;baselineT=s.reserveToken;day=poolDay;}
  const mined=s.lastMiningDay>0n&&s.totalPower>0n&&s.timestamp/86400n>s.lastMiningDay;
  const currentU=mined?s.actualUSDTBalance:s.reserveUSDT;
  if(mined&&s.reserveToken===0n)throw new Error('挖矿同步的代币储备为零，无法可靠预测税率');
  if(mined&&currentU>2n**112n-1n)throw new Error('同步后 USDT 储备超过池可表示范围');
  if(baselineU===0n)return {feePercent:3,rolled,mined,currentUSDT:currentU,baselineUSDT:baselineU,previousUSDT:previousU};
  if(baselineT===0n||baselineU*UNIT/baselineT===0n)throw new Error('日价格基线为零，税率 getter 无法完成');
  if(!mined&&s.reserveToken===0n)throw new Error('当前代币储备为零，税率 getter 无法完成');
  const denominator=baselineU>previousU?baselineU:previousU,ratio=currentU*100n/denominator;
  const feePercent=ratio<96n?100:ratio<97n?80:ratio<98n?40:ratio<99n?20:ratio<100n?10:5;
  return {feePercent,rolled,mined,currentUSDT:currentU,baselineUSDT:baselineU,previousUSDT:previousU};
}
export function sellFeeGateReason(max:number|undefined,p:SellTaxSnapshot){
  if(max===undefined)return null;
  if(!Number.isInteger(max)||max<0||max>100)return '最高基础税率配置无效，暂停执行';
  if(p.sellFeeAfterSync===null)return `基础卖出税率无法判断，暂停执行：${p.reason}`;
  const fee=Number(p.sellFeeAfterSync);if(!/^\d{1,3}$/.test(p.sellFeeAfterSync)||!Number.isInteger(fee)||fee<0||fee>100)return '基础卖出税率预测无效，暂停执行';
  return fee>max?`预计同步后基础卖出税率 ${fee}% 高于上限 ${max}%，继续监控`:null;
}
export class Chain {
  private taxCache:{key:string;value:Promise<SellTaxSnapshot>}|undefined;
  client; constructor(public config:Runtime){this.client=readClient(config.rpcUrls);}
  async health(){const ids=await Promise.allSettled(this.config.rpcUrls.map(async url=>{const c=publicClient(url);const [chainId,b]=await Promise.all([c.getChainId(),c.getBlock()]);if(chainId!==this.config.app.chainId)throw new Error('RPC 网络错误');return {chainId,number:b.number!,timestamp:b.timestamp};}));const good=ids.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);if(!good.length)throw new Error('没有可用 RPC');const max=good.reduce((m,b)=>b.number>m?b.number:m,0n);return {healthy:good.filter(b=>max-b.number<=5n).length,configured:ids.length};}
  async price():Promise<PriceSnapshot>{
    const [chainId,b]=await Promise.all([this.client.getChainId(),this.client.getBlock()]);
    if(chainId!==this.config.app.chainId)throw new Error('价格 RPC 网络与应用配置不匹配');
    if(b.number===null||b.hash===null)throw new Error('价格数据区块尚未确认');
    const blockNumber=b.number,a=this.config.app.addresses;
    const [token0,token1,reserves,tokenDecimals,usdtDecimals]=await Promise.all([
      this.client.readContract({address:a.pair,abi:pairAbi,functionName:'token0',blockNumber}),
      this.client.readContract({address:a.pair,abi:pairAbi,functionName:'token1',blockNumber}),
      this.client.readContract({address:a.pair,abi:pairAbi,functionName:'getReserves',blockNumber}),
      this.client.readContract({address:a.token,abi:tokenAbi,functionName:'decimals',blockNumber}),
      this.client.readContract({address:a.usdt,abi:tokenAbi,functionName:'decimals',blockNumber}),
    ]);
    return {chainId,pair:a.pair,token:a.token,usdt:a.usdt,tokenDecimals,usdtDecimals,
      ...poolSpotPrice({token:a.token,usdt:a.usdt,token0,token1,reserve0:reserves[0],reserve1:reserves[1],tokenDecimals,usdtDecimals}),
      blockNumber:blockNumber.toString(),blockHash:b.hash,timestamp:b.timestamp.toString(),poolTimestamp:reserves[2].toString()};
  }
  async tax():Promise<SellTaxSnapshot>{
    const b=await this.client.getBlock();if(b.number===null||b.hash===null)throw new Error('税率数据区块尚未确认');
    const key=`${b.number}:${b.hash}`;
    if(this.taxCache?.key!==key){
      const number=b.number,hash=b.hash;
      this.taxCache={key,value:this.predictSellFee(number).catch(e=>({sellFeeAfterSync:null,blockNumber:number.toString(),blockHash:hash,timestamp:b.timestamp.toString(),reason:message(e)}))};
    }
    const snapshot=await this.taxCache.value;
    if(snapshot.blockHash!==b.hash)return {...snapshot,sellFeeAfterSync:null,reason:'税率区块已重组，等待新快照'};
    return snapshot;
  }
  async predictSellFee(blockNumber:bigint,owner?:Address):Promise<SellTaxSnapshot>{
    const c=this.client;const [b,chainId]=await Promise.all([c.getBlock({blockNumber}),c.getChainId()]);if(b.number===null||b.hash===null)throw new Error('税率数据区块尚未确认');
    const snapshot:SellTaxSnapshot={sellFeeAfterSync:null,blockNumber:blockNumber.toString(),blockHash:b.hash,timestamp:b.timestamp.toString(),reason:''};
    try{
      if(chainId!==this.config.app.chainId)throw new Error('税率 RPC 网络与应用配置不匹配');
      const a=this.config.app.addresses;
      if(this.config.app.mode==='local'){const fee=await c.readContract({address:a.token,abi:tokenAbi,functionName:'getSellFee',blockNumber});if(fee[0]>100n)throw new Error('测试税率超出范围');snapshot.sellFeeAfterSync=fee[0].toString();snapshot.reason='本地 Mock 测试税率，不能用于 BSC';return snapshot;}
      const [reserves,token0,token1,lastDay,lastMiningDay,info,actualU,ownerWL,pairWL]=await Promise.all([
        c.readContract({address:a.pair,abi:pairAbi,functionName:'getReserves',blockNumber}),
        c.readContract({address:a.pair,abi:pairAbi,functionName:'token0',blockNumber}),c.readContract({address:a.pair,abi:pairAbi,functionName:'token1',blockNumber}),
        c.readContract({address:a.token,abi:tokenAbi,functionName:'lastDayReserves',blockNumber}),c.readContract({address:a.token,abi:tokenAbi,functionName:'lastMiningDay',blockNumber}),
        c.readContract({address:a.token,abi:tokenAbi,functionName:'info',blockNumber}),c.readContract({address:a.usdt,abi:tokenAbi,functionName:'balanceOf',args:[a.pair],blockNumber}),
        owner?c.readContract({address:a.token,abi:tokenAbi,functionName:'isWL',args:[owner],blockNumber}):false,
        owner?c.readContract({address:a.token,abi:tokenAbi,functionName:'isWL',args:[a.pair],blockNumber}):false,
      ]);
      if(token0.toLowerCase()!==a.usdt.toLowerCase()||token1.toLowerCase()!==a.token.toLowerCase())throw new Error('池资产顺序与已验证 NBDAO 源码不符，无法预测税率');
      if(owner&&(ownerWL||pairWL)){snapshot.sellFeeAfterSync='0';snapshot.reason='该发送方或池在白名单，源码直接转账分支不收基础卖出税';}
      else{
        if(info[2]===0n||b.timestamp<=info[2])throw new Error('代币卖出启动时间尚未到达');
        const predicted=predictPostSyncSellFee({timestamp:b.timestamp,reserveUSDT:reserves[0],reserveToken:reserves[1],poolTimestamp:BigInt(reserves[2]),lastDayReserves:lastDay,lastMiningDay,totalPower:info[1],actualUSDTBalance:actualU});
        snapshot.sellFeeAfterSync=String(predicted.feePercent);snapshot.reason='按当前区块预测 sync(true) 后的基础税率；额外利润税、实际到账和完整路径仍须模拟，税率上限仅由服务层执行';
      }
      const canonical=await c.getBlock({blockNumber});if(canonical.hash!==snapshot.blockHash)throw new Error('税率区块已重组，需重新读取');
    }catch(e){snapshot.sellFeeAfterSync=null;snapshot.reason=message(e);}
    return snapshot;
  }
  async wallet(owner:Address):Promise<WalletSnapshot>{const b=await this.client.getBlock();const blockNumber=b.number!;const a=this.config.app.addresses;const [balance,pending,usdt,bnb,allowance,fee,reserves]=await Promise.all([this.client.readContract({address:a.token,abi:tokenAbi,functionName:'balanceOf',args:[owner],blockNumber}),this.client.readContract({address:a.token,abi:tokenAbi,functionName:'pending',args:[owner],blockNumber}),this.client.readContract({address:a.usdt,abi:tokenAbi,functionName:'balanceOf',args:[owner],blockNumber}),this.client.getBalance({address:owner,blockNumber}),this.config.app.sellerAddress?this.client.readContract({address:a.token,abi:tokenAbi,functionName:'allowance',args:[owner,this.config.app.sellerAddress],blockNumber}):0n,this.client.readContract({address:a.token,abi:tokenAbi,functionName:'getSellFee',blockNumber}),this.client.readContract({address:a.pair,abi:pairAbi,functionName:'getReserves',blockNumber})]);return{owner,tokenBalance:balance.toString(),pending:pending.toString(),usdtBalance:usdt.toString(),bnbBalance:bnb.toString(),allowance:allowance.toString(),blockNumber:blockNumber.toString(),blockHash:b.hash!,timestamp:b.timestamp.toString(),sellFee:fee[0].toString(),reserveToken:reserves[1].toString(),reserveUSDT:reserves[0].toString()};}
  async rawTask(id:Hex,blockNumber?:bigint){if(!this.config.app.sellerAddress)throw new Error('执行合约未配置');return this.client.readContract({address:this.config.app.sellerAddress,abi:executorAbi,functionName:'getTask',args:[id],blockNumber});}
  async view(id:Hex,store:Store):Promise<TaskView>{
    const b=await this.client.getBlock(),t=await this.rawTask(id,b.number!);if(t.status===0)throw new Error('链上没有此任务');
    const residual=await this.client.readContract({address:this.config.app.addresses.token,abi:tokenAbi,functionName:'balanceOf',args:[t.owner],blockNumber:b.number!});
    const r=store.task(id),attempts=store.attempts(id),windowExpired=t.status<3&&b.timestamp>=t.params.expiresAt;
    return{taskId:id,owner:t.owner,executor:t.params.executor,status:windowExpired?6:t.status,chainStatus:t.status,windowExpired,
      serviceStatus:windowExpired?'WindowExpired':t.status>=3?'Closed':r?.status??'MissingConfiguration',
      reason:windowExpired?'监控窗口已到期；服务停止卖出且不额外花 Gas 结束任务，下次创建任务会关闭旧链上任务。':t.status>=3?'链上任务已结束':r?.reason??'尚未注册执行服务',
      nextChunkIndex:t.nextChunkIndex,notBefore:t.params.notBefore.toString(),expiresAt:t.params.expiresAt.toString(),maxChunks:t.params.maxChunks,maxTotalInput:t.params.maxTotalInput.toString(),minUSDTPerToken:t.params.minUSDTPerToken.toString(),maxDustTokens:t.params.maxDustTokens.toString(),maxGasPrice:t.params.maxGasPrice.toString(),soldInput:t.soldInput.toString(),receivedUSDT:t.receivedUSDT.toString(),residual:residual.toString(),gasSpentWei:store.spent(id).toString(),attempts:attempts.length,policy:r?.policy??null,
      fills:attempts.filter(a=>a.output!=='0'&&a.blockNumber).map(a=>({hash:a.hash,index:a.index,input:a.input,output:a.output,gasWei:a.gasWei,blockNumber:a.blockNumber!,confirmed:a.confirmed}))};
  }
  async fingerprint(blockNumber:bigint){const a=this.config.app.addresses;const entries=await Promise.all(Object.entries(a).map(async([key,address])=>{const code=await this.client.getCode({address,blockNumber});if(!code||code==='0x')throw new Error(`${key} 没有合约字节码`);return {key,address,hash:keccak256(code)};}));const implementation=this.config.app.mode==='local'?'0x':await this.client.getStorageAt({address:a.fund,slot:IMPLEMENTATION_SLOT,blockNumber});const [t0,t1,factory,pair,decimals,uDecimals,quotes,basePair]=await Promise.all([this.client.readContract({address:a.pair,abi:pairAbi,functionName:'token0',blockNumber}),this.client.readContract({address:a.pair,abi:pairAbi,functionName:'token1',blockNumber}),this.client.readContract({address:a.router,abi:routerAbi,functionName:'factory',blockNumber}),this.client.readContract({address:a.factory,abi:factoryAbi,functionName:'getPair',args:[a.token,a.usdt],blockNumber}),this.client.readContract({address:a.token,abi:tokenAbi,functionName:'decimals',blockNumber}),this.client.readContract({address:a.usdt,abi:tokenAbi,functionName:'decimals',blockNumber}),Promise.all([1n,10n,100n].map(n=>this.client.readContract({address:a.router,abi:routerAbi,functionName:'getAmountOut',args:[n*UNIT,1000n*UNIT,1000n*UNIT],blockNumber}))),this.client.readContract({address:a.token,abi:tokenAbi,functionName:'basePair',blockNumber})]);if(t0.toLowerCase()!==a.usdt.toLowerCase()||t1.toLowerCase()!==a.token.toLowerCase()||factory.toLowerCase()!==a.factory.toLowerCase()||pair.toLowerCase()!==a.pair.toLowerCase()||basePair.toLowerCase()!==a.pair.toLowerCase()||decimals!==18||uDecimals!==18)throw new Error('资产、池或精度核验失败');for(let i=0;i<quotes.length;i++){const x=BigInt([1,10,100][i]!)*UNIT;const expected=x*9975n*1000n*UNIT/(1000n*UNIT*10000n+x*9975n);if(quotes[i]!==expected)throw new Error('Router 费率与预期不符');}if(this.config.app.mode==='live'){if(!existsSync(this.config.baselineFile))throw new Error('缺少依赖基线');const baseline=JSON.parse(readFileSync(this.config.baselineFile,'utf8'));for(const e of entries){const old=baseline.codes?.find((v:{key:string})=>v.key===e.key);if(!old||old.hash!==e.hash||old.address.toLowerCase()!==e.address.toLowerCase())throw new Error(`依赖变化: ${e.key}`);}if(implementation!==baseline.implementation)throw new Error('资金池实现已变化');}return keccak256(new TextEncoder().encode(JSON.stringify({entries,implementation})));}
  async bnbPrice(blockNumber:bigint){
    if(this.config.price!==null)return this.config.price;
    if(!this.config.priceOracle)throw new Error('未配置独立 BNB/USDT 价格源；已暂停净额优化');
    const abi=parseAbi(['function decimals() view returns (uint8)','function description() view returns (string)','function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
    const b=await this.client.getBlock({blockNumber});
    const feed=async(address:Address)=>{const [dec,r,description]=await Promise.all([this.client.readContract({address,abi,functionName:'decimals',blockNumber}),this.client.readContract({address,abi,functionName:'latestRoundData',blockNumber}),this.client.readContract({address,abi,functionName:'description',blockNumber})]);if(r[1]<=0n||r[3]===0n||r[4]<r[0]||r[3]>b.timestamp||b.timestamp-r[3]>BigInt(this.config.priceMaxAge)||dec>36)throw new Error('价格源过期或无效');return {price:r[1]*UNIT/(10n**BigInt(dec)),description};};
    const primary=await feed(this.config.priceOracle);
    if(/BNB\s*\/\s*USDT/i.test(primary.description))return primary.price;
    if(!/BNB\s*\/\s*USD\b/i.test(primary.description))throw new Error('价格源 description 必须为 BNB/USDT 或 BNB/USD');
    if(!this.config.usdtOracle)throw new Error('BNB/USD 报价需同时配置 USDT_USD_ORACLE，不能将 USD 默认为 USDT');
    const usdt=await feed(this.config.usdtOracle);if(!/USDT\s*\/\s*USD\b/i.test(usdt.description)||usdt.price<=0n)throw new Error('第二价格源必须为有效 USDT/USD');
    return primary.price*UNIT/usdt.price;
  }
}
