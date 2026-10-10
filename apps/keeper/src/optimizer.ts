import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWalletClient, http, parseEventLogs, type Address, type Hex } from 'viem';
import { executorAbi, tokenAbi, pairAbi, minBig, safeChunkCap, minimumOutput, slipMinimum, UNIT, type PlanInput, type Quote, type Candidate } from '../../../packages/shared/src/index.js';
import { ROOT,type Runtime } from './config.js';
import { Chain,publicClient,params,message,sellFeeGateReason } from './chain.js';
export function netOutput(output:bigint,gasWei:bigint,price:bigint){if(price<=0n)throw new Error('独立 BNB 价格必须为正');return output-gasWei*price/UNIT;}
export function chooseBest(candidates:Candidate[]){const eligible=candidates.filter(c=>c.chunks.length>0&&BigInt(c.netUSDT)>0n);const full=eligible.filter(c=>c.complete);return (full.length?full:eligible).sort((a,b)=>BigInt(a.netUSDT)>BigInt(b.netUSDT)?-1:1)[0];}
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return p;}
export async function rpc(url:string,method:string,params:unknown[]=[]){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});const data=await r.json() as {error?:{message:string};result:unknown};if(data.error)throw new Error(data.error.message);return data.result;}
export async function waitRPC(url:string,process?:ChildProcess){for(let i=0;i<100;i++){if(process?.exitCode!==null&&process?.exitCode!==undefined)throw new Error('Anvil 提前退出；检查归档 RPC 是否可读取指定区块');try{await rpc(url,'eth_chainId');return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Anvil 启动超时；需要可读取固定区块的归档 RPC');}
export function artifact(file:string,contract:string){const p=resolve(ROOT,`packages/contracts/out/${file}/${contract}.json`);if(!existsSync(p))throw new Error('请先运行 pnpm contracts:build');return JSON.parse(readFileSync(p,'utf8')) as {abi:unknown[];bytecode:{object:Hex}};}
export class Optimizer {
  busy=false; activeChild:ChildProcess|undefined;
  close(){this.activeChild?.kill('SIGTERM');}
  constructor(public config:Runtime,public chain:Chain){}
  async quote(plan:PlanInput,taskId?:Hex):Promise<Quote>{if(this.busy)throw new Error('模拟器正在处理另一个任务，请稍后重试');this.busy=true;try{return this.config.app.mode==='live'&&taskId?await this.quoteCurrentTask(plan,taskId):await this.runQuote(plan,taskId);}finally{this.busy=false;}}
  async quoteCurrentTask(plan:PlanInput,taskId:Hex):Promise<Quote>{
    const c=this.chain.client;let block=await c.getBlock();
    if(block.number===null||block.hash===null)throw new Error('当前报价区块尚未确认');
    let blockNumber=block.number;
    const quote:Quote={id:randomUUID(),owner:plan.owner,blockNumber:blockNumber.toString(),blockHash:block.hash,timestamp:block.timestamp.toString(),simulatedAt:new Date().toISOString(),futureScenario:BigInt(plan.notBefore)>block.timestamp,bnbPrice:'0',candidates:[],reason:'',fingerprint:'',assumptions:[
      '依赖、任务、余额、授权和池元数据先按预检块读取；随后取真实新块，只读模拟完整 executeChunk 路径与 Gas，并在该新块读取独立预言机。',
      '只比较下一批的有限输入候选；候选之间不累计状态，每笔真实确认后重新规划后续批次。',
      '到账和余币来自完整路径只读模拟；Gas 为估算加 20% 余量，非实际已成交或已支付费用。',
    ]};
    try{
      const seller=this.config.app.sellerAddress,a=this.config.app.addresses;
      if(!seller)throw new Error('现有任务需要执行合约地址');
      const [chainId,fingerprint,t,balance,allowance,reserves,token0,token1,gasPrice]=await Promise.all([
        c.getChainId(),this.chain.fingerprint(blockNumber),this.chain.rawTask(taskId,blockNumber),
        c.readContract({address:a.token,abi:tokenAbi,functionName:'balanceOf',args:[plan.owner],blockNumber}),
        c.readContract({address:a.token,abi:tokenAbi,functionName:'allowance',args:[plan.owner,seller],blockNumber}),
        c.readContract({address:a.pair,abi:pairAbi,functionName:'getReserves',blockNumber}),
        c.readContract({address:a.pair,abi:pairAbi,functionName:'token0',blockNumber}),
        c.readContract({address:a.pair,abi:pairAbi,functionName:'token1',blockNumber}),c.getGasPrice(),
      ]);
      if(chainId!==this.config.app.chainId)throw new Error('RPC 链与应用模式不匹配');
      quote.fingerprint=fingerprint;
      quote.assumptions.push(`元数据预检区块为 ${blockNumber}；输入候选沿用该块的额度与池规模，实际输出和余币由随后新块的合约模拟验证。`);
      if(t.owner.toLowerCase()!==plan.owner.toLowerCase()||t.params.executor.toLowerCase()!==plan.executor.toLowerCase()||t.status<1||t.status>2)throw new Error('现有任务不匹配或已结束');
      if(block.timestamp<t.params.notBefore)throw new Error('开始时间未到；当前区块报价不会推进未来时间');
      if(block.timestamp>=t.params.expiresAt)throw new Error('任务时间窗已经结束');
      if(t.nextChunkIndex>=t.params.maxChunks)throw new Error('任务最大批数已达到');
      if(gasPrice>t.params.maxGasPrice)throw new Error('当前 Gas 价格超过任务上限');
      const forward=token0.toLowerCase()===a.token.toLowerCase()&&token1.toLowerCase()===a.usdt.toLowerCase();
      const reverse=token1.toLowerCase()===a.token.toLowerCase()&&token0.toLowerCase()===a.usdt.toLowerCase();
      if(!forward&&!reverse)throw new Error('池中资产与配置不匹配');
      const reserveToken=reserves[forward?0:1],reserveUSDT=reserves[forward?1:0];
      if(reserveToken===0n||reserveUSDT===0n)throw new Error('池储备为零，不能报价');
      const remaining=t.params.maxTotalInput-t.soldInput;
      if(remaining<=0n||allowance===0n||balance===0n)throw new Error('余额、授权或任务累计额度不足');
      const cap=minBig(balance,allowance,remaining),seen=new Set<string>();
      const modes=[{name:'下一批合法额度',ratio:0},{name:'下一批保守上限',ratio:150},{name:'下一批较小分批',ratio:75}];
      const inputs=modes.flatMap(mode=>{const input=mode.ratio?minBig(cap,reserveToken*BigInt(mode.ratio)/10000n):cap;const key=input.toString();if(input===0n||seen.has(key))return [];seen.add(key);return [{name:mode.name,input}];});
      // No executable result exists yet. Bind all output-producing calls to a newly read block.
      block=await c.getBlock();if(block.number===null||block.hash===null)throw new Error('当前报价区块尚未确认');
      blockNumber=block.number;quote.blockNumber=blockNumber.toString();quote.blockHash=block.hash;quote.timestamp=block.timestamp.toString();quote.simulatedAt=new Date().toISOString();quote.futureScenario=block.timestamp<t.params.notBefore;
      if(block.timestamp<t.params.notBefore)throw new Error('开始时间未到；当前区块报价不会推进未来时间');
      if(block.timestamp>=t.params.expiresAt)throw new Error('任务时间窗已经结束');
      const validUntil=minBig(t.params.expiresAt,block.timestamp+120n);
      const [price,candidates,tax]=await Promise.all([this.chain.bnbPrice(blockNumber),Promise.all(inputs.map(async({name,input})=>{
        const candidate:Candidate={name,chunks:[],output:'0',gasWei:'0',netUSDT:'0',residual:balance.toString(),complete:false};
        try{
          const hard=minimumOutput(input,t.params.minUSDTPerToken);
          const sim=await c.simulateContract({account:plan.executor,address:seller,abi:executorAbi,functionName:'executeChunk',args:[plan.owner,taskId,t.nextChunkIndex,input,hard,validUntil],gasPrice,blockNumber});
          const [output,residual]=sim.result,minOut=slipMinimum(output,plan.policy.slippageBps,hard);
          const gas=await c.estimateContractGas({account:plan.executor,address:seller,abi:executorAbi,functionName:'executeChunk',args:[plan.owner,taskId,t.nextChunkIndex,input,minOut,validUntil],gasPrice,blockNumber});
          const gasLimit=(gas*120n+99n)/100n,gasWei=gasLimit*gasPrice;
          if(gasWei>BigInt(plan.policy.maxTxGasWei)||gasWei>BigInt(plan.policy.gasBudgetWei))throw new Error('候选超过 Gas 预算');
          candidate.output=output.toString();candidate.gasWei=gasWei.toString();candidate.residual=residual.toString();candidate.complete=residual<=t.params.maxDustTokens;
          candidate.chunks.push({input:input.toString(),output:output.toString(),gas:gasLimit.toString(),gasWei:gasWei.toString(),minOut:minOut.toString(),residual:residual.toString()});
        }catch(e){candidate.error=`输入 ${input}：${message(e)}`;}
        return candidate;
      })),plan.policy.maxSellFeePercent===undefined?null:this.chain.predictSellFee(blockNumber,plan.owner)]);
      quote.bnbPrice=price.toString();quote.candidates=candidates;
      if(tax){const reason=sellFeeGateReason(plan.policy.maxSellFeePercent,tax);if(reason)throw new Error(`税率门禁：${reason}`);quote.assumptions.push(`模拟区块预计基础卖出税率 ${tax.sellFeeAfterSync}%；税率上限由服务层复查，已部署合约只硬保护最低到账。`);}
      for(const candidate of candidates){if(!candidate.chunks.length)continue;const net=netOutput(BigInt(candidate.output),BigInt(candidate.gasWei),price);candidate.netUSDT=net.toString();if(net<BigInt(plan.policy.minEconomicUSDT)){candidate.error=`输入 ${candidate.chunks[0]!.input}：本笔预计经济净额低于阈值`;candidate.chunks=[];candidate.complete=false;}}
      const canonical=await c.getBlock({blockNumber});if(canonical.hash!==quote.blockHash)throw new Error('报价所依据的区块已重组，需重新模拟');
      quote.best=chooseBest(quote.candidates);
      quote.reason=quote.best?`${quote.best.name} 在当前下一批候选中经济净额最高；确认后重新规划。`:`当前没有可执行的下一批；${quote.candidates.find(candidate=>candidate.error)?.error??'候选预计净额不为正'}`;
    }catch(e){quote.best=undefined;quote.reason=message(e);}
    return quote;
  }
  private async runQuote(plan:PlanInput,taskId?:Hex):Promise<Quote>{let child:ChildProcess|undefined;let log='';const block=await this.chain.client.getBlock();const quote:Quote={id:randomUUID(),owner:plan.owner,blockNumber:block.number!.toString(),blockHash:block.hash!,timestamp:block.timestamp.toString(),simulatedAt:new Date().toISOString(),futureScenario:BigInt(plan.notBefore)>block.timestamp,bnbPrice:'0',candidates:[],reason:'',fingerprint:'',assumptions:['各候选从同一固定区块开始，候选内各批次顺序执行并保留状态。','只比较有限候选；不预测未来买盘、税率恢复或价格上涨。','模拟未完成的路径会显示剩余数量；已成交的批次不能被后续失败撤销。']};const started=Date.now();try{
    if(await this.chain.client.getChainId()!==this.config.app.chainId)throw new Error('RPC 链与应用模式不匹配');
    quote.fingerprint=await this.chain.fingerprint(block.number!);const price=await this.chain.bnbPrice(block.number!);quote.bnbPrice=price.toString();
    const executable=resolve(ROOT,'.tools/anvil');if(!existsSync(executable))throw new Error('缺少 Anvil，请运行 node scripts/install-tools.mjs');
    const port=await freePort(),url=`http://127.0.0.1:${port}`;
    child=spawn(executable,['--host','127.0.0.1','--port',String(port),'--chain-id',String(this.config.app.chainId),'--fork-url',this.config.forkRpc,'--fork-block-number',block.number!.toString(),'--block-base-fee-per-gas','0','--silent'],{stdio:['ignore','ignore','pipe']});this.activeChild=child;child.stderr?.on('data',d=>{log=(log+String(d)).slice(-2000);});await waitRPC(url,child);
    const c=publicClient(url),wallet=createWalletClient({transport:http(url)}),bootstrapGasPrice=await this.chain.client.getGasPrice();const a=this.config.app.addresses;
    for(const address of [plan.owner,plan.executor]){await rpc(url,'anvil_impersonateAccount',[address]);await rpc(url,'anvil_setBalance',[address,'0x56bc75e2d63100000']);}
    let seller=this.config.app.sellerAddress;let id=taskId;
    if(!id){
      if(!seller){const prod=this.config.app.chainId===56;const art=artifact(prod?'NBDAOSeller.sol':'Fixtures.sol',prod?'NBDAOSeller':'LocalSeller');const hash=await wallet.deployContract({account:plan.executor,chain:null,gasPrice:bootstrapGasPrice,type:'legacy',abi:art.abi,bytecode:art.bytecode.object,args:prod?[]:[a.token,a.usdt,a.pair,a.router,a.factory]});seller=(await c.waitForTransactionReceipt({timeout:20000,hash})).contractAddress!;}
      const approve=await wallet.writeContract({account:plan.owner,chain:null,gasPrice:bootstrapGasPrice,type:'legacy',address:a.token,abi:tokenAbi,functionName:'approve',args:[seller,BigInt(plan.maxTotalInput)]});await c.waitForTransactionReceipt({timeout:20000,hash:approve});
      const create=await wallet.writeContract({account:plan.owner,chain:null,gasPrice:bootstrapGasPrice,type:'legacy',address:seller,abi:executorAbi,functionName:'createTask',args:[params(plan)]});const receipt=await c.waitForTransactionReceipt({timeout:20000,hash:create});id=parseEventLogs({abi:executorAbi,eventName:'TaskCreated',logs:receipt.logs})[0]?.args.taskId;if(!id)throw new Error('分叉中创建任务未产生 TaskCreated');quote.assumptions.push('新任务预览仅在隔离分叉内准备限额授权与任务；公共链没有写入。');
    }
    if(!seller||!id)throw new Error('现有任务需要执行合约地址');
    const onchain=await c.readContract({address:seller,abi:executorAbi,functionName:'getTask',args:[id]});if(onchain.owner.toLowerCase()!==plan.owner.toLowerCase()||onchain.params.executor.toLowerCase()!==plan.executor.toLowerCase()||onchain.status<1||onchain.status>2)throw new Error('现有任务不匹配或已结束');
    const current=await c.getBlock();const at=BigInt(plan.notBefore)>current.timestamp?BigInt(plan.notBefore):current.timestamp+1n;if(at>=BigInt(plan.expiresAt))throw new Error('任务时间窗已经结束');if(quote.futureScenario)quote.assumptions.push('未来场景只推进时间，沿用当前储备和依赖；到时必须重新模拟。');await rpc(url,'evm_setNextBlockTimestamp',[Number(at)]);await rpc(url,'evm_mine');
    const gasPrice=await this.chain.client.getGasPrice();if(gasPrice>BigInt(plan.maxGasPrice))throw new Error('当前 Gas 价格超过用户上限');
    let snapshot=await rpc(url,'evm_snapshot');
    for(const mode of [{name:'合法时单笔',ratio:0},{name:'保守上限分批',ratio:150},{name:'较小分批',ratio:75}]){
      await rpc(url,'evm_revert',[snapshot]);snapshot=await rpc(url,'evm_snapshot');
      const candidate:Candidate={name:mode.name,chunks:[],output:'0',gasWei:'0',netUSDT:'0',residual:'0',complete:false};let total=0n,gasTotal=0n;
      try{
        const first=await c.readContract({address:seller,abi:executorAbi,functionName:'getTask',args:[id]});
        const depth=Math.min(plan.maxChunks-first.nextChunkIndex,8);
        for(let n=0;n<depth;n++){
          if(Date.now()-started>this.config.quoteTimeoutMs)throw new Error('模拟计算预算已用尽，候选未完成');
          const t=await c.readContract({address:seller,abi:executorAbi,functionName:'getTask',args:[id]});const [balance,allowance,reserves]=await Promise.all([c.readContract({address:a.token,abi:tokenAbi,functionName:'balanceOf',args:[plan.owner]}),c.readContract({address:a.token,abi:tokenAbi,functionName:'allowance',args:[plan.owner,seller]}),c.readContract({address:a.pair,abi:pairAbi,functionName:'getReserves'})]);candidate.residual=balance.toString();if(balance<=BigInt(plan.maxDustTokens)){candidate.complete=true;break;}if(t.status>2)break;let amount=minBig(balance,allowance,t.params.maxTotalInput-t.soldInput);if(mode.ratio)amount=minBig(amount,reserves[1]*BigInt(mode.ratio)/10000n);if(amount===0n)throw new Error('授权或任务累计额度不足');if(mode.ratio===0&&amount<balance)throw new Error('当前授权或额度不足以单笔覆盖余额');
          const hard=minimumOutput(amount,t.params.minUSDTPerToken);const head=await c.getBlock();const validUntil=BigInt(plan.expiresAt)<head.timestamp+120n?BigInt(plan.expiresAt):head.timestamp+120n;
          const args=[plan.owner,id,t.nextChunkIndex,amount,hard,validUntil] as const;
          const sim=await c.simulateContract({account:plan.executor,address:seller,abi:executorAbi,functionName:'executeChunk',args,gasPrice});
          const output=sim.result[0];const gas=await c.estimateContractGas({account:plan.executor,address:seller,abi:executorAbi,functionName:'executeChunk',args,gasPrice});const gasLimit=gas*120n/100n;const gasWei=gasLimit*gasPrice;
          if(gasWei>BigInt(plan.policy.maxTxGasWei)||gasTotal+gasWei>BigInt(plan.policy.gasBudgetWei))throw new Error('候选超过 Gas 预算');
          if(netOutput(output,gasWei,price)<BigInt(plan.policy.minEconomicUSDT))throw new Error('本笔预计经济净额低于阈值');
          const minOut=slipMinimum(output,plan.policy.slippageBps,hard);
          const hash=await wallet.writeContract({account:plan.executor,chain:null,address:seller,abi:executorAbi,functionName:'executeChunk',args:[plan.owner,id,t.nextChunkIndex,amount,minOut,validUntil],gas:gasLimit,gasPrice});const receipt=await c.waitForTransactionReceipt({timeout:20000,hash});if(receipt.status!=='success')throw new Error('完整路径执行回滚');const event=parseEventLogs({abi:executorAbi,eventName:'ChunkExecuted',logs:receipt.logs})[0];if(!event)throw new Error('缺少成交事件');const actual=event.args.usdtReceived,cost=receipt.gasUsed*receipt.effectiveGasPrice;total+=actual;gasTotal+=cost;candidate.residual=event.args.residual.toString();candidate.chunks.push({input:amount.toString(),output:actual.toString(),gas:gasLimit.toString(),gasWei:cost.toString(),minOut:minOut.toString(),residual:candidate.residual});if(BigInt(candidate.residual)<=BigInt(plan.maxDustTokens)){candidate.complete=true;break;}if(mode.ratio===0)break;
        }
        if(!candidate.complete&&candidate.chunks.length>=8)candidate.error='计算预算最多模拟 8 批，显示已模拟部分和余币；后续需滚动重新规划';
      }catch(e){candidate.error=message(e);}
      candidate.output=total.toString();candidate.gasWei=gasTotal.toString();candidate.netUSDT=netOutput(total,gasTotal,price).toString();quote.candidates.push(candidate);
    }
    quote.best=chooseBest(quote.candidates);quote.reason=quote.best?`${quote.best.name} 在已模拟候选中经济净额最高；每笔确认后重规划。`:'当前没有满足最低到账、额度与预算的可执行候选；保持保护并等待。';
  }catch(e){quote.reason=message(e);if(log&&quote.reason.includes('Anvil'))quote.reason+='；归档节点未提供固定区块状态时无法模拟。';}finally{child?.kill('SIGTERM');this.activeChild=undefined;}return quote;}
}
