import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Hex } from 'viem';
import { stringify, type Policy, type SellTaxSnapshot, type TaxHistoryRecord } from '../../../packages/shared/src/index.js';
export type Registered = { id:Hex; owner:string; policy:Policy; status:string; reason:string; created:number };
export type Attempt = { hash:Hex; taskId:Hex; nonce:number; raw:Hex; input:string; minOut:string; index:number; sentAt:number; state:string; gasWei:string; blockNumber:string|null; blockHash:Hex|null; output:string; confirmed:boolean };
export class Store {
  db:DatabaseSync;
  constructor(path:string) { mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'AwaitingQuote', reason TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (hash TEXT PRIMARY KEY, taskId TEXT NOT NULL, nonce INTEGER NOT NULL, raw TEXT NOT NULL, input TEXT NOT NULL, minOut TEXT NOT NULL, chunkIndex INTEGER NOT NULL, sentAt INTEGER NOT NULL, state TEXT NOT NULL, gasWei TEXT NOT NULL DEFAULT '0', blockNumber TEXT, blockHash TEXT, output TEXT NOT NULL DEFAULT '0', confirmed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, taskId TEXT, created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, taskId TEXT, event TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tax_history (id INTEGER PRIMARY KEY AUTOINCREMENT, chainId INTEGER NOT NULL, token TEXT NOT NULL, observedAt INTEGER NOT NULL, feePercent INTEGER, blockNumber TEXT, blockHash TEXT, timestamp TEXT, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tax_history_scope ON tax_history(chainId,token,observedAt DESC,id DESC);
CREATE INDEX IF NOT EXISTS tax_history_time ON tax_history(observedAt);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_task ON attempts(taskId) WHERE state IN ('signed','pending','mined');`); const aliases=this.db.prepare('SELECT lower(id) AS normalized, count(*) AS n FROM tasks GROUP BY lower(id) HAVING count(*)>1').all();if(aliases.length)throw new Error('数据库存在重复大小写任务 ID，需合并原始交易费用后恢复；已阻止执行');this.db.exec('UPDATE tasks SET id=lower(id); UPDATE attempts SET taskId=lower(taskId), hash=lower(hash); UPDATE quotes SET taskId=lower(taskId); UPDATE audit SET taskId=lower(taskId);'); }
  close(){this.db.close();}
  register(id:Hex,owner:string,p:Policy) {id=id.toLowerCase() as Hex;const old=this.task(id);if(old){if(old.owner.toLowerCase()!==owner.toLowerCase()||stringify(old.policy)!==stringify(p))throw new Error('首次注册的服务参数已冻结；修改需取消并创建新任务');return old;}this.db.prepare('INSERT INTO tasks(id,owner,policy,created) VALUES(?,?,?,?)').run(id,owner.toLowerCase(),stringify(p),Date.now());this.audit(id,'Registered',{});return this.task(id)!;}
  task(id:string):Registered|undefined {const r=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id.toLowerCase()) as Record<string,unknown>|undefined;return r?{...r,policy:JSON.parse(r.policy as string)} as Registered:undefined;}
  tasks(owner?:string):Registered[] {const r=owner?this.db.prepare('SELECT * FROM tasks WHERE owner=? ORDER BY created DESC').all(owner.toLowerCase()):this.db.prepare('SELECT * FROM tasks ORDER BY created DESC').all();return r.map(row=>({...row,policy:JSON.parse(row.policy as string)})) as Registered[];}
  state(id:Hex,status:string,reason=''){this.db.prepare('UPDATE tasks SET status=?,reason=? WHERE id=?').run(status,reason,id.toLowerCase());}
  attempts(id?:string):Attempt[]{const r=id?this.db.prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY sentAt').all(id.toLowerCase()):this.db.prepare('SELECT * FROM attempts ORDER BY sentAt').all();return r.map(row=>({hash:row.hash,taskId:row.taskId,nonce:row.nonce,raw:row.raw,input:row.input,minOut:row.minOut,index:row.chunkIndex,sentAt:row.sentAt,state:row.state,gasWei:row.gasWei,blockNumber:row.blockNumber,blockHash:row.blockHash,output:row.output,confirmed:!!row.confirmed})) as Attempt[];}
  pending(){return this.attempts().filter(a=>['signed','pending','mined'].includes(a.state));}
  insert(a:Attempt){this.db.prepare('INSERT INTO attempts(hash,taskId,nonce,raw,input,minOut,chunkIndex,sentAt,state,gasWei,blockNumber,blockHash,output,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.hash.toLowerCase(),a.taskId.toLowerCase(),a.nonce,a.raw,a.input,a.minOut,a.index,a.sentAt,a.state,a.gasWei,a.blockNumber,a.blockHash,a.output,a.confirmed?1:0);}
  update(hash:Hex,data:Partial<Attempt>){const cols:Record<string,string>={state:'state',gasWei:'gasWei',blockNumber:'blockNumber',blockHash:'blockHash',output:'output',confirmed:'confirmed'};for(const [k,v]of Object.entries(data)){const col=cols[k];if(col)this.db.prepare(`UPDATE attempts SET ${col}=? WHERE hash=?`).run(typeof v==='boolean'?Number(v):v as string,hash.toLowerCase());}}
  spent(id:Hex){return this.attempts(id).reduce((n,a)=>n+BigInt(a.gasWei),0n);}
  acquire(key:string,holder:string,ttlMs:number,now=Date.now()){this.db.exec('BEGIN IMMEDIATE');try{const r=this.db.prepare('SELECT * FROM leases WHERE key=?').get(key) as {holder:string;expires:number}|undefined;if(r&&r.expires>now&&r.holder!==holder){this.db.exec('ROLLBACK');return false;}this.db.prepare('INSERT INTO leases(key,holder,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires').run(key,holder,now+ttlMs);this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  release(key:string,holder:string){this.db.prepare('DELETE FROM leases WHERE key=? AND holder=?').run(key,holder);}
  saveQuote(id:string,task:string|undefined,data:unknown){this.db.prepare('INSERT OR REPLACE INTO quotes(id,taskId,created,data) VALUES(?,?,?,?)').run(id,task?.toLowerCase()??null,Date.now(),stringify(data));this.db.prepare('DELETE FROM quotes WHERE created<?').run(Date.now()-7*86400000);}
  audit(task:string|undefined,event:string,data:unknown){this.db.prepare('INSERT INTO audit(created,taskId,event,data) VALUES(?,?,?,?)').run(Date.now(),task?.toLowerCase()??null,event,stringify(data));}
  /** Persist changes immediately; stable values get at most one heartbeat per minute. Never interpret a read failure as 0% tax. */
  recordTax(chainId:number,token:string,snapshot:SellTaxSnapshot|null,error='',now=Date.now()){
    const fee=snapshot?.sellFeeAfterSync??null,feePercent=fee===null?null:Number(fee);
    if(fee!==null&&(!/^\d{1,3}$/.test(fee)||!Number.isInteger(feePercent)||feePercent!>100))throw new Error('税率记录无效');
    const last=this.db.prepare('SELECT * FROM tax_history WHERE chainId=? AND token=? ORDER BY observedAt DESC,id DESC LIMIT 1').get(chainId,token.toLowerCase()) as TaxHistoryRecord|undefined;
    const replaced=!!snapshot&&last?.blockNumber===snapshot.blockNumber&&last.blockHash!==snapshot.blockHash;
    if(last&&!replaced&&last.feePercent===feePercent&&now-last.observedAt<60000)return false;
    this.db.prepare('INSERT INTO tax_history(chainId,token,observedAt,feePercent,blockNumber,blockHash,timestamp,reason) VALUES(?,?,?,?,?,?,?,?)')
      .run(chainId,token.toLowerCase(),now,feePercent,snapshot?.blockNumber??null,snapshot?.blockHash??null,snapshot?.timestamp??null,(snapshot?.reason??error).slice(0,1200));
    this.db.prepare('DELETE FROM tax_history WHERE observedAt<? OR id<=(SELECT max(id)-100000 FROM tax_history)').run(now-30*86400000);
    return true;
  }
  taxHistory(chainId:number,token:string,now=Date.now()){
    const scope=[chainId,token.toLowerCase(),now-30*86400000] as const;
    const summary=this.db.prepare('SELECT min(observedAt) AS firstRecordedAt,min(feePercent) AS minPercent,max(feePercent) AS maxPercent FROM tax_history WHERE chainId=? AND token=? AND observedAt>=?').get(...scope) as {firstRecordedAt:number|null;minPercent:number|null;maxPercent:number|null};
    const records=this.db.prepare('SELECT observedAt,feePercent,blockNumber,blockHash,timestamp,reason FROM tax_history WHERE chainId=? AND token=? AND observedAt>=? ORDER BY observedAt DESC,id DESC LIMIT 20').all(...scope) as TaxHistoryRecord[];
    return {...summary,records,retentionDays:30};
  }
}
