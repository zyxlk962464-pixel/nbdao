import { afterEach,describe,it,expect } from 'vitest';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,type Attempt } from '../apps/keeper/src/store.ts';
import { exportDatabase,restoreDatabase } from '../scripts/migrate-db.ts';
import { BSC } from '../packages/shared/src/index.ts';
import { OpeningStore } from '../apps/keeper/src/opening-store.ts';

const id=`0x${'12'.repeat(32)}` as const,owner='0x0000000000000000000000000000000000000011';
const policy={slippageBps:100,maxAttempts:10,gasBudgetWei:'1000',maxTxGasWei:'100',minEconomicUSDT:'0',confirmations:3,maxQuoteAgeBlocks:3,maxSellFeePercent:30};
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'keeper-migration-'));directories.push(directory);
  const source=join(directory,'source.sqlite'),snapshot=join(directory,'export.sqlite'),target=join(directory,'target.sqlite');
  const store=new Store(source);store.register(id,owner,policy);
  const paid:Attempt={hash:`0x${'13'.repeat(32)}`,taskId:id,nonce:7,raw:'0x01',input:'10',minOut:'1',index:0,sentAt:1,state:'failed',gasWei:'14',blockNumber:'100',blockHash:`0x${'14'.repeat(32)}`,output:'0',confirmed:true};store.insert(paid);
  store.insert({...paid,hash:`0x${'15'.repeat(32)}`,nonce:8,state:'pending',raw:'0x02',gasWei:'0',blockNumber:null,blockHash:null,confirmed:false});
  store.close();return {source,snapshot,target};
}
describe('SQLite cutover preserves execution history',()=>{
  it('retains opening signatures, pending nonces, setup Gas and builder payments',async()=>{
    const f=fixture(),source=new Store(f.source),opening=new OpeningStore(source);
    const p={totalCostWei:'1000',setupTxHashes:[`0x${'16'.repeat(32)}` as const],gasPriceWei:'1',builderFeeWei:'80',confirmations:3 as const};
    opening.register(id,owner,p,'23');
    opening.insert({taskId:id,hash:`0x${'17'.repeat(32)}`,nonce:9,raw:'0x03',sentAt:2,state:'unknown',submissions:2,gasWei:'11',builderFeeWei:'80',blockNumber:null,blockHash:null,output:'5',confirmed:false});source.close();
    const manifest=await exportDatabase(f.source,f.snapshot);
    expect(manifest.summary).toMatchObject({pending:2,gasSpentWei:'25',setupGasSpentWei:'23',builderFeeSpentWei:'80'});
    await restoreDatabase(f.snapshot,f.target);const target=new Store(f.target);
    try{const restored=new OpeningStore(target);expect(restored.task(id)?.policy).toEqual(p);expect(restored.attempt(id)).toMatchObject({nonce:9,raw:'0x03',submissions:2,builderFeeWei:'80',state:'unknown'});}finally{target.close();}
  });
  it('can restore snapshots made before the independent opening tables existed',async()=>{
    const f=fixture(),source=new Store(f.source);source.db.exec('DROP TABLE opening_tasks; DROP TABLE opening_attempts');source.close();
    await exportDatabase(f.source,f.snapshot);
    const path=f.snapshot+'.manifest.json',manifest=JSON.parse(readFileSync(path,'utf8'));
    delete manifest.summary.counts.opening_tasks;delete manifest.summary.counts.opening_attempts;delete manifest.summary.setupGasSpentWei;delete manifest.summary.builderFeeSpentWei;
    writeFileSync(path,JSON.stringify(manifest));await restoreDatabase(f.snapshot,f.target);
    const target=new Store(f.target);try{expect(target.task(id)?.policy).toEqual(policy);expect(new OpeningStore(target).attempts()).toHaveLength(0);}finally{target.close();}
  });
  it('backs up recorded taxes and refuses to overwrite a target containing only tax history',async()=>{
    const f=fixture(),source=new Store(f.source),now=Date.now();
    source.recordTax(56,BSC.token,{sellFeeAfterSync:'20',blockNumber:'100',blockHash:`0x${'16'.repeat(32)}`,timestamp:String(Math.floor(now/1000)),reason:'snapshot'});source.close();
    await exportDatabase(f.source,f.snapshot);await restoreDatabase(f.snapshot,f.target);
    const target=new Store(f.target);try{expect(target.taxHistory(56,BSC.token).minPercent).toBe(20);}finally{target.close();}
    const other=f.target+'.history-only',existing=new Store(other);existing.db.prepare('INSERT INTO tax_history(chainId,token,observedAt,feePercent,reason) VALUES(?,?,?,?,?)').run(56,BSC.token,now,null,'Legacy unavailable');existing.close();
    await expect(restoreDatabase(f.snapshot,other)).rejects.toThrow('已有记录');
  });
  it('retains frozen policies, pending signatures, nonces and paid Gas; re-import cannot reset them',async()=>{
    const f=fixture(),manifest=await exportDatabase(f.source,f.snapshot);expect(manifest.cutoverReady).toBe(true);expect(manifest.summary.pending).toBe(1);expect(manifest.summary.gasSpentWei).toBe('14');
    await restoreDatabase(f.snapshot,f.target);const store=new Store(f.target);
    try{expect(store.task(id)?.policy).toEqual(policy);expect(store.spent(id)).toBe(14n);expect(store.pending()[0]).toMatchObject({nonce:8,raw:'0x02'});store.update(store.pending()[0]!.hash,{gasWei:'5'});}finally{store.close();}
    expect((await restoreDatabase(f.snapshot,f.target)).alreadyImported).toBe(true);const after=new Store(f.target);try{expect(after.spent(id)).toBe(19n);}finally{after.close();}
  });
  it('rejects an active execution lease and marks an online preview unsuitable for live cutover',async()=>{
    const f=fixture(),store=new Store(f.source);store.acquire('worker','running',60000);store.close();
    await expect(exportDatabase(f.source,f.snapshot)).rejects.toThrow('停止 Keeper');const preview=await exportDatabase(f.source,f.snapshot,true);expect(preview.cutoverReady).toBe(false);
    await restoreDatabase(f.snapshot,f.target);expect(JSON.parse(readFileSync(f.target+'.import.json','utf8')).cutoverReady).toBe(false);
  });
  it('rejects modified snapshots and populated targets',async()=>{
    const f=fixture();await exportDatabase(f.source,f.snapshot);const existing=new Store(f.target);existing.register(id,owner,policy);existing.close();
    await expect(restoreDatabase(f.snapshot,f.target)).rejects.toThrow('已有记录');
    writeFileSync(f.snapshot,Buffer.concat([readFileSync(f.snapshot),Buffer.from('tampered')]));await expect(restoreDatabase(f.snapshot,join(f.target,'other'))).rejects.toThrow('校验失败');
  });
});
