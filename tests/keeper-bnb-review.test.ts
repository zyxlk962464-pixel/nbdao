import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionResult } from 'viem';
import { executorAbi, UNIT } from '../packages/shared/src/index.js';
import { Store,type Attempt } from '../apps/keeper/src/store.js';
import { Worker } from '../apps/keeper/src/worker.js';
import type { Runtime } from '../apps/keeper/src/config.js';
import type { Chain } from '../apps/keeper/src/chain.js';
import type { Optimizer } from '../apps/keeper/src/optimizer.js';
const taskId=`0x${'71'.repeat(32)}` as const,hash=`0x${'72'.repeat(32)}` as const;
// Public, disposable Anvil fixture key only; no user key is read or used.
const testKey='0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const testAddress=privateKeyToAccount(testKey).address;
const stores:Store[]=[],dirs:string[]=[];
function setup(){const dir=mkdtempSync(join(tmpdir(),'keeper-bnb-review-'));dirs.push(dir);const store=new Store(join(dir,'db.sqlite'));stores.push(store);store.register(taskId,testAddress,{slippageBps:100,maxAttempts:1,gasBudgetWei:'10',maxTxGasWei:'10',minEconomicUSDT:'0',confirmations:1,maxQuoteAgeBlocks:3});return store;}
function failedAttempt():Attempt{return {hash,taskId,nonce:0,raw:'0x01',input:'1',minOut:'1',index:0,sentAt:Date.now(),state:'failed',gasWei:'7',blockNumber:'99',blockHash:hash,output:'0',confirmed:true};}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('small BNB independent review: pure local mocks, no RPC or broadcast',()=>{
  it('preserves already-paid failed Gas when a receipt RPC temporarily times out',async()=>{
    const store=setup();store.insert(failedAttempt());const getTransactionReceipt=vi.fn().mockRejectedValue(new Error('temporary RPC timeout'));
    const chain={client:{getTransactionReceipt}} as unknown as Chain;
    const worker=new Worker({app:{executor:testAddress}} as Runtime,chain,{} as Optimizer,store);
    const reliable=await worker.reconcile(100n);
    expect(reliable).toBe(false);expect(store.task(taskId)?.status).toBe('Recovering');
    expect(store.spent(taskId),'A transport error is not proof of chain reorganization').toBe(7n);
  });
  it('preserves paid Gas when receipt is temporarily not visible',async()=>{
    const store=setup();store.insert(failedAttempt());const chain={client:{getTransactionReceipt:async()=>{throw new Error('TransactionReceiptNotFoundError');}}} as unknown as Chain;
    const worker=new Worker({app:{executor:testAddress}} as Runtime,chain,{} as Optimizer,store);
    expect(await worker.reconcile(100n)).toBe(false);expect(store.spent(taskId)).toBe(7n);expect(store.attempts(taskId)[0]?.state).toBe('failed');
  });
  it('rolls fees back only after a successful canonical block-hash check proves the receipt orphaned',async()=>{
    const store=setup();store.insert(failedAttempt());const otherHash=`0x${'73'.repeat(32)}` as const;
    const chain={client:{getTransactionReceipt:async()=>({blockNumber:99n,blockHash:hash,status:'reverted'}),getBlock:async()=>({hash:otherHash})}} as unknown as Chain;
    const worker=new Worker({app:{executor:testAddress}} as Runtime,chain,{} as Optimizer,store);
    expect(await worker.reconcile(100n)).toBe(false);expect(store.spent(taskId)).toBe(0n);expect(store.pending()).toHaveLength(1);
  });
  it('includes previously failed Gas in the next transaction budget before signing or persisting a new attempt',async()=>{
    const store=setup();store.insert(failedAttempt());const getTransactionCount=vi.fn(async()=>1),insert=vi.spyOn(store,'insert');
    const chain={rawTask:async()=>({owner:testAddress,params:{executor:testAddress,maxGasPrice:100n,expiresAt:300n}}),fingerprint:async()=>hash,health:async()=>({healthy:1}),bnbPrice:async()=>600n*UNIT,client:{getBlock:async()=>({number:100n,hash,timestamp:100n}),getGasPrice:async()=>2n,call:async()=>({data:encodeFunctionResult({abi:executorAbi,functionName:'executeChunk',result:[1000000n,0n]})}),estimateGas:async()=>2n,getTransactionCount,getBalance:async()=>10000n}} as unknown as Chain;
    const config={key:testKey,app:{mode:'local',ready:true,executor:testAddress,sellerAddress:'0x0000000000000000000000000000000000000022'}} as unknown as Runtime;
    const worker=new Worker(config,chain,{} as Optimizer,store);
    await worker.send(taskId,1n,1n,0,200n);
    expect(store.task(taskId)?.status).toBe('BudgetExhausted');expect(insert).not.toHaveBeenCalled();expect(store.attempts(taskId)).toHaveLength(1);
  });
  it('does not plan another paid transaction after receipt accounting becomes uncertain',async()=>{
    const store=setup();store.insert(failedAttempt());const rawTask=vi.fn();
    const chain={client:{getBlock:async()=>({number:100n}),getTransactionReceipt:async()=>{throw new Error('RPC timeout');}},rawTask} as unknown as Chain;
    const worker=new Worker({app:{mode:'local',ready:true,executor:testAddress},quoteTimeoutMs:90000} as Runtime,chain,{} as Optimizer,store);
    await worker.tick();expect(rawTask).not.toHaveBeenCalled();expect(store.spent(taskId)).toBe(7n);expect(store.attempts(taskId)).toHaveLength(1);
  });
  it('blocks subsequent chunks while any signed or pending transaction remains unresolved',async()=>{
    const store=setup();store.insert({...failedAttempt(),state:'pending',gasWei:'0',blockNumber:null,blockHash:null,confirmed:false});
    const rawTask=vi.fn();const chain={client:{getBlock:async()=>({number:100n})},rawTask} as unknown as Chain;
    const config={app:{mode:'local',ready:true},quoteTimeoutMs:90000} as Runtime;
    const worker=new Worker(config,chain,{} as Optimizer,store);worker.reconcile=async()=>true;
    await worker.tick();expect(rawTask).not.toHaveBeenCalled();expect(store.attempts(taskId)).toHaveLength(1);
  });
});
