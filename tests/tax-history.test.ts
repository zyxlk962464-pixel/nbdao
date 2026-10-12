import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/keeper/src/store.ts';
import { TaxRecorder } from '../apps/keeper/src/tax-recorder.ts';
import type { Chain } from '../apps/keeper/src/chain.ts';
import type { Runtime } from '../apps/keeper/src/config.ts';
import { BSC,type SellTaxSnapshot } from '../packages/shared/src/index.ts';

const stores:Store[]=[],dirs:string[]=[],recorders:TaxRecorder[]=[];
afterEach(async()=>{for(const r of recorders.splice(0))await r.stop();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function db(){const dir=mkdtempSync(join(tmpdir(),'tax-history-'));dirs.push(dir);const path=join(dir,'keeper.sqlite'),store=new Store(path);stores.push(store);return {path,store};}
const hash=`0x${'12'.repeat(32)}` as const;
const snapshot=(fee:string|null,number='100'):SellTaxSnapshot=>({sellFeeAfterSync:fee,blockNumber:number,blockHash:hash,timestamp:String(Math.floor(Date.now()/1000)),reason:fee===null?'RPC 暂不可用':'按源码计算的基础税'});
describe('durable tax observations',()=>{
  it('does not persist 100% or unavailable observations, even after the snapshot interval',()=>{
    const {store}=db(),now=Date.now();
    expect(store.recordTax(56,BSC.token,snapshot('100'),' ',now)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('100','101'),' ',now+1800000)).toBe(false);
    expect(store.recordTax(56,BSC.token,null,'RPC 限流',now+1800001)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot(null,'102'),' ',now+3600001)).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS n FROM tax_history').get()).toEqual({n:0});
    const history=store.taxHistory(56,BSC.token,now+3600001);
    expect(history.records).toHaveLength(0);expect(history.firstRecordedAt).toBeNull();expect(history.minPercent).toBeNull();expect(history.maxPercent).toBeNull();
    expect(()=>store.recordTax(56,BSC.token,snapshot('101'))).toThrow('无效');
  });
  it('records a return from 100% to a lower fee immediately without persisting the 100% value',()=>{
    const {store}=db(),now=Date.now();
    expect(store.recordTax(56,BSC.token,snapshot('80'),' ',now)).toBe(true);
    expect(store.recordTax(56,BSC.token,snapshot('100','101'),' ',now+1000)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('80','102'),' ',now+2000)).toBe(true);
    expect(store.recordTax(56,BSC.token,snapshot('20','103'),' ',now+3000)).toBe(true);
    const history=store.taxHistory(56,BSC.token,now+3000);
    expect(history.records.map(r=>r.feePercent)).toEqual([20,80,80]);expect(history.minPercent).toBe(20);expect(history.maxPercent).toBe(80);
    expect(store.db.prepare('SELECT count(*) AS n FROM tax_history').get()).toEqual({n:3});
  });
  it('does not mistake an unavailable observation for a fee change or reset the stable interval',()=>{
    const {store}=db(),now=Date.now();
    expect(store.recordTax(56,BSC.token,snapshot('80'),' ',now)).toBe(true);
    expect(store.recordTax(56,BSC.token,null,'RPC 限流',now+1000)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot(null,'101'),' ',now+2000)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('80','102'),' ',now+3000)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('80','103'),' ',now+1800000)).toBe(true);
    expect(store.taxHistory(56,BSC.token,now+1800000).records.map(r=>r.feePercent)).toEqual([80,80]);
  });
  it('keeps the stable 30-minute boundary across a store restart',()=>{
    const {path,store}=db(),now=Date.now();
    expect(store.recordTax(56,BSC.token,snapshot('80'),' ',now)).toBe(true);
    expect(store.recordTax(56,BSC.token,snapshot('80','101'),' ',now+60000)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('80','102'),' ',now+1799999)).toBe(false);
    expect(store.recordTax(56,BSC.token,snapshot('80','103'),' ',now+1800000)).toBe(true);
    const before=store.taxHistory(56,BSC.token,now+1800000);expect(before.records).toHaveLength(2);
    store.close();stores.splice(stores.indexOf(store),1);const restored=new Store(path);stores.push(restored);
    expect(restored.taxHistory(56,BSC.token,now+1800000)).toEqual(before);
    expect(restored.recordTax(56,BSC.token,snapshot('80','104'),' ',now+1800001)).toBe(false);
    expect(restored.recordTax(56,BSC.token,snapshot('80','105'),' ',now+3599999)).toBe(false);
    expect(restored.recordTax(56,BSC.token,snapshot('80','106'),' ',now+3600000)).toBe(true);
    expect(restored.taxHistory(56,BSC.token,now+3600000).records).toHaveLength(3);
  });
  it('keeps same-height replacement hashes and scopes retention/statistics to the requested token and network',()=>{
    const {store}=db(),now=Date.now();
    store.recordTax(56,BSC.token,snapshot('5'),' ',now-31*86400000);
    store.recordTax(31337,BSC.token,snapshot('0'),' ',now);
    store.recordTax(56,BSC.usdt,snapshot('20'),' ',now);
    store.recordTax(56,BSC.token,snapshot('80'),' ',now);
    store.recordTax(56,BSC.token,{...snapshot('80'),blockHash:`0x${'13'.repeat(32)}`} ,' ',now+500);
    const history=store.taxHistory(56,BSC.token,now+500);expect(history.records).toHaveLength(2);expect(history.minPercent).toBe(80);expect(history.maxPercent).toBe(80);
    expect(store.taxHistory(31337,BSC.token,now+500).minPercent).toBe(0);
    expect(store.taxHistory(56,BSC.usdt,now+500).records).toHaveLength(1);expect(store.taxHistory(56,BSC.usdt,now+500).minPercent).toBe(20);
  });
  it('filters legacy 100% and unavailable rows before summaries and the latest-record limit',()=>{
    const {store}=db(),now=Date.now();
    const insert=store.db.prepare('INSERT INTO tax_history(chainId,token,observedAt,feePercent,reason) VALUES(?,?,?,?,?)');
    insert.run(56,BSC.token.toLowerCase(),now-31*86400000,5,'expired low fee');
    insert.run(56,BSC.token.toLowerCase(),now-100000,100,'legacy high fee');
    insert.run(56,BSC.token.toLowerCase(),now-90000,null,'legacy unavailable');
    insert.run(56,BSC.token.toLowerCase(),now-80000,80,'low fee');
    insert.run(56,BSC.token.toLowerCase(),now-70000,20,'lower fee');
    for(let i=0;i<25;i++)insert.run(56,BSC.token.toLowerCase(),now-i,i%2===0?100:null,'recent legacy row');
    insert.run(31337,BSC.token.toLowerCase(),now-60000,0,'other network');
    insert.run(56,BSC.usdt.toLowerCase(),now-60000,10,'other token');
    const history=store.taxHistory(56,BSC.token,now);
    expect(history.records.map(r=>r.feePercent)).toEqual([20,80]);expect(history.firstRecordedAt).toBe(now-80000);expect(history.minPercent).toBe(20);expect(history.maxPercent).toBe(80);
    expect(store.db.prepare('SELECT count(*) AS n FROM tax_history').get()).toEqual({n:32});
  });
  it('bounds the table while leaving task execution policies intact',()=>{
    const {store}=db(),now=Date.now(),id=`0x${'14'.repeat(32)}` as const;
    const policy={slippageBps:100,maxAttempts:10,gasBudgetWei:'1000',maxTxGasWei:'100',minEconomicUSDT:'0',confirmations:3,maxQuoteAgeBlocks:3,maxSellFeePercent:30};
    store.register(id,'owner',policy);
    store.db.prepare('INSERT INTO tax_history(id,chainId,token,observedAt,feePercent,reason) VALUES(?,?,?,?,?,?)').run(1,56,BSC.token,now,5,'observed');
    store.db.prepare('UPDATE sqlite_sequence SET seq=100001 WHERE name=?').run('tax_history');
    store.recordTax(56,BSC.token,snapshot('20'),' ',now+1000);
    expect(store.taxHistory(56,BSC.token,now+1000).minPercent).toBe(20);expect(store.task(id)?.policy).toEqual(policy);
  });
});
describe('server recorder has no browser or live-task dependency',()=>{
  function recorder(tax:()=>Promise<SellTaxSnapshot>){
    let emit!:()=>void;const unwatch=vi.fn(),{store}=db();
    const chain={tax:vi.fn(tax),client:{watchBlockNumber:(options:{onBlockNumber:()=>void})=>{emit=options.onBlockNumber;return unwatch;}}} as unknown as Chain;
    const config={app:{chainId:56,addresses:BSC,mode:'read-only',ready:false},pollMs:500} as unknown as Runtime;
    const r=new TaxRecorder(config,chain,store);recorders.push(r);r.start();return {r,chain,store,emit,unwatch};
  }
  it('records in read-only mode with no registered task, coalesces busy notifications and stops cleanly',async()=>{
    let finish!:(s:SellTaxSnapshot)=>void;const first=new Promise<SellTaxSnapshot>(resolve=>{finish=resolve;});let reads=0;
    const f=recorder(()=>++reads===1?first:Promise.resolve(snapshot('20','101')));
    f.emit();f.emit();f.emit();expect(f.chain.tax).toHaveBeenCalledTimes(1);finish(snapshot('100'));
    await vi.waitFor(()=>expect(f.store.taxHistory(56,BSC.token).records).toHaveLength(1));
    expect(f.store.taxHistory(56,BSC.token).records[0]?.feePercent).toBe(20);
    expect(f.chain.tax).toHaveBeenCalledTimes(2);expect(f.r.status().lastCheckedAt).not.toBeNull();
    await f.r.stop();f.emit();await Promise.resolve();expect(f.unwatch).toHaveBeenCalledOnce();expect(f.chain.tax).toHaveBeenCalledTimes(2);
  });
  it('reports a read outage and recovery without persisting unavailable or duplicate low-fee snapshots',async()=>{
    let failed=true;const f=recorder(async()=>{if(failed)throw new Error('RPC unavailable');return snapshot('80');});
    f.emit();await vi.waitFor(()=>expect(f.r.status().error).toContain('RPC unavailable'));
    expect(f.store.taxHistory(56,BSC.token).records).toHaveLength(0);
    expect(f.store.taxHistory(56,BSC.token).minPercent).toBeNull();expect(f.r.status().error).toContain('RPC unavailable');
    failed=false;f.emit();await vi.waitFor(()=>expect(f.store.taxHistory(56,BSC.token).minPercent).toBe(80));expect(f.r.status().error).toBeNull();
    failed=true;f.emit();await vi.waitFor(()=>expect(f.r.status().error).toContain('RPC unavailable'));
    expect(f.store.taxHistory(56,BSC.token).records).toHaveLength(1);
    failed=false;f.emit();await vi.waitFor(()=>expect(f.r.status().error).toBeNull());
    expect(f.store.taxHistory(56,BSC.token).records).toHaveLength(1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM tax_history').get()).toEqual({n:1});
  });
  it('reports an unavailable snapshot through recorder status without writing a history row',async()=>{
    let unknown=true;const f=recorder(async()=>snapshot(unknown?null:'80'));
    f.emit();await vi.waitFor(()=>expect(f.r.status().error).toBe('RPC 暂不可用'));
    expect(f.r.status().lastCheckedAt).not.toBeNull();expect(f.store.taxHistory(56,BSC.token).records).toHaveLength(0);
    unknown=false;f.emit();await vi.waitFor(()=>expect(f.r.status().error).toBeNull());
    expect(f.store.taxHistory(56,BSC.token).records.map(r=>r.feePercent)).toEqual([80]);
  });
});
