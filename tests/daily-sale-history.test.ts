import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { DailySaleHistory } from '../apps/keeper/src/daily-sale-history.js';
import { Store } from '../apps/keeper/src/store.js';
import type { Runtime } from '../apps/keeper/src/config.js';
import type { Chain } from '../apps/keeper/src/chain.js';
import { BSC, pairAbi, tokenAbi } from '../packages/shared/src/index.js';
import type { MarketSaleReceipt } from '../apps/keeper/src/market-sale.js';

const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:bigint|number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const owner=address(1),outside=address(2),sender=address(3);
const start=BigInt(Date.parse('2026-10-13T00:00:00+08:00')/1000);
type Log=MarketSaleReceipt['logs'][number];
const dirs:string[]=[],stores:Store[]=[],histories:DailySaleHistory[]=[];
function fixture(step=10n,initialHead?:bigint){
  const genesis=start-1000n,first=(1000n+step-1n)/step,end=(87400n+step-1n)/step;
  const dir=mkdtempSync(join(tmpdir(),'market-daily-sales-'));dirs.push(dir);const store=new Store(join(dir,'db.sqlite'));stores.push(store);
  let head=initialHead??end+262n;
  const canonical=new Map<bigint,Hex>(),receipts=new Map<Hex,MarketSaleReceipt>(),allLogs:(Log&{args:{amount0In:bigint;amount1In:bigint;amount0Out:bigint;amount1Out:bigint;sender:Address;to:Address}})[]=[];
  const block=(number:bigint)=>({number,hash:canonical.get(number)??hash(number),timestamp:genesis+number*step});
  const client={getChainId:vi.fn().mockResolvedValue(56),getBlock:vi.fn(async(request?:{blockNumber?:bigint})=>block(request?.blockNumber??head)),getLogs:vi.fn(async({fromBlock,toBlock}:{fromBlock:bigint;toBlock:bigint})=>allLogs.filter(log=>log.blockNumber>=fromBlock&&log.blockNumber<=toBlock)),getTransaction:vi.fn(async({hash:txHash}:{hash:Hex})=>({hash:txHash,from:sender})),getTransactionReceipt:vi.fn(async({hash:txHash}:{hash:Hex})=>{const receipt=receipts.get(txHash);if(!receipt)throw new Error('missing receipt');return receipt;})};
  const config={app:{chainId:56,mode:'live',addresses:BSC}} as unknown as Runtime,chain={client} as unknown as Chain;
  const create=()=>{const history=new DailySaleHistory(config,chain,store,client as unknown as Chain['client']);histories.push(history);return history;};
  const history=create();
  function add(number:bigint,holders:Address[]=[outside],index=0,kind:'external'|'internal'|'ambiguous'='external'){
    const txHash=hash(number*1000n+BigInt(index)+1000000n),blockHash=block(number).hash;
    const make=(logIndex:number,token:Address,topics:ReturnType<typeof encodeEventTopics>,data:Hex):Log=>({address:token,topics:topics as Hex[],data,blockNumber:number,blockHash,transactionHash:txHash,transactionIndex:index,logIndex,removed:false}) as Log;
    const transfer=(logIndex:number,from:Address,to:Address,amount:bigint,token:Address=BSC.token)=>make(logIndex,token,encodeEventTopics({abi:tokenAbi,eventName:'Transfer',args:{from,to}}),encodeAbiParameters([{type:'uint256'}],[amount]));
    const logs:Log[]=[];
    holders.forEach((holder,j)=>{
      const who=kind==='internal'?BSC.token:holder,base=index*1000+j*10;
      logs.push(transfer(base+1,who,BSC.token,25n),transfer(base+2,who,BSC.pair,75n));
      if(kind==='ambiguous')logs.push(transfer(base+3,owner,BSC.pair,5n));
      logs.push(transfer(base+4,BSC.pair,who,70n,BSC.usdt));
      const args={sender,to:who,amount0In:0n,amount1In:75n,amount0Out:70n,amount1Out:0n};
      const swap={...make(base+5,BSC.pair,encodeEventTopics({abi:pairAbi,eventName:'Swap',args:{sender,to:who}}),encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'} as const)),[0n,75n,70n,0n])),args};
      logs.push(swap);allLogs.push(swap);
    });
    receipts.set(txHash,{status:'success',transactionHash:txHash,blockNumber:number,blockHash,gasUsed:21000n,effectiveGasPrice:2n,logs});return txHash;
  }
  const row=()=>store.db.prepare('SELECT * FROM market_sale_days ORDER BY date DESC LIMIT 1').get() as {date:string;startBlock:string|null;endBlock:string|null;scanBlock:string|null;scanHash:Hex|null;boundsJSON:string|null;updatedAt:number}|undefined;
  return {store,history,client,config,chain,create,add,row,receipts,canonical,block,allLogs,first,end,setHead:(n:bigint)=>{head=n;}};
}
afterEach(async()=>{for(const history of histories.splice(0))await history.stop();vi.useRealTimers();vi.restoreAllMocks();for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('Whole previous Beijing day sale history',()=>{
  it('answers from an empty synchronous cache without any RPC scan',()=>{const f=fixture();expect(f.history.previousDay()).toMatchObject({date:'',records:[],status:'loading',checkedAt:0});expect(f.client.getBlock).not.toHaveBeenCalled();expect(f.client.getLogs).not.toHaveBeenCalled();});
  it('uses [Beijing 00:00, next 00:00), includes every holder leg and fetches each transaction only once',async()=>{
    const f=fixture();f.add(f.first-1n);const initial=f.add(f.first,[owner,outside]);const final=f.add(f.end-1n);f.add(f.end);
    await f.history.tick();const result=f.history.previousDay();expect(result).toMatchObject({date:'2026-10-13',startTimestamp:start.toString(),endTimestamp:(start+86400n).toString(),status:'ready',scanBlockNumber:(f.end-1n).toString()});
    expect(result.records).toHaveLength(3);expect(result.records.filter(record=>record.txHash===initial).map(record=>record.owner).sort()).toEqual([owner,outside].sort());expect(result.records[0]!.txHash).toBe(final);
    expect(f.client.getTransactionReceipt).toHaveBeenCalledTimes(2);expect(f.client.getLogs.mock.calls.every(([range])=>range.toBlock-range.fromBlock+1n<=5000n)).toBe(true);
  });
  it('ignores internal fee swaps and completes a genuinely empty day without claiming loading',async()=>{const f=fixture();f.add(f.first,[BSC.token],0,'internal');await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'ready',records:[],date:'2026-10-13'});});
  it('locates day boundaries using timestamps rather than a fixed number of blocks per day',async()=>{const f=fixture(17n);f.add(f.first);f.add(f.end-1n);await f.history.tick();expect(f.row()).toMatchObject({startBlock:f.first.toString(),endBlock:f.end.toString()});expect(f.history.previousDay().records).toHaveLength(2);expect(f.history.previousDay().status).toBe('ready');});
  it('limits each tick to four pages, restores the cursor, and does not truncate all-day records',async()=>{
    const f=fixture(1n);for(let i=0n;i<9n;i++)f.add(f.first+i*10000n);
    await f.history.tick();expect(f.client.getLogs).toHaveBeenCalledTimes(4);expect(f.row()?.scanBlock).toBe((f.first+19999n).toString());expect(f.history.previousDay().status).toBe('loading');
    const restored=f.create();expect(restored.previousDay().status).toBe('stale');await restored.tick();expect(f.client.getLogs.mock.calls[4]![0].fromBlock).toBe(f.first+20000n);
    for(let i=0;i<4&&restored.previousDay().status!=='ready';i++)await restored.tick();expect(restored.previousDay()).toMatchObject({status:'ready'});expect(restored.previousDay().records).toHaveLength(9);
  });
  it('resumes binary day-bound searches after a slow tick and process restart',async()=>{
    const f=fixture();let now=1000000;vi.spyOn(Date,'now').mockImplementation(()=>now);
    const read=f.client.getBlock.getMockImplementation()!;f.client.getBlock.mockImplementation(async(request)=>{const value=await read(request);now+=1800;return value;});
    await f.history.tick();const first=f.row()!;expect(first.startBlock).toBeNull();const oldBounds=JSON.parse(first.boundsJSON!) as {start:{low:string;high:string}};expect(oldBounds.start).not.toEqual({low:'0',high:'9002'});
    const restored=f.create();for(let i=0;i<30;i++)await restored.tick();const resumed=JSON.parse(f.row()!.boundsJSON!) as {start:{low:string;high:string};end:{low:string;high:string}};expect(resumed.start.low).toBe(resumed.start.high);expect(resumed.end.low).toBe(resumed.end.high);f.client.getBlock.mockImplementation(read);await restored.tick();expect(restored.previousDay().status).toBe('ready');
  });
  it('persists multi-leg evidence within a long page and resumes unprocessed receipts without advancing the page prematurely',async()=>{
    const f=fixture();const batch=f.add(f.first,[owner,outside]),other=f.add(f.first+1n);let now=1000000;vi.spyOn(Date,'now').mockImplementation(()=>now);
    const read=f.client.getTransactionReceipt.getMockImplementation()!;f.client.getTransactionReceipt.mockImplementation(async(request)=>{const value=await read(request);now+=7000;return value;});
    await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'loading',scanBlockNumber:null});expect(f.history.previousDay().records).toHaveLength(2);const checkpoint=JSON.parse(f.row()!.boundsJSON!) as {page:{done:string[]}};expect(checkpoint.page.done).toEqual([batch]);
    const restored=f.create();await restored.tick();expect(restored.previousDay().status).toBe('ready');expect(restored.previousDay().records).toHaveLength(3);expect(f.client.getTransactionReceipt.mock.calls.filter(([request])=>request.hash===batch)).toHaveLength(1);expect(restored.previousDay().records.some(record=>record.txHash===other)).toBe(true);
  });
  it('does not advance an RPC-failed page and retries it without losing successful sales',async()=>{const f=fixture();const tx=f.add(f.first);f.client.getLogs.mockRejectedValueOnce(new Error('timeout'));await f.history.tick();expect(f.row()?.scanBlock).toBeNull();expect(f.history.previousDay().status).toBe('loading');await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'ready',records:[expect.objectContaining({txHash:tx})]});});
  it('does not mark ambiguous receipts as a complete day or skip over them',async()=>{const f=fixture();f.add(f.first,[outside],0,'ambiguous');await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'loading',scanBlockNumber:null,records:[]});});
  it('restores a completed cache as stale, keeps it on network failure, and revalidates before ready',async()=>{const f=fixture();f.add(f.first);await f.history.tick();const restored=f.create();expect(restored.previousDay().status).toBe('stale');f.client.getChainId.mockRejectedValueOnce(new Error('rpc down'));await restored.tick();expect(restored.previousDay()).toMatchObject({date:'2026-10-13',status:'stale'});expect(restored.previousDay().reason).toContain('2026-10-13');await restored.tick();expect(restored.previousDay().status).toBe('ready');});
  it('invalidates all daily records after a proven day-tail reorg and rebuilds replacement records',async()=>{
    const f=fixture();const tx=f.add(f.first);await f.history.tick();f.canonical.set(f.end-1n,hash(999999));f.canonical.set(f.first,hash(888888));const receipt=f.receipts.get(tx)!;receipt.blockHash=hash(888888);for(const log of receipt.logs)log.blockHash=hash(888888);
    await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'loading',records:[],scanBlockNumber:null});expect(f.history.previousDay().reason).toContain('重组');await f.history.tick();expect(f.history.previousDay()).toMatchObject({status:'ready',records:[expect.objectContaining({blockHash:hash(888888)})]});
  });
  it('refuses a page that reorgs during getLogs and clears previously committed day evidence',async()=>{const f=fixture();f.add(f.first);const read=f.client.getLogs.getMockImplementation()!;f.client.getLogs.mockImplementationOnce(async(request)=>{const logs=await read(request);f.canonical.set(request.toBlock,hash(99999));return logs;});await f.history.tick();expect(f.row()?.scanBlock).toBeNull();expect(f.history.previousDay().records).toEqual([]);expect(f.history.previousDay().reason).toContain('重组');});
  it('switches yesterday at chain-local midnight and waits for the day-tail three confirmations',async()=>{
    const f=fixture(10n,8740n);f.add(f.end-1n);await f.history.tick();expect(f.history.previousDay()).toMatchObject({date:'2026-10-13',status:'loading',records:[]});expect(f.history.previousDay().reason).toContain('3 次确认');f.setHead(f.end+1n);await f.history.tick();expect(f.history.previousDay()).toMatchObject({date:'2026-10-13',status:'ready'});
    f.setHead(f.end+8640n);await f.history.tick();expect(f.history.previousDay()).toMatchObject({date:'2026-10-14',status:'loading'});expect(f.history.previousDay().reason).toContain('3 次确认');
  });
  it('retains at most the last three date windows without a row-count cap',async()=>{const f=fixture();for(let day=0;day<5;day++){f.setHead(f.end+262n+BigInt(day)*8640n);await f.history.tick();}const dates=f.store.db.prepare('SELECT date FROM market_sale_days ORDER BY date').all();expect(dates).toEqual([{date:'2026-10-15'},{date:'2026-10-16'},{date:'2026-10-17'}]);});
  it('yields to a recent wallet transaction without looking at stored signed raw payloads',async()=>{const f=fixture();f.store.db.prepare('INSERT INTO attempts(hash,taskId,nonce,raw,input,minOut,chunkIndex,sentAt,state,gasWei,output,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(hash(99),hash(98),1,'0x01','1','1',0,Date.now(),'pending','0','0',0);await f.history.tick();expect(f.client.getBlock).not.toHaveBeenCalled();expect(f.history.previousDay().reason).toContain('优先处理');f.store.db.prepare('UPDATE attempts SET sentAt=?').run(Date.now()-121000);await f.history.tick();expect(f.history.previousDay().status).toBe('ready');});
  it('coalesces concurrent scans and waits for in-flight reads on shutdown without writing their late results',async()=>{const f=fixture();let finish:(logs:[])=>void=()=>{};f.client.getLogs.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const first=f.history.tick(),second=f.history.tick();expect(first).toBe(second);await vi.waitFor(()=>expect(f.client.getLogs).toHaveBeenCalledOnce());const before=f.row();const shutdown=f.history.stop();finish([]);await shutdown;await first;expect(f.row()).toEqual(before);expect(f.history.status().running).toBe(false);});
  it('recovers corrupt public cache safely and rebuilds without touching execution tables',async()=>{const f=fixture();f.add(f.first);await f.history.tick();f.store.db.prepare("UPDATE market_sale_days SET boundsJSON='{bad'").run();const restored=f.create();expect(restored.previousDay()).toMatchObject({status:'stale',records:[]});await restored.tick();expect(restored.previousDay().status).toBe('ready');expect(f.store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({n:0});});
});
