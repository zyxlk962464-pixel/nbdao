import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionData, keccak256, parseEventLogs, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError, type Address, type Hex, type TransactionSerializedLegacy } from 'viem';
import { openingExecutorAbi, executorAbi, tokenAbi, ZERO_ID } from '../../../packages/shared/src/index.js';
import { ROOT, type Runtime } from './config.js';
import { Chain, message } from './chain.js';
import { assertOwnerAllowed, assertTaskAllowed } from './access.js';
import { integer, units } from './validation.js';
import { BuilderClient } from './builder-client.js';
import { OpeningStore, type OpeningAttempt, type OpeningPolicy, type OpeningRegistered } from './opening-store.js';
import type { Store } from './store.js';

export const OPENING_GAS_LIMIT=1_450_000n;
export const OPENING_GAS_CEILING=1_500_000n;
export const OPENING_BUILDER='0x4848489f0b2bedd788c696e2d79b6b69d7484848' as Address;
const MAX_SUBMISSIONS=8;
const SUBMISSION_OFFSETS_MS=[-1000,-500,0,500,1500,3000,6000,9000] as const;
class OpeningReceiptReorg extends Error {}
function openingMessage(e:unknown){return message((e instanceof Error?e.message:String(e)).replace(/0x[0-9a-f]{40,}/gi,'[交易数据]'));}
export function openingPolicy(value:unknown):OpeningPolicy{
  const p=value as OpeningPolicy;if(!p||typeof p!=='object')throw new Error('缺少抢卖服务条件');
  if(!Array.isArray(p.setupTxHashes)||p.setupTxHashes.length<1||p.setupTxHashes.length>16||p.setupTxHashes.some(h=>typeof h!=='string'||!/^0x[0-9a-f]{64}$/i.test(h))||new Set(p.setupTxHashes.map(h=>h.toLowerCase())).size!==p.setupTxHashes.length)throw new Error('准备交易回执无效或重复');
  integer(p.confirmations,'确认数',3,3);
  return {totalCostWei:units(p.totalCostWei,'BNB 总费用上限',true),setupTxHashes:p.setupTxHashes.map(h=>h.toLowerCase() as Hex),gasPriceWei:units(p.gasPriceWei,'固定 Gas 价格',true),builderFeeWei:units(p.builderFeeWei,'固定构建者费用'),confirmations:3};
}
/** Compare reviewed runtime while masking constructor immutable words, then check every binding separately. */
export function reviewedOpeningCode(code:Hex,artifact:{deployedBytecode:{object:Hex;immutableReferences?:Record<string,{start:number;length:number}[]>}}){
  const deployed=artifact.deployedBytecode;let actual=code.slice(2),expected=deployed.object.slice(2);
  if(!actual||actual.length!==expected.length)throw new Error('抢卖合约字节码与审核版本不符');
  for(const reference of Object.values(deployed.immutableReferences??{}).flat()){
    if(!Number.isSafeInteger(reference.start)||!Number.isSafeInteger(reference.length)||reference.start<0||reference.length<1||(reference.start+reference.length)*2>expected.length)throw new Error('审核合约不可变字段范围无效');
    const start=reference.start*2,length=reference.length*2,zero='0'.repeat(length);
    actual=actual.slice(0,start)+zero+actual.slice(start+length);expected=expected.slice(0,start)+zero+expected.slice(start+length);
  }
  if(actual.toLowerCase()!==expected.toLowerCase())throw new Error('抢卖合约字节码与审核版本不符');
}
export function openingBudget(p:OpeningPolicy,setupGas:bigint,maxExecutionCost:bigint){
  const total=BigInt(p.totalCostWei),gasPrice=BigInt(p.gasPriceWei),bid=BigInt(p.builderFeeWei);
  if(setupGas<0n||setupGas+maxExecutionCost>total||bid+OPENING_GAS_CEILING*gasPrice>maxExecutionCost)throw new Error('Gas、抢排序费与准备交易累计费用超过 BNB 总上限');
  return {gasPrice,bid,maxCost:bid+OPENING_GAS_CEILING*gasPrice};
}
function bounded<T>(operation:Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>;return Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('抢卖准备读取超时')),ms);})]).finally(()=>clearTimeout(timer));}
export class OpeningWorker {
  readonly records:OpeningStore;readonly holder=randomUUID();busy=false;
  private running=false;private stopping=false;private timer:ReturnType<typeof setInterval>|undefined;
  private senders=new Map<string,Promise<void>>();private checkedAt=0;private lastError='';private nextChecks=new Map<string,number>();
  constructor(public config:Runtime,public chain:Chain,public store:Store,public builder=new BuilderClient()){this.records=new OpeningStore(store);}
  ready(){return this.config.app.mode==='live'&&this.config.app.ready&&Boolean(this.config.key&&this.config.openingSeller);}
  status(){return {location:this.config.cloud?'cloud':'local',running:this.running,enabled:this.running&&this.ready(),healthy:this.running&&!this.lastError,lastCheckedAt:this.checkedAt||null,error:this.lastError||null};}
  start(){if(this.running)return;this.running=true;this.stopping=false;this.timer=setInterval(()=>{void this.tick();},250);this.wake();}
  wake(){void this.tick();}
  async stop(){this.stopping=true;this.running=false;if(this.timer)clearInterval(this.timer);while(this.busy)await new Promise(resolve=>setTimeout(resolve,25));await Promise.allSettled([...this.senders.values()]);this.store.release('executor',this.holder);}
  async rawTask(id:Hex,blockNumber?:bigint){if(!this.config.openingSeller)throw new Error('定时抢卖合约尚未部署或配置');return this.chain.client.readContract({address:this.config.openingSeller,abi:openingExecutorAbi,functionName:'getTask',args:[id],blockNumber});}
  async verifyContract(blockNumber:bigint){
    const seller=this.config.openingSeller;if(!seller)throw new Error('定时抢卖合约尚未部署或配置');
    const c=this.chain.client,code=await c.getCode({address:seller,blockNumber});
    if(!code)throw new Error('定时抢卖合约没有代码');
    const artifact=JSON.parse(readFileSync(resolve(ROOT,'packages/contracts/out/NBDAOOpeningSeller.sol/NBDAOOpeningSeller.json'),'utf8'));
    reviewedOpeningCode(code,artifact);
    const names=['token','usdt','pair','router','factory','BUILDER','deploymentChainId','EXECUTION_GAS_CEILING'] as const;
    const values=await Promise.all(names.map(functionName=>c.readContract({address:seller,abi:openingExecutorAbi,functionName,blockNumber})));
    const expected=[this.config.app.addresses.token,this.config.app.addresses.usdt,this.config.app.addresses.pair,this.config.app.addresses.router,this.config.app.addresses.factory,OPENING_BUILDER,BigInt(this.config.app.chainId),OPENING_GAS_CEILING];
    if(values.some((value,i)=>String(value).toLowerCase()!==String(expected[i]).toLowerCase()))throw new Error('抢卖合约资产、网络或构建者绑定不符');
  }
  async verifySetup(id:Hex,owner:Address,p:OpeningPolicy){
    const c=this.chain.client,seller=this.config.openingSeller!,head=await c.getBlock();let gas=0n,created=0;
    for(const hash of p.setupTxHashes){
      const [tx,receipt]=await Promise.all([c.getTransaction({hash}),c.getTransactionReceipt({hash})]);
      const canonical=await c.getBlock({blockNumber:receipt.blockNumber});
      if(canonical.hash!==receipt.blockHash||tx.from.toLowerCase()!==owner.toLowerCase()||(tx.value??0n)!==0n)throw new Error('准备回执来源不符或已重组');
      if(head.number===null||head.number<receipt.blockNumber+2n)throw new Error('准备交易需要至少 3 个区块确认后才能注册');
      if(tx.to?.toLowerCase()===seller.toLowerCase()){
        const call=decodeFunctionData({abi:openingExecutorAbi,data:tx.input});if(call.functionName!=='createTask')throw new Error('准备回执只能包含本次任务创建和代币授权');
        const events=parseEventLogs({abi:openingExecutorAbi,eventName:'TaskCreated',logs:receipt.logs}).filter(e=>e.address.toLowerCase()===seller.toLowerCase()&&e.args.taskId.toLowerCase()===id.toLowerCase()&&e.args.owner.toLowerCase()===owner.toLowerCase());
        if(receipt.status==='success'){if(events.length!==1)throw new Error('准备回执不属于本次抢卖任务');created++;}
      }else if(tx.to?.toLowerCase()===this.config.app.addresses.token.toLowerCase()){
        const call=decodeFunctionData({abi:tokenAbi,data:tx.input});if(call.functionName!=='approve'||call.args[0].toLowerCase()!==seller.toLowerCase())throw new Error('准备回执不是给本抢卖合约的代币授权');
      }else throw new Error('准备回执目标不符');
      gas+=receipt.gasUsed*receipt.effectiveGasPrice;
    }
    if(created!==1)throw new Error('必须包含本次任务唯一的创建回执');return gas;
  }
  async register(id:Hex,p:OpeningPolicy){
    if(!this.ready())throw new Error('定时抢卖执行配置尚未就绪');
    const old=this.records.task(id);if(old){this.records.register(id,old.owner,p,old.setupGasWei);this.wake();return old;}
    const c=this.chain.client,block=await c.getBlock();
    const task=await this.rawTask(id,block.number!);assertTaskAllowed(this.config,task);
    if(task.status!==1||task.params.notBefore%86400n!==0n||task.params.expiresAt-task.params.notBefore>12n||task.params.notBefore<=block.timestamp+30n||task.params.notBefore<=BigInt(Math.floor(Date.now()/1000)+30))throw new Error('任务必须为尚未开始的指定日期 08:00，至少提前 30 秒注册');
    if(task.owner.toLowerCase()!==this.config.app.executor?.toLowerCase())throw new Error('当前抢卖模式要求持币钱包和执行钱包相同');
    if(this.config.app.sellerAddress){
      const oldId=await c.readContract({address:this.config.app.sellerAddress,abi:executorAbi,functionName:'activeTaskId',args:[task.owner],blockNumber:block.number!});
      if(oldId!==ZERO_ID){const oldTask=await this.chain.rawTask(oldId,block.number!);if(oldTask.status>0&&oldTask.status<3&&oldTask.params.expiresAt>task.params.notBefore)throw new Error('旧监控卖出任务仍有效且覆盖本次 08:00；请先取消旧任务再注册抢卖。');}
    }
    await this.verifyContract(block.number!);const setupGas=await this.verifySetup(id,task.owner,p);openingBudget(p,setupGas,task.params.maxExecutionCostWei);
    if(BigInt(p.builderFeeWei)>task.params.maxBuilderFeeWei||BigInt(p.gasPriceWei)>task.params.maxGasPrice)throw new Error('服务条件超出链上费用上限');
    const registered=this.records.register(id,task.owner,p,setupGas.toString());this.wake();return registered;
  }
  async view(id:Hex){
    const [task,block]=await Promise.all([this.rawTask(id),this.chain.client.getBlock()]);assertTaskAllowed(this.config,task);
    const registered=this.records.task(id),attempt=this.records.publicAttempt(id);
    const residual=await this.chain.client.readContract({address:this.config.app.addresses.token,abi:tokenAbi,functionName:'balanceOf',args:[task.owner],blockNumber:block.number!});
    return {taskId:id,owner:task.owner,executor:task.params.executor,status:task.status===1&&block.timestamp>=task.params.expiresAt?4:task.status,notBefore:task.params.notBefore.toString(),expiresAt:task.params.expiresAt.toString(),maxTotalInput:task.params.maxTotalInput.toString(),minTotalUSDT:task.params.minTotalUSDT.toString(),maxBuilderFeeWei:task.params.maxBuilderFeeWei.toString(),maxExecutionCostWei:task.params.maxExecutionCostWei.toString(),maxGasPrice:task.params.maxGasPrice.toString(),serviceStatus:registered?.status??'MissingConfiguration',reason:registered?.reason??'尚未签署并注册执行服务',soldInput:task.soldInput.toString(),receivedUSDT:task.receivedUSDT.toString(),residual:residual.toString(),gasSpentWei:attempt?.gasWei??'0',builderFeeSpentWei:attempt?.builderFeeWei??'0',setupGasWei:registered?.setupGasWei??'0',policy:registered?.policy??null,attempts:attempt?1:0,txHash:attempt?.hash??null};
  }
  private async prepare(r:OpeningRegistered){
    if(!this.ready()||this.stopping||this.store.pending().length||this.store.hasOpeningPending())return;
    if(!this.store.acquire('executor',this.holder,180000))return;
    try{
      if(this.store.pending().length||this.store.hasOpeningPending()||this.records.attempt(r.id))return;
      const c=this.chain.client,account=privateKeyToAccount(this.config.key!),seller=this.config.openingSeller!,block=await c.getBlock(),task=await this.rawTask(r.id,block.number!);
      assertTaskAllowed(this.config,task);assertOwnerAllowed(this.config,r.owner);
      if(task.owner.toLowerCase()!==r.owner.toLowerCase()||task.params.executor.toLowerCase()!==account.address.toLowerCase())throw new Error('抢卖任务与执行密钥不符');
      if(task.status!==1){this.records.state(r.id,'Closed','链上任务已结束。');return;}
      if(block.timestamp>=task.params.expiresAt||Date.now()>=Number(task.params.expiresAt)*1000){this.records.state(r.id,'WindowExpired','本次 08:00 抢卖已过期，不会转为每日重试。');return;}
      const [,health]=await Promise.all([this.verifyContract(block.number!),this.chain.health(),this.chain.fingerprint(block.number!)]);
      if(health.healthy<2)throw new Error('抢卖至少需要两个健康且同步的 RPC');
      if(Math.abs(Date.now()/1000-Number(block.timestamp))>3)throw new Error('服务器时钟与链上时间偏差过大，停止定时签名');
      const [pending,latest,balance,tokenBalance,allowance,gasPrice]=await Promise.all([
        c.getTransactionCount({address:account.address,blockTag:'pending'}),c.getTransactionCount({address:account.address,blockTag:'latest'}),c.getBalance({address:account.address}),
        c.readContract({address:this.config.app.addresses.token,abi:tokenAbi,functionName:'balanceOf',args:[task.owner],blockNumber:block.number!}),
        c.readContract({address:this.config.app.addresses.token,abi:tokenAbi,functionName:'allowance',args:[task.owner,seller],blockNumber:block.number!}),c.getGasPrice(),
      ]);
      if(pending!==latest)throw new Error('执行钱包存在其他未确认交易，不能预签抢卖 nonce');
      const cost=openingBudget(r.policy,BigInt(r.setupGasWei),task.params.maxExecutionCostWei);
      if(cost.bid>task.params.maxBuilderFeeWei||cost.gasPrice>task.params.maxGasPrice||gasPrice>cost.gasPrice)throw new Error('固定签署的 Gas 或构建者费用条件无法满足');
      if(balance<cost.maxCost||tokenBalance<task.params.maxTotalInput||allowance<task.params.maxTotalInput)throw new Error('BNB、代币余额或有限授权不足');
      // A confirmed block before 08:00 must revert OutsideWindow. Do not use that
      // stale-time eth_call to reject the future opening opportunity. The exact
      // signed call is simulated privately by the builder for its candidate block;
      // all time, USDT floor and BNB ceilings remain enforced by the contract.
      const data=encodeFunctionData({abi:openingExecutorAbi,functionName:'executeOpening',args:[task.owner,r.id,task.params.minTotalUSDT,task.params.expiresAt]});
      if(this.stopping||Date.now()>=Number(task.params.expiresAt)*1000)return;
      const raw=await account.signTransaction({chainId:this.config.app.chainId,to:seller,data,gas:OPENING_GAS_LIMIT,gasPrice:cost.gasPrice,value:cost.bid,nonce:latest,type:'legacy'});
      const attempt:OpeningAttempt={taskId:r.id,hash:keccak256(raw),nonce:latest,raw,sentAt:Date.now(),state:'signed',submissions:0,gasWei:'0',builderFeeWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false};
      this.records.insert(attempt);this.store.audit(r.id,'OpeningSigned',{hash:attempt.hash,nonce:attempt.nonce,gasLimit:OPENING_GAS_LIMIT.toString(),gasPriceWei:r.policy.gasPriceWei,builderFeeWei:r.policy.builderFeeWei});
      this.records.state(r.id,'Prepared','已预签指定日期 08:00 的私有卖出交易；费用与最低到账条件冻结。');
      this.launch(r,attempt,task.params.notBefore,task.params.expiresAt,block.number!);
    }finally{this.store.release('executor',this.holder);}
  }
  private async validateAttempt(r:OpeningRegistered,a:OpeningAttempt){
    const block=await this.chain.client.getBlock();
    const tx=parseTransaction(a.raw),task=await this.rawTask(r.id,block.number!),sender=await recoverTransactionAddress({serializedTransaction:a.raw as TransactionSerializedLegacy});
    if(tx.type!=='legacy'||keccak256(a.raw)!==a.hash||tx.chainId!==this.config.app.chainId||tx.to?.toLowerCase()!==this.config.openingSeller?.toLowerCase()||tx.nonce!==a.nonce||tx.gas!==OPENING_GAS_LIMIT||tx.gasPrice!==BigInt(r.policy.gasPriceWei)||(tx.value??0n)!==BigInt(r.policy.builderFeeWei)||sender.toLowerCase()!==this.config.app.executor?.toLowerCase()||!tx.data)throw new Error('持久化抢卖交易与签署条件不匹配');
    const call=decodeFunctionData({abi:openingExecutorAbi,data:tx.data});
    if(call.functionName!=='executeOpening'||call.args[0].toLowerCase()!==r.owner.toLowerCase()||call.args[1].toLowerCase()!==r.id.toLowerCase()||call.args[2]!==task.params.minTotalUSDT||call.args[3]!==task.params.expiresAt)throw new Error('持久化抢卖调用不匹配');
    assertTaskAllowed(this.config,task);openingBudget(r.policy,BigInt(r.setupGasWei),task.params.maxExecutionCostWei);
    await Promise.all([this.verifyContract(block.number!),this.chain.fingerprint(block.number!)]);return task;
  }
  private launch(r:OpeningRegistered,a:OpeningAttempt,notBefore:bigint,expiresAt:bigint,head:bigint){
    if(this.senders.has(r.id)||!this.ready()||this.stopping)return;
    const work=this.submit(r,a,notBefore,expiresAt,head).catch(e=>{this.records.state(r.id,'Recovering',openingMessage(e));}).finally(()=>this.senders.delete(r.id));this.senders.set(r.id,work);
  }
  private async submit(r:OpeningRegistered,a:OpeningAttempt,notBefore:bigint,expiresAt:bigint,head:bigint){
    const start=Number(notBefore)*1000-1000,end=Number(expiresAt)*1000;
    while(!this.stopping&&Date.now()<start)await new Promise(resolve=>setTimeout(resolve,Math.min(100,start-Date.now())));
    if(this.stopping||!this.ready()||Date.now()>=end)return;
    // Recheck nonce and cancellation just before handing the private transaction to the builder.
    const [task,latest,pending,block]=await bounded(Promise.all([this.rawTask(r.id),this.chain.client.getTransactionCount({address:this.config.app.executor!,blockTag:'latest'}),this.chain.client.getTransactionCount({address:this.config.app.executor!,blockTag:'pending'}),this.chain.client.getBlock()]),1800);
    if(task.status!==1){this.records.update(r.id,{state:'closed',confirmed:true});this.records.state(r.id,'Closed','链上任务已结束，未提交新卖单。');return;}
    if(latest!==a.nonce||pending!==latest){this.records.update(r.id,{state:'unknown'});this.records.state(r.id,'Error','执行钱包 nonce 已改变或出现其他交易，暂停抢卖，需人工核对。');return;}
    let lastSubmittedAt=0;
    for(let submission=a.submissions;submission<MAX_SUBMISSIONS&&!this.stopping&&Date.now()<end;submission++){
      const slot=Math.max(Number(notBefore)*1000+SUBMISSION_OFFSETS_MS[submission]!,lastSubmittedAt+200);
      while(!this.stopping&&Date.now()<slot&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,Math.min(100,slot-Date.now())));
      const current=this.records.attempt(r.id);
      if(!current||this.stopping||Date.now()>=end||current.confirmed||current.state==='unknown')return;
      // Persist before I/O: a timeout or crash never authorizes a new signature or nonce.
      this.records.update(r.id,{state:'pending',submissions:submission+1});
      lastSubmittedAt=Date.now();
      try{const hash=await this.builder.send({raw:a.raw,maxBlockNumber:Number(block.number??head)+128,maxTimestamp:Number(expiresAt)-1});this.store.audit(r.id,'OpeningBundleAccepted',{bundleHash:hash,submission:submission+1});const current=this.records.attempt(r.id);if(current?.state==='pending'&&!current.confirmed)this.records.state(r.id,'PendingTx','私有交易包已投递；首区块和首位均为尽力争取，等待真实回执。');}
      catch{const current=this.records.attempt(r.id);if(current?.state==='pending'&&!current.confirmed&&this.records.task(r.id)?.status!=='PendingTx')this.records.state(r.id,'WaitingForConditions','构建者尚未接收该私有卖单，窗口内仅重投同一交易；不会公链广播。');}
      if(this.records.attempt(r.id)?.confirmed)return;
    }
  }
  private async reconcile(r:OpeningRegistered,a:OpeningAttempt,head:bigint,timestamp:bigint){
    const c=this.chain.client;
    try{
      const receipt=await c.getTransactionReceipt({hash:a.hash}),canonical=await c.getBlock({blockNumber:receipt.blockNumber});
      if(canonical.hash!==receipt.blockHash)throw new OpeningReceiptReorg('回执区块已重组');
      const confirmed=head>=receipt.blockNumber+BigInt(r.policy.confirmations-1),gas=receipt.gasUsed*receipt.effectiveGasPrice;
      // A canonical receipt proves Gas was paid, even if a later business-event
      // or contract read is unavailable. Transport errors cannot erase this cost.
      this.records.update(r.id,{state:'mined',gasWei:gas.toString(),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,confirmed:false});
      let output=0n,bid=0n;
      if(receipt.status==='success'){
        const task=await this.rawTask(r.id,receipt.blockNumber),events=parseEventLogs({abi:openingExecutorAbi,eventName:'OpeningExecuted',logs:receipt.logs}).filter(e=>e.address.toLowerCase()===this.config.openingSeller?.toLowerCase()&&e.args.taskId.toLowerCase()===r.id.toLowerCase());
        const event=events[0];
        if(events.length!==1||!event||event.args.owner.toLowerCase()!==r.owner.toLowerCase()||event.args.grossInput!==task.params.maxTotalInput||event.args.usdtReceived<task.params.minTotalUSDT||event.args.builderFeePaid!==BigInt(r.policy.builderFeeWei)){
          this.records.update(r.id,{state:'unknown',gasWei:gas.toString(),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,confirmed:false});this.records.state(r.id,'Recovering','已计入真实 Gas，但成交事件不匹配，暂停账户后续交易并继续核查。');return;
        }
        output=event.args.usdtReceived;bid=event.args.builderFeePaid;
      }
      this.records.update(r.id,{state:confirmed?(receipt.status==='success'?'success':'failed'):'mined',gasWei:gas.toString(),builderFeeWei:bid.toString(),output:output.toString(),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,confirmed});
      this.records.state(r.id,confirmed?'Closed':'Confirming',confirmed?(receipt.status==='success'?'本次指定日期抢卖已成交，USDT 已到持币钱包。':'本次交易回滚，Gas 已计入总费用，不再重试。'):'交易已入块，等待确认和对账。');
    }catch(e){
      if(e instanceof OpeningReceiptReorg){this.records.update(r.id,{state:'pending',gasWei:'0',builderFeeWei:'0',output:'0',blockNumber:null,blockHash:null,confirmed:false});this.records.state(r.id,'Recovering','已证明原回执不属于当前规范链，回退费用后继续跟踪原交易。');return;}
      if(a.blockNumber&&a.blockHash&&e instanceof TransactionReceiptNotFoundError){
        try{
          const savedBlock=await c.getBlock({blockNumber:BigInt(a.blockNumber)});
          if(savedBlock.hash&&savedBlock.hash!==a.blockHash){this.records.update(r.id,{state:'pending',gasWei:'0',builderFeeWei:'0',output:'0',blockNumber:null,blockHash:null,confirmed:false});this.records.state(r.id,'Recovering','原成交区块已被替换，回退费用并继续核查同一交易；不会重新签名。');return;}
        }catch{/* A read failure is not evidence of a reorganization. */}
      }
      if(a.blockNumber||!(e instanceof TransactionReceiptNotFoundError)){this.records.state(r.id,'Recovering','回执核查暂时失败，保留已记录 Gas 和构建者费用；尚无证据证明重组。');return;}
      const task=await this.rawTask(r.id);
      if(timestamp>=task.params.expiresAt+3n){
        const [latest,pending]=await Promise.all([c.getTransactionCount({address:this.config.app.executor!,blockTag:'latest'}),c.getTransactionCount({address:this.config.app.executor!,blockTag:'pending'})]);
        if(latest===a.nonce&&pending===latest){this.records.update(r.id,{state:'expired',confirmed:true});this.records.state(r.id,'WindowExpired','本次抢卖未成交，原交易已过期；不顺延至明天、不公开广播。');}
        else{this.records.update(r.id,{state:'unknown'});this.records.state(r.id,'Error','交易到期但执行 nonce 状态未知，保留原交易跟踪并暂停新卖单。');}
      }
    }
  }
  async tick(){
    if(this.busy||this.stopping)return;this.busy=true;
    try{
      if(!this.ready())return;
      const records=this.records.tasks();if(!records.length)return;
      const now=Date.now();
      for(const r of records){
        if(this.stopping)return;if(now<(this.nextChecks.get(r.id)??0))continue;this.nextChecks.set(r.id,now+1000);const attempt=this.records.attempt(r.id);
        if(attempt){
          if(['expired','closed'].includes(attempt.state)&&attempt.confirmed)continue;
          const block=await this.chain.client.getBlock();this.checkedAt=Date.now();
          if(attempt.confirmed&&attempt.blockNumber&&block.number!-BigInt(attempt.blockNumber)>=50n){this.nextChecks.set(r.id,Number.POSITIVE_INFINITY);continue;}
          await this.reconcile(r,attempt,block.number!,block.timestamp);
          const current=this.records.attempt(r.id)!;
          if(!current.confirmed&&['signed','pending'].includes(current.state)&&!this.senders.has(r.id)){
            const task=await this.validateAttempt(r,current);
            if(now<Number(task.params.expiresAt)*1000)this.launch(r,current,task.params.notBefore,task.params.expiresAt,block.number!);
          }
        }else if(!['Closed','WindowExpired','Error'].includes(r.status)){
          const task=await this.rawTask(r.id);this.checkedAt=Date.now();
          if(task.status!==1){this.records.state(r.id,'Closed','链上任务已结束。');continue;}
          if(now>=Number(task.params.expiresAt)*1000){this.records.state(r.id,'WindowExpired','指定日期窗口已过期，不会顺延至明天。');continue;}
          if(now>=Number(task.params.notBefore)*1000-30000)await this.prepare(r);
          else this.nextChecks.set(r.id,Math.min(now+30000,Number(task.params.notBefore)*1000-30000));
        }
      }
      this.lastError='';
    }catch(e){this.lastError=openingMessage(e);}finally{this.busy=false;}
  }
}
