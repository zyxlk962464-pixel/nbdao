import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters,encodeEventTopics,encodeFunctionData,keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executorAbi } from '../packages/shared/src/index.ts';
import { Store,type Attempt } from '../apps/keeper/src/store.ts';
import type { Runtime } from '../apps/keeper/src/config.ts';
import type { Chain } from '../apps/keeper/src/chain.ts';
import type { Optimizer } from '../apps/keeper/src/optimizer.ts';

const sendRaw=vi.hoisted(()=>vi.fn(async()=>`0x${'12'.repeat(32)}`));
vi.mock('../apps/keeper/src/chain.ts',async importOriginal=>({...await importOriginal<typeof import('../apps/keeper/src/chain.ts')>(),publicClient:()=>({sendRawTransaction:sendRaw})}));
const savedLoader=process.loadEnvFile;process.loadEnvFile=()=>{throw new Error('No user environment files in recovery tests');};
const { Worker }=await import('../apps/keeper/src/worker.ts');process.loadEnvFile=savedLoader;
// Public Anvil fixture only. All RPC/broadcast methods are mocked.
const account=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const seller='0x0000000000000000000000000000000000000022' as const;
const id=`0x${'11'.repeat(32)}` as const,blockHash=`0x${'13'.repeat(32)}` as const;
const policy={slippageBps:100,maxAttempts:20,gasBudgetWei:'1000',maxTxGasWei:'1000',minEconomicUSDT:'0',confirmations:1,maxQuoteAgeBlocks:3,maxSellFeePercent:5};
const stores:Store[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.clearAllMocks();});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'seller-recovery-'));dirs.push(dir);const store=new Store(join(dir,'db.sqlite'));stores.push(store);store.register(id,account.address,policy);
  const data=encodeFunctionData({abi:executorAbi,functionName:'executeChunk',args:[account.address,id,0,10n,1n,150n]});
  const raw=await account.signTransaction({chainId:31337,to:seller,data,nonce:0,gas:100n,gasPrice:1n,type:'legacy'});
  const a:Attempt={hash:keccak256(raw),taskId:id,nonce:0,raw,input:'10',minOut:'1',index:0,sentAt:1,state:'signed',gasWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false};store.insert(a);
  const task={owner:account.address,status:1,params:{expiresAt:200n}};
  const getBlock=vi.fn(async()=>({number:100n,hash:blockHash,timestamp:100n}));
  const getTransactionCount=vi.fn(async()=>0),getTransactionReceipt=vi.fn(async()=>{throw new Error('Receipt unavailable');});
  const chain={rawTask:async()=>task,client:{getBlock,getTransactionCount,getTransactionReceipt}} as unknown as Chain;
  const config={app:{mode:'local',ready:true,chainId:31337,sellerAddress:seller,executor:account.address},rpcUrls:['http://127.0.0.1:1']} as unknown as Runtime;
  return {store,a,task,getBlock,getTransactionCount,getTransactionReceipt,worker:new Worker(config,chain,{} as Optimizer,store)};
}
function log(address=seller,owner=account.address){
  return {address,topics:encodeEventTopics({abi:executorAbi,eventName:'ChunkExecuted',args:{taskId:id,owner}}),data:encodeAbiParameters([{type:'uint32'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[0,10n,9n,20n,0n])};
}
function receipt(logs:ReturnType<typeof log>[]){return {status:'success',blockNumber:99n,blockHash,gasUsed:7n,effectiveGasPrice:2n,logs};}

describe('recovery broadcast and canonical accounting boundaries',()=>{
  it.each(['read-only','not-ready'])('cannot rebroadcast a stored signature when %s',async mode=>{
    const f=await fixture();if(mode==='read-only')f.worker.config.app.mode='read-only';else f.worker.config.app.ready=false;
    await f.worker.broadcast(f.a);expect(sendRaw).not.toHaveBeenCalled();expect(f.getBlock).not.toHaveBeenCalled();expect(f.store.task(id)?.status).toBe('MissingConfiguration');
  });
  it('recovers a valid stored transaction using exactly the same raw signature',async()=>{
    const f=await fixture();await f.worker.reconcile(100n);expect(sendRaw).toHaveBeenCalledExactlyOnceWith({serializedTransaction:f.a.raw});expect(f.store.pending()).toHaveLength(1);expect(f.store.attempts(id)).toHaveLength(1);
  });
  it('does not rebroadcast a foreign owner even if an imported database contains its signed transaction',async()=>{
    const f=await fixture();f.worker.config.allowedOwner='0x0000000000000000000000000000000000000099';
    await expect(f.worker.broadcast(f.a)).rejects.toThrow('持币钱包');expect(sendRaw).not.toHaveBeenCalled();
  });
  it('stops broadcasting as soon as graceful shutdown begins',async()=>{
    const f=await fixture();await f.worker.stop();await f.worker.broadcast(f.a);expect(sendRaw).not.toHaveBeenCalled();expect(f.store.pending()).toHaveLength(1);
  });
  it.each(['validUntil','task-expired','cancelled','unknown-nonce'])('does not revive a stored transaction at %s',async boundary=>{
    const f=await fixture();if(boundary==='validUntil')f.getBlock.mockResolvedValue({number:100n,hash:blockHash,timestamp:150n});
    if(boundary==='task-expired')f.task.params.expiresAt=100n;if(boundary==='cancelled')f.task.status=5;if(boundary==='unknown-nonce')f.getTransactionCount.mockResolvedValue(1);
    await f.worker.reconcile(100n);expect(sendRaw).not.toHaveBeenCalled();expect(f.store.pending()).toHaveLength(1);expect(f.store.spent(id)).toBe(0n);
  });
  it('refuses a corrupted persisted input before any broadcast',async()=>{
    const f=await fixture();await expect(f.worker.broadcast({...f.a,input:'11'})).rejects.toThrow('参数不匹配');expect(sendRaw).not.toHaveBeenCalled();
  });
  it.each(['missing','foreign-contract','foreign-owner','duplicate'])('retains paid Gas and blocks new execution for a %s event',async boundary=>{
    const f=await fixture();const foreign='0x0000000000000000000000000000000000000099' as const;
    const logs=boundary==='missing'?[]:boundary==='foreign-contract'?[log(foreign as typeof seller)]:boundary==='foreign-owner'?[log(seller,foreign)]:[log(),log()];
    f.getTransactionReceipt.mockResolvedValue(receipt(logs) as never);
    expect(await f.worker.reconcile(100n)).toBe(false);expect(sendRaw).not.toHaveBeenCalled();expect(f.store.spent(id)).toBe(14n);expect(f.store.pending()).toHaveLength(1);expect(f.store.attempts(id)[0]?.output).toBe('0');
    // Repeating the same check neither duplicates the cost nor rebroadcasts.
    expect(await f.worker.reconcile(100n)).toBe(false);expect(f.store.spent(id)).toBe(14n);expect(sendRaw).not.toHaveBeenCalled();
  });
  it('only accepts the matching event from the configured seller and task owner',async()=>{
    const f=await fixture();const foreign='0x0000000000000000000000000000000000000099' as const;
    f.getTransactionReceipt.mockResolvedValue(receipt([log(foreign as typeof seller),log()]) as never);
    expect(await f.worker.reconcile(100n)).toBe(true);expect(f.store.spent(id)).toBe(14n);expect(f.store.attempts(id)[0]).toMatchObject({state:'success',output:'20',confirmed:true});expect(sendRaw).not.toHaveBeenCalled();
  });
});
