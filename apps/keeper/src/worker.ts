import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, parseEventLogs, parseTransaction, type Address,type Hex } from 'viem';
import { executorAbi, minimumOutput, slipMinimum, type PlanInput } from '../../../packages/shared/src/index.js';
import type { Runtime } from './config.js';
import { Chain, message, publicClient,sellFeeGateReason } from './chain.js';
import { Optimizer, netOutput } from './optimizer.js';
import { Store, type Attempt } from './store.js';
import { assertOwnerAllowed,assertTaskAllowed } from './access.js';
class CanonicalReceiptMismatch extends Error {}
export class Worker {
  busy=false;holder=randomUUID(); lastHead=0n;lastHeadHash:Hex|null|undefined;
  private running=false;private queued=false;private draining=false;private stopping=false;private unwatch:(()=>void)|undefined;
  constructor(public config:Runtime,public chain:Chain,public optimizer:Optimizer,public store:Store){}
  start(){
    if(this.running)return;this.running=true;this.stopping=false;
    this.unwatch=this.chain.client.watchBlockNumber({poll:true,pollingInterval:this.config.pollMs,emitOnBegin:true,emitMissed:false,
      onBlockNumber:()=>{this.queued=true;void this.drain();},
      onError:e=>{for(const t of this.store.tasks().filter(t=>!['Closed','PendingTx','Confirming'].includes(t.status)&&!(t.status==='Error'&&t.reason.includes('未知交易'))))this.store.state(t.id,'Error',`区块监听暂时失败：${message(e)}`);},
    });
  }
  private async drain(){if(this.draining)return;this.draining=true;try{while(this.running&&this.queued){this.queued=false;await this.tick();}}finally{this.draining=false;}}
  /** A newly registered task gets an initial check even if the head has not moved yet. */
  wake(){this.lastHead=0n;this.lastHeadHash=undefined;if(this.running){this.queued=true;void this.drain();}}
  async stop(){this.stopping=true;this.running=false;this.queued=false;this.unwatch?.();this.unwatch=undefined;while(this.busy)await new Promise(resolve=>setTimeout(resolve,50));this.store.release('worker',this.holder);}
  async broadcast(a:Attempt,freshTimestamp?:bigint){
    if(this.stopping)return;
    if(this.config.app.mode==='read-only'||!this.config.app.ready){this.store.state(a.taskId,'MissingConfiguration','只读模式或配置未就绪，不广播已签名交易。');return;}
    // Recovery may follow a crash before or after broadcast. Keep tracking the hash,
    // but never revive an expired call or broadcast a different stored transaction.
    const tx=parseTransaction(a.raw);
    if(keccak256(a.raw)!==a.hash||tx.chainId!==this.config.app.chainId||tx.to?.toLowerCase()!==this.config.app.sellerAddress?.toLowerCase()||tx.nonce!==a.nonce||(tx.value??0n)!==0n||!tx.data)throw new Error('持久化交易与执行配置不匹配，停止广播');
    const call=decodeFunctionData({abi:executorAbi,data:tx.data});
    if(call.functionName!=='executeChunk')throw new Error('只允许恢复卖出交易');
    const [owner,id,index,input,minOut,validUntil]=call.args;
    assertOwnerAllowed(this.config,owner);
    if(id.toLowerCase()!==a.taskId.toLowerCase()||index!==a.index||input!==BigInt(a.input)||minOut!==BigInt(a.minOut))throw new Error('持久化卖出参数不匹配，停止广播');
    let timestamp=freshTimestamp;
    if(timestamp===undefined){
      const [block,task,nonce]=await Promise.all([this.chain.client.getBlock(),this.chain.rawTask(a.taskId),this.chain.client.getTransactionCount({address:this.config.app.executor!,blockTag:'latest'})]);
      if(task.owner.toLowerCase()!==owner.toLowerCase())throw new Error('持久化卖出钱包不匹配，停止广播');
      if(nonce>a.nonce){this.store.update(a.hash,{state:'pending'});this.store.state(a.taskId,'Error','执行账户 nonce 已被未知交易消耗；停止自动发送，需人工核对。');return;}
      if(task.status<1||task.status>2||block.timestamp>=task.params.expiresAt){this.store.update(a.hash,{state:'pending'});this.store.state(a.taskId,'PendingTx','任务已结束，停止重播已签名交易；保留原交易回执跟踪，不提交新卖单。');return;}
      timestamp=block.timestamp;
    }
    if(timestamp>=validUntil){this.store.update(a.hash,{state:'pending'});this.store.state(a.taskId,'PendingTx','签名交易已过有效期，停止重播；保留原交易回执跟踪，不提交新卖单。');return;}
    const all=await Promise.allSettled(this.config.rpcUrls.map(url=>publicClient(url).sendRawTransaction({serializedTransaction:a.raw})));if(!all.some(r=>r.status==='fulfilled')){this.store.state(a.taskId,'Recovering','已持久化签名交易；广播状态未知，保持同一 nonce 并等待回执。');}this.store.update(a.hash,{state:'pending'});
  }
  async reconcile(head:bigint){let reliable=true;for(const a of this.store.attempts().filter(a=>!a.confirmed||a.blockNumber&&head-BigInt(a.blockNumber)<50n)){
    try{
      const r=await this.chain.client.getTransactionReceipt({hash:a.hash});const canonical=await this.chain.client.getBlock({blockNumber:r.blockNumber});if(canonical.hash!==r.blockHash)throw new CanonicalReceiptMismatch('Receipt is not canonical');const p=this.store.task(a.taskId)?.policy;const confirmed=head>=r.blockNumber+BigInt((p?.confirmations??3)-1);
      let output='0';if(r.status==='success'&&a.input!=='0'){
        const events=(()=>{try{return parseEventLogs({abi:executorAbi,eventName:'ChunkExecuted',logs:r.logs}).filter(e=>e.address.toLowerCase()===this.config.app.sellerAddress?.toLowerCase()&&e.args.taskId.toLowerCase()===a.taskId.toLowerCase());}catch{return [];}})();
        const e=events[0],owner=this.store.task(a.taskId)?.owner;
        if(events.length!==1||!e||e.args.owner.toLowerCase()!==owner?.toLowerCase()||e.args.grossInput!==BigInt(a.input)||e.args.chunkIndex!==a.index){
          // A verified canonical receipt proves Gas was paid even when its business
          // event cannot be reconciled. Do not erase that cost or rebroadcast it.
          this.store.update(a.hash,{state:'mined',gasWei:(r.gasUsed*r.effectiveGasPrice).toString(),blockNumber:r.blockNumber.toString(),blockHash:r.blockHash,output:'0',confirmed:false});
          this.store.state(a.taskId,'Recovering','规范回执已读取，但成交事件不匹配；Gas 已计入预算，暂停新交易并继续核查。');reliable=false;continue;
        }
        output=e.args.usdtReceived.toString();
      }
      this.store.update(a.hash,{state:confirmed?(r.status==='success'?'success':'failed'):'mined',gasWei:(r.gasUsed*r.effectiveGasPrice).toString(),blockNumber:r.blockNumber.toString(),blockHash:r.blockHash,output,confirmed});this.store.state(a.taskId,confirmed?'AwaitingQuote':'Confirming',confirmed&&r.status==='reverted'?'上一笔回滚，Gas 已计入预算；下一笔前重新模拟。':'');
    }catch(e){
      if(a.blockNumber && e instanceof CanonicalReceiptMismatch){reliable=false;this.store.update(a.hash,{state:'pending',gasWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false});this.store.state(a.taskId,'Recovering','检测到回执失效或重组；回退已计费用并等待同一交易重新确认。');this.store.audit(a.taskId,'Reorg',{hash:a.hash});}
      else if(a.blockNumber){reliable=false;this.store.state(a.taskId,'Recovering','回执核查暂时失败，保留已记录 Gas 费用并暂停新交易；尚无证据证明重组。');}
      else if(a.state==='signed')await this.broadcast(a);
      else if(['signed','pending'].includes(a.state)){const nonce=await this.chain.client.getTransactionCount({address:this.config.app.executor!,blockTag:'latest'}).catch(()=>a.nonce);if(nonce>a.nonce){this.store.state(a.taskId,'Error','执行账户 nonce 已被未知交易消耗；停止自动发送，需人工核对。');}else this.store.state(a.taskId,'PendingTx',Date.now()-a.sentAt>600000?'交易长时间未确认；保持原 nonce 等待，不自动提价或新增卖单。':'等待链上回执');}
    }
  }return reliable;}
  async checkTax(id:Hex,max:number|undefined,owner:Address,blockNumber:bigint){
    if(max===undefined)return true;
    try{const reason=sellFeeGateReason(max,await this.chain.predictSellFee(blockNumber,owner));if(reason){this.store.state(id,'WaitingForTax',reason);return false;}return true;}
    catch(e){this.store.state(id,'WaitingForTax',`基础卖出税率无法判断，暂停执行：${message(e)}`);return false;}
  }
  async send(id:Hex,input:bigint,minOut:bigint,index:number,validUntil:bigint){
    if(this.stopping)return;
    if(this.config.app.mode==='read-only'||!this.config.app.ready){this.store.state(id,'MissingConfiguration','只读模式或配置未就绪，不发送交易。');return;}
    if(!this.config.key||!this.config.app.sellerAddress)throw new Error('执行密钥/合约未配置');
    const r=this.store.task(id)!;const task=await this.chain.rawTask(id);assertTaskAllowed(this.config,task);const owner=task.owner;const account=privateKeyToAccount(this.config.key);if(task.params.executor.toLowerCase()!==account.address.toLowerCase())throw new Error('任务执行者与服务密钥不一致');const c=this.chain.client;const seller=this.config.app.sellerAddress;
    const data=encodeFunctionData({abi:executorAbi,functionName:'executeChunk',args:[owner,id,index,input,minOut,validUntil]});
    const preflight=await c.getBlock();const [,health,gasPrice]=await Promise.all([this.chain.fingerprint(preflight.number!),this.chain.health(),c.getGasPrice()]);if(this.config.app.mode==='live'&&health.healthy<2)throw new Error('实盘至少需要两个健康且同步的 RPC');if(gasPrice>task.params.maxGasPrice)throw new Error('Gas 价格超过任务上限');
    const block=await c.getBlock();if(block.timestamp>=task.params.expiresAt){this.store.state(id,'WindowExpired','监控窗口已到期；停止卖出，不额外发送结束交易。');return;}
    if(block.timestamp>=validUntil){this.store.state(id,'WaitingForConditions','候选有效期已结束，等待重新检查。');return;}
    // Revalidate the exact proposed input and minOut at one fresh block. No stale output is relabeled.
    const [taxCheck,callCheck,gasCheck,priceCheck,nonceCheck,latestCheck,balanceCheck]=await Promise.allSettled([
      this.checkTax(id,r.policy.maxSellFeePercent,owner,block.number!),
      c.call({account:account.address,to:seller,data,gasPrice,blockNumber:block.number!}),
      c.estimateGas({account:account.address,to:seller,data,gasPrice,blockNumber:block.number!}),
      this.chain.bnbPrice(block.number!),
      c.getTransactionCount({address:account.address,blockTag:'pending'}),
      c.getTransactionCount({address:account.address,blockTag:'latest'}),
      c.getBalance({address:account.address,blockNumber:block.number!}),
    ]);
    if(taxCheck.status==='rejected')throw taxCheck.reason;if(!taxCheck.value)return;
    if(callCheck.status==='rejected'||gasCheck.status==='rejected'){this.store.state(id,'WaitingForConditions',`发送前卖出检查未通过：${message(callCheck.status==='rejected'?callCheck.reason:gasCheck.status==='rejected'?gasCheck.reason:'')}`);return;}
    if(priceCheck.status==='rejected')throw priceCheck.reason;if(nonceCheck.status==='rejected')throw nonceCheck.reason;if(latestCheck.status==='rejected')throw latestCheck.reason;if(balanceCheck.status==='rejected')throw balanceCheck.reason;
    if(!callCheck.value.data)throw new Error('发送前模拟缺少返回值');
    const [output]=decodeFunctionResult({abi:executorAbi,functionName:'executeChunk',data:callCheck.value.data});
    const gas=(gasCheck.value*120n+99n)/100n,maxCost=gas*gasPrice,spent=this.store.spent(id);
    if(maxCost>BigInt(r.policy.maxTxGasWei)||spent+maxCost>BigInt(r.policy.gasBudgetWei)){this.store.state(id,'BudgetExhausted','剩余 Gas 预算不足，最低到账保持不变。');return;}
    const net=netOutput(output,maxCost,priceCheck.value);if(output<minOut||net<=0n||net<BigInt(r.policy.minEconomicUSDT)){this.store.state(id,'WaitingForConditions','发送前实际模拟到账或扣除 Gas 后净额低于阈值。');return;}
    const nonce=nonceCheck.value;if(nonce!==latestCheck.value){this.store.state(id,'PendingTx','执行账户已有其他未确认交易，等待后再执行。');return;}
    if(balanceCheck.value<maxCost){this.store.state(id,'BudgetExhausted','执行账户 BNB 不足。');return;}
    const signingBlock=await c.getBlock();if(signingBlock.timestamp>=task.params.expiresAt){this.store.state(id,'WindowExpired','监控窗口已到期；停止卖出，不额外发送结束交易。');return;}
    if(signingBlock.timestamp>=validUntil||signingBlock.number===null||signingBlock.number<block.number!||signingBlock.number-block.number!>BigInt(r.policy.maxQuoteAgeBlocks)){this.store.state(id,'WaitingForConditions','发送前模拟或交易有效期已过期，等待重新模拟。');return;}
    const canonical=await c.getBlock({blockNumber:block.number!});if(canonical.hash!==block.hash){this.store.state(id,'Recovering','发送前模拟区块已重组，等待重新核查。');return;}
    if(this.stopping)return;
    const raw=await account.signTransaction({chainId:this.config.app.chainId,to:seller,data,gas,gasPrice,nonce,type:'legacy'});const hash=keccak256(raw);
    const a:Attempt={hash,taskId:id,nonce,raw,input:input.toString(),minOut:minOut.toString(),index,sentAt:Date.now(),state:'signed',gasWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false};this.store.insert(a);this.store.audit(id,'Signed',{hash,nonce,index,input:a.input,minOut:a.minOut});await this.broadcast(a,signingBlock.timestamp);this.store.state(id,'PendingTx','交易已提交，等待确认后再规划下一批。');
  }
  async tick(){if(this.busy||this.stopping)return;this.busy=true;try{
    if(this.config.app.mode==='read-only'){for(const t of this.store.tasks())this.store.state(t.id,'MissingConfiguration','只读模式不发送交易。');return;}
    if(!this.store.acquire('worker',this.holder,Math.max(180000,this.config.quoteTimeoutMs*2)))return;
    if(!this.config.app.ready){for(const t of this.store.tasks())this.store.state(t.id,'MissingConfiguration',this.config.app.missing.join('、'));return;}
    const b=await this.chain.client.getBlock();if(b.number===null||b.hash===null)throw new Error('监听区块尚未确认');
    if(b.number===this.lastHead&&b.hash===this.lastHeadHash)return;
    this.lastHead=b.number;this.lastHeadHash=b.hash;
    const reliable=await this.reconcile(b.number);if(!reliable||this.store.pending().length)return;
    for(const registered of this.store.tasks()){
      if(this.stopping)return;
      const id=registered.id,t=await this.chain.rawTask(id);if(t.status>2){this.store.state(id,'Closed','链上任务已结束。');continue;}if(t.status===0)continue;
      try{assertOwnerAllowed(this.config,registered.owner);assertTaskAllowed(this.config,t);}catch(e){this.store.state(id,'MissingConfiguration',message(e));continue;}
      if(b.timestamp>=t.params.expiresAt){this.store.state(id,'WindowExpired','监控窗口已到期；停止卖出，不额外发送结束交易。');continue;}
      if(t.params.executor.toLowerCase()!==this.config.app.executor!.toLowerCase()){this.store.state(id,'MissingConfiguration','此任务绑定了其他执行者。');continue;}
      if(registered.status==='Error'&&registered.reason.includes('未知交易'))continue;
      if(this.store.attempts(id).length>=registered.policy.maxAttempts){this.store.state(id,'AttemptsExhausted','尝试次数上限已达到，保留剩余代币。');continue;}
      if(this.store.spent(id)>=BigInt(registered.policy.gasBudgetWei)){this.store.state(id,'BudgetExhausted','累计 Gas 预算已用尽，包含失败交易。');continue;}
      if(b.timestamp<t.params.notBefore){this.store.state(id,'WaitingForStart','等待指定开始时间。');continue;}
      if(!await this.checkTax(id,registered.policy.maxSellFeePercent,t.owner,b.number!))continue;
      const snapshot=await this.chain.wallet(t.owner);
      if(BigInt(snapshot.tokenBalance)<=t.params.maxDustTokens){this.store.state(id,'StoppedWithDust','余额已达到余币阈值；停止卖出，不额外发送结束交易。');continue;}
      if(BigInt(snapshot.allowance)===0n||t.params.maxTotalInput<=t.soldInput){this.store.state(id,'NeedsApproval','授权/累计输入额度不足，剩余币不会被自动扩大授权。');continue;}
      this.store.state(id,'AwaitingQuote','根据最新状态比较有限分批方案。');const p:PlanInput={owner:t.owner,executor:t.params.executor,notBefore:Number(t.params.notBefore),expiresAt:Number(t.params.expiresAt),maxChunks:t.params.maxChunks,maxTotalInput:t.params.maxTotalInput.toString(),minUSDTPerToken:t.params.minUSDTPerToken.toString(),maxDustTokens:t.params.maxDustTokens.toString(),maxGasPrice:t.params.maxGasPrice.toString(),policy:{...registered.policy,gasBudgetWei:(BigInt(registered.policy.gasBudgetWei)-this.store.spent(id)).toString()}};const quote=await this.optimizer.quote(p,id);this.store.saveQuote(quote.id,id,quote);const next=quote.best?.chunks[0];if(!next){this.store.state(id,quote.reason.startsWith('税率门禁：')?'WaitingForTax':quote.reason.includes('依赖变化')||quote.reason.includes('实现已变化')?'DependencyChanged':'WaitingForConditions',quote.reason);continue;}
      const now=await this.chain.client.getBlock();if(now.timestamp>=t.params.expiresAt){this.store.state(id,'WindowExpired','监控窗口已到期；停止卖出，不额外发送结束交易。');continue;}const canonical=await this.chain.client.getBlock({blockNumber:BigInt(quote.blockNumber)});if(canonical.hash!==quote.blockHash){this.store.state(id,'Recovering','报价所依据的区块已重组，丢弃候选重新模拟。');continue;}if(quote.futureScenario){this.store.state(id,'WaitingForConditions','未来场景仅供预览，执行需要当前时间重新模拟。');continue;}
      // A candidate is a proposal; send() obtains a fresh full call, tax, gas and economic check.
      // The signed block-age ceiling still applies to that new execution proof before signing.
      const input=BigInt(next.input);const minOut=slipMinimum(BigInt(next.output),registered.policy.slippageBps,minimumOutput(input,t.params.minUSDTPerToken));const until=now.timestamp+120n<t.params.expiresAt?now.timestamp+120n:t.params.expiresAt;await this.send(id,input,minOut,t.nextChunkIndex,until);break;
    }
  }catch(e){for(const t of this.store.tasks().filter(t=>!['Closed','PendingTx','Confirming'].includes(t.status)))this.store.state(t.id,'Error',message(e));}finally{this.busy=false;}}
}
