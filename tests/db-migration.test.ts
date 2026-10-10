import { afterEach,describe,it,expect } from 'vitest';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,type Attempt } from '../apps/keeper/src/store.ts';
import { exportDatabase,restoreDatabase } from '../scripts/migrate-db.ts';

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
