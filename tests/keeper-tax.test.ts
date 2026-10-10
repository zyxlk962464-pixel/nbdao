import { describe,it,expect,vi } from 'vitest';
import { encodeFunctionResult, parseTransaction } from 'viem';
import { Chain,predictPostSyncSellFee,sellFeeGateReason,type SellFeeState } from '../apps/keeper/src/chain.ts';
import type { Runtime } from '../apps/keeper/src/config.ts';
import type { Store } from '../apps/keeper/src/store.ts';
import type { Optimizer } from '../apps/keeper/src/optimizer.ts';
import { BSC,UNIT,executorAbi,type Policy,type SellTaxSnapshot } from '../packages/shared/src/index.ts';

// Worker imports config.ts through Optimizer; prevent its optional environment-file loader.
const savedLoader=process.loadEnvFile;process.loadEnvFile=()=>{throw new Error('No environment files in pure mock tests');};
const {Worker}=await import('../apps/keeper/src/worker.ts');process.loadEnvFile=savedLoader;
const id=`0x${'51'.repeat(32)}` as const,hash=`0x${'52'.repeat(32)}` as const;
const owner='0x0000000000000000000000000000000000000011' as const;
const publicTestKey='0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const publicExecutor='0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const policy:Policy={slippageBps:100,maxAttempts:20,gasBudgetWei:'10000',maxTxGasWei:'1000',minEconomicUSDT:'0',confirmations:1,maxQuoteAgeBlocks:3,maxSellFeePercent:5};
const state:SellFeeState={timestamp:3n*86400n,reserveUSDT:100n*UNIT,reserveToken:1000n*UNIT,poolTimestamp:3n*86400n,lastDayReserves:[100n*UNIT,1000n*UNIT,3n,100n*UNIT],lastMiningDay:3n,totalPower:1n,actualUSDTBalance:60n*UNIT};
function snapshot(fee:string|null,reason=''):SellTaxSnapshot{return {sellFeeAfterSync:fee,reason,blockNumber:'100',blockHash:hash,timestamp:'100'};}
function fixture(max:number|undefined=5){
  const row={id,owner,policy:{...policy,maxSellFeePercent:max} as Policy,status:'AwaitingQuote',reason:'',created:1};
  const store={tasks:()=>[row],task:()=>row,attempts:()=>[],pending:()=>[],spent:()=>0n,acquire:()=>true,state:vi.fn((_:string,status:string,reason:string)=>{row.status=status;row.reason=reason;}),saveQuote:vi.fn()} as unknown as Store;
  const task={owner,status:1,nextChunkIndex:0,soldInput:0n,receivedUSDT:0n,params:{executor:owner,notBefore:90n,expiresAt:200n,maxChunks:10,maxTotalInput:100n,minUSDTPerToken:1n,maxDustTokens:0n,maxGasPrice:100n}};
  const getBlock=vi.fn(async(_?:{blockNumber?:bigint})=>({number:100n,hash,timestamp:100n}));
  const predictSellFee=vi.fn(async()=>snapshot('80'));
  const wallet=vi.fn(async()=>({tokenBalance:'100',allowance:'100'}));
  const chain={client:{getBlock},rawTask:vi.fn(async()=>task),predictSellFee,wallet} as unknown as Chain;
  const quote=vi.fn(async()=>({id:'q',blockNumber:'100',blockHash:hash,futureScenario:false,best:{chunks:[{input:'10',output:'100'}]}}));
  const config={app:{mode:'local',ready:true,executor:owner},quoteTimeoutMs:90000} as unknown as Runtime;
  const worker=new Worker(config,chain,{quote} as unknown as Optimizer,store);
  const send=vi.spyOn(worker,'send').mockResolvedValue(undefined);
  return {row,store,chain,task,getBlock,predictSellFee,wallet,quote,worker,send};
}

describe('post-sync NBDAO basic fee: exact pure source order',()=>{
  it.each([[95,100],[96,80],[97,40],[98,20],[99,10],[100,5],[110,5]])('reserve ratio %s%% gives %s%% fee', (ratio,fee)=>{
    expect(predictPostSyncSellFee({...state,reserveUSDT:BigInt(ratio)*UNIT}).feePercent).toBe(fee);
  });
  it('rolls the old snapshot before mining, never again after pair.sync',()=>{
    const r=predictPostSyncSellFee({...state,reserveUSDT:110n*UNIT,poolTimestamp:3n*86400n,lastDayReserves:[0n,0n,2n,0n],lastMiningDay:2n,actualUSDTBalance:104n*UNIT});
    expect(r.rolled).toBe(true);expect(r.mined).toBe(true);expect(r.baselineUSDT).toBe(110n*UNIT);expect(r.feePercent).toBe(100);
  });
  it.each([{lastMiningDay:0n},{totalPower:0n},{lastMiningDay:3n}])('uses stored reserves when mining is skipped: %o',override=>{
    const r=predictPostSyncSellFee({...state,...override,reserveUSDT:96n*UNIT});expect(r.mined).toBe(false);expect(r.currentUSDT).toBe(96n*UNIT);expect(r.feePercent).toBe(80);
  });
  it('only the mining-sync branch uses actual USDT pair balance',()=>{
    expect(predictPostSyncSellFee({...state,lastMiningDay:2n,actualUSDTBalance:99n*UNIT}).feePercent).toBe(10);
  });
  it('keeps the genuine 3% zero-baseline special case and rejects invalid price/mining denominators',()=>{
    expect(predictPostSyncSellFee({...state,reserveUSDT:0n,lastDayReserves:[0n,0n,0n,0n]}).feePercent).toBe(3);
    expect(()=>predictPostSyncSellFee({...state,lastDayReserves:[UNIT,0n,3n,UNIT]})).toThrow('基线');
    expect(()=>predictPostSyncSellFee({...state,reserveToken:0n,lastMiningDay:2n})).toThrow('储备为零');
    expect(()=>predictPostSyncSellFee({...state,totalPower:undefined} as unknown as SellFeeState)).toThrow('字段缺失');
  });
  it('a legacy ceiling is absent, while missing or malformed new tax predictions fail closed',()=>{
    expect(sellFeeGateReason(undefined,snapshot(null))).toBeNull();expect(sellFeeGateReason(5,snapshot(null,'RPC failed'))).toContain('无法判断');
    expect(sellFeeGateReason(5,snapshot(''))).toContain('无效');expect(sellFeeGateReason(5,snapshot('80'))).toContain('高于');expect(sellFeeGateReason(5,snapshot('5'))).toBeNull();
  });
});

describe('service monitor gates: mocks only, no RPC, user key, signing or broadcast',()=>{
  it('does not quote or send above the ceiling, and resumes the next chunk when tax recovers',async()=>{
    const f=fixture();await f.worker.tick();expect(f.row.status).toBe('WaitingForTax');expect(f.quote).not.toHaveBeenCalled();expect(f.wallet).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
    f.getBlock.mockResolvedValue({number:101n,hash,timestamp:101n});f.predictSellFee.mockResolvedValue(snapshot('5'));await f.worker.tick();expect(f.quote).toHaveBeenCalledOnce();expect(f.send).toHaveBeenCalledOnce();
  });
  it.each([false,true])('an unknown prediction or RPC error never quotes/sends (%s)',async rejects=>{
    const f=fixture();if(rejects)f.predictSellFee.mockRejectedValue(new Error('RPC unavailable'));else f.predictSellFee.mockResolvedValue(snapshot(null,'missing data'));
    await f.worker.tick();expect(f.row.status).toBe('WaitingForTax');expect(f.quote).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
  });
  it('at the deadline stops locally without finalize, tax queries, or any Gas attempt',async()=>{
    const f=fixture();f.getBlock.mockResolvedValue({number:100n,hash,timestamp:200n});await f.worker.tick();
    expect(f.row.status).toBe('WindowExpired');expect(f.quote).not.toHaveBeenCalled();expect(f.predictSellFee).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.store.spent(id)).toBe(0n);
  });
  it('legacy tasks do not add a new tax gate',async()=>{
    const f=fixture(undefined);f.row.policy.maxSellFeePercent=undefined;await f.worker.tick();expect(f.predictSellFee).not.toHaveBeenCalled();expect(f.quote).toHaveBeenCalledOnce();expect(f.send).toHaveBeenCalledOnce();
  });
  it('deduplicates the same block but rechecks a replacement hash and the next block',async()=>{
    const f=fixture();await f.worker.tick();await f.worker.tick();expect(f.predictSellFee).toHaveBeenCalledOnce();
    f.getBlock.mockResolvedValue({number:100n,hash:`0x${'53'.repeat(32)}`,timestamp:100n});await f.worker.tick();expect(f.predictSellFee).toHaveBeenCalledTimes(2);
    f.getBlock.mockResolvedValue({number:101n,hash,timestamp:101n});await f.worker.tick();expect(f.predictSellFee).toHaveBeenCalledTimes(3);expect(f.send).not.toHaveBeenCalled();
  });
  it('serializes block callbacks and coalesces intermediate heads while a check is running',async()=>{
    const f=fixture();let emit:()=>void=()=>{},fail:(e:Error)=>void=()=>{};const unwatch=vi.fn();
    const watchBlockNumber=vi.fn(options=>{emit=options.onBlockNumber;fail=options.onError;return unwatch;});Object.assign(f.chain.client,{watchBlockNumber});Object.assign(f.store,{release:vi.fn()});
    let finish:()=>void=()=>{};const first=new Promise<void>(resolve=>{finish=resolve;});const tick=vi.spyOn(f.worker,'tick').mockReturnValueOnce(first).mockResolvedValue(undefined);
    f.worker.start();f.worker.start();expect(watchBlockNumber).toHaveBeenCalledOnce();expect(watchBlockNumber).toHaveBeenCalledWith(expect.objectContaining({emitOnBegin:true,emitMissed:false,poll:true}));
    emit();emit();emit();expect(tick).toHaveBeenCalledOnce();finish();await vi.waitFor(()=>expect(tick).toHaveBeenCalledTimes(2));
    f.row.status='Error';f.row.reason='执行账户 nonce 已被未知交易消耗';fail(new Error('RPC failed'));expect(f.row.reason).toContain('未知交易');
    f.worker.stop();emit();await Promise.resolve();expect(unwatch).toHaveBeenCalledOnce();expect(tick).toHaveBeenCalledTimes(2);
  });
  it('checks newly registered work immediately without waiting for another block',async()=>{
    const f=fixture();let emit:()=>void=()=>{};Object.assign(f.chain.client,{watchBlockNumber:(options:{onBlockNumber:()=>void})=>{emit=options.onBlockNumber;return ()=>{};}});Object.assign(f.store,{release:vi.fn()});
    f.worker.start();emit();await vi.waitFor(()=>expect(f.predictSellFee).toHaveBeenCalledOnce());
    f.worker.wake();await vi.waitFor(()=>expect(f.predictSellFee).toHaveBeenCalledTimes(2));f.worker.stop();expect(f.send).not.toHaveBeenCalled();
  });
  it('rechecks tax at the final eth_call block and never reaches nonce/signing when the tax rises',async()=>{
    const f=fixture();f.send.mockRestore();f.task.params.executor=publicExecutor as unknown as typeof owner;
    const call=vi.fn().mockRejectedValue(new Error('InvalidPoolInput')),estimateGas=vi.fn(),getTransactionCount=vi.fn();
    Object.assign(f.chain,{fingerprint:vi.fn(async()=>hash),health:vi.fn(async()=>({healthy:2})),bnbPrice:async()=>600n*UNIT});Object.assign(f.chain.client,{getGasPrice:async()=>1n,call,estimateGas,getTransactionCount,getBalance:async()=>10000n});
    Object.assign(f.worker.config,{key:publicTestKey,app:{mode:'local',ready:true,sellerAddress:owner,executor:publicExecutor}});
    const broadcast=vi.spyOn(f.worker,'broadcast').mockResolvedValue(undefined);
    await f.worker.send(id,10n,1n,0,190n);expect(f.row.status).toBe('WaitingForTax');expect(call).toHaveBeenCalledWith(expect.objectContaining({blockNumber:100n}));expect(f.predictSellFee).toHaveBeenCalledWith(100n,owner);expect(broadcast).not.toHaveBeenCalled();
  });
  it('shows effective expiry separately from the stored on-chain Armed status',async()=>{
    const f=fixture();f.getBlock.mockResolvedValue({number:100n,hash,timestamp:200n});
    const chain=new Chain({rpcUrls:['http://127.0.0.1:1'],app:{addresses:BSC}} as unknown as Runtime);chain.client={getBlock:f.getBlock,readContract:async()=>100n} as unknown as Chain['client'];chain.rawTask=async()=>f.task as unknown as Awaited<ReturnType<Chain['rawTask']>>;
    const view=await chain.view(id,f.store);expect(view.status).toBe(6);expect(view.chainStatus).toBe(1);expect(view.windowExpired).toBe(true);expect(view.serviceStatus).toBe('WindowExpired');
  });
});

describe('fresh send checks: public local test key and mocked broadcast only',()=>{
  function sender(){
    const f=fixture();f.send.mockRestore();f.task.params.executor=publicExecutor as unknown as typeof owner;
    f.predictSellFee.mockResolvedValue(snapshot('5'));
    const insert=vi.fn(),broadcast=vi.spyOn(f.worker,'broadcast').mockResolvedValue(undefined);
    Object.assign(f.store,{insert,audit:vi.fn()});
    Object.assign(f.chain,{fingerprint:async()=>hash,health:async()=>({healthy:2}),bnbPrice:async()=>600n*UNIT});
    const call=vi.fn(async()=>({data:encodeFunctionResult({abi:executorAbi,functionName:'executeChunk',result:[1000000n,90n]})}));
    const estimateGas=vi.fn(async()=>100n);
    Object.assign(f.chain.client,{getGasPrice:async()=>1n,call,estimateGas,getTransactionCount:async()=>0,getBalance:async()=>10000n});
    Object.assign(f.worker.config,{key:publicTestKey,rpcUrls:['http://127.0.0.1:1'],app:{mode:'local',ready:true,chainId:31337,sellerAddress:owner,executor:publicExecutor}});
    return {...f,insert,broadcast,call,estimateGas};
  }
  it('direct send cannot bypass read-only mode',async()=>{
    const f=sender();f.worker.config.app.mode='read-only';await f.worker.send(id,10n,1n,0,190n);
    expect(f.chain.rawTask).not.toHaveBeenCalled();expect(f.call).not.toHaveBeenCalled();expect(f.insert).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('checks output, gas and tax at the same fresh block and signs exactly one local-only transaction',async()=>{
    const f=sender();await f.worker.send(id,10n,1n,0,190n);
    expect(f.call).toHaveBeenCalledWith(expect.objectContaining({blockNumber:100n}));expect(f.estimateGas).toHaveBeenCalledWith(expect.objectContaining({blockNumber:100n}));
    expect(f.insert).toHaveBeenCalledOnce();expect(f.broadcast).toHaveBeenCalledOnce();expect(f.row.status).toBe('PendingTx');
    const transaction=parseTransaction(f.insert.mock.calls[0]![0].raw);expect(transaction.chainId).toBe(31337);expect(transaction.gas).toBe(120n);expect(transaction.gasPrice).toBe(1n);
  });
  it('uses newly simulated net proceeds rather than the original candidate output',async()=>{
    const f=sender();f.call.mockResolvedValue({data:encodeFunctionResult({abi:executorAbi,functionName:'executeChunk',result:[70000n,90n]})});
    await f.worker.send(id,10n,1n,0,190n);expect(f.row.status).toBe('WaitingForConditions');expect(f.insert).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('refuses to sign if the fresh proof exceeds the unchanged signed three-block ceiling',async()=>{
    const f=sender();let heads=0;f.getBlock.mockImplementation(async(request)=>({number:request?.blockNumber??(++heads===3?104n:100n),hash,timestamp:100n}));
    await f.worker.send(id,10n,1n,0,190n);expect(f.row.status).toBe('WaitingForConditions');expect(f.insert).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('does not sign when the latest head retreats behind the simulation block',async()=>{
    const f=sender();let heads=0;f.getBlock.mockImplementation(async(request)=>({number:request?.blockNumber??(++heads===3?99n:100n),hash,timestamp:100n}));
    await f.worker.send(id,10n,1n,0,190n);expect(f.insert).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();expect(f.row.status).toBe('WaitingForConditions');
  });
  it('stops without signing when the deadline is reached during the final checks',async()=>{
    const f=sender();let heads=0;f.getBlock.mockImplementation(async()=>({number:100n,hash,timestamp:++heads===3?200n:100n}));
    await f.worker.send(id,10n,1n,0,190n);expect(f.row.status).toBe('WindowExpired');expect(f.insert).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('keeps budget limits in the final path',async()=>{
    const f=sender();f.row.policy.maxTxGasWei='119';await f.worker.send(id,10n,1n,0,190n);expect(f.row.status).toBe('BudgetExhausted');expect(f.insert).not.toHaveBeenCalled();
  });
  it('refreshes a valid proposal instead of repeatedly discarding it because the initial planning took time',async()=>{
    const f=fixture();f.predictSellFee.mockResolvedValue(snapshot('5'));f.getBlock.mockImplementation(async(request)=>({number:request?.blockNumber??110n,hash,timestamp:100n}));
    await f.worker.tick();expect(f.send).toHaveBeenCalledOnce();
  });
});

describe('readonly tax endpoint sampling',()=>{
  it('pins all source reads to one block and returns unavailable rather than old getter tax on RPC failure',async()=>{
    const chain=new Chain({rpcUrls:['http://127.0.0.1:1'],app:{mode:'read-only',chainId:56,addresses:BSC}} as unknown as Runtime);
    const values:Record<string,unknown>={getReserves:[100n*UNIT,1000n*UNIT,3*86400],token0:BSC.usdt,token1:BSC.token,lastDayReserves:state.lastDayReserves,lastMiningDay:3n,info:[0n,1n,1n,100n*UNIT,1000n*UNIT,0n,0n,0n,0n,0n,0n,0n,0n,0n],balanceOf:60n*UNIT};
    const getBlock=vi.fn(async()=>({number:100n,hash,timestamp:3n*86400n}));
    const readContract=vi.fn(async({functionName}:{functionName:string})=>values[functionName]);chain.client={getChainId:async()=>56,getBlock,readContract} as unknown as Chain['client'];
    const result=await chain.tax();expect(result.sellFeeAfterSync).toBe('5');expect(result.blockNumber).toBe('100');for(const[request]of readContract.mock.calls)expect(request).toHaveProperty('blockNumber',100n);expect(readContract.mock.calls.some(([r])=>r.functionName==='getSellFee')).toBe(false);
    const reads=readContract.mock.calls.length;expect(await chain.tax()).toEqual(result);expect(readContract).toHaveBeenCalledTimes(reads);
    getBlock.mockResolvedValue({number:101n,hash,timestamp:3n*86400n+1n});readContract.mockRejectedValue(new Error('RPC failed'));expect((await chain.tax()).sellFeeAfterSync).toBeNull();
  });
  it('shares simultaneous public reads and invalidates a replaced block hash',async()=>{
    const chain=new Chain({rpcUrls:['http://127.0.0.1:1'],app:{mode:'read-only',chainId:56,addresses:BSC}} as unknown as Runtime);
    const getBlock=vi.fn(async()=>({number:100n,hash,timestamp:100n}));chain.client={getBlock} as unknown as Chain['client'];
    const predict=vi.spyOn(chain,'predictSellFee').mockResolvedValue(snapshot('5'));await Promise.all([chain.tax(),chain.tax()]);expect(predict).toHaveBeenCalledOnce();
    const replacement=`0x${'53'.repeat(32)}` as const;getBlock.mockResolvedValue({number:100n,hash:replacement,timestamp:100n});predict.mockResolvedValue({...snapshot('80'),blockHash:replacement});
    expect((await chain.tax()).sellFeeAfterSync).toBe('80');expect(predict).toHaveBeenCalledTimes(2);
  });
});
