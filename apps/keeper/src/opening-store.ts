import type { Hex } from 'viem';
import { stringify, type OpeningPolicy } from '../../../packages/shared/src/index.js';
import type { Store } from './store.js';

export type { OpeningPolicy } from '../../../packages/shared/src/index.js';
export type OpeningRegistered = {id:Hex;owner:string;policy:OpeningPolicy;setupGasWei:string;status:string;reason:string;created:number};
export type OpeningAttempt = {taskId:Hex;hash:Hex;nonce:number;raw:Hex;sentAt:number;state:string;submissions:number;gasWei:string;builderFeeWei:string;blockNumber:string|null;blockHash:Hex|null;output:string;confirmed:boolean};
export class OpeningStore {
  constructor(public store:Store){}
  register(id:Hex,owner:string,policy:OpeningPolicy,setupGasWei:string){
    id=id.toLowerCase() as Hex;const old=this.task(id);
    if(old){if(old.owner.toLowerCase()!==owner.toLowerCase()||stringify(old.policy)!==stringify(policy)||old.setupGasWei!==setupGasWei)throw new Error('首次注册的抢卖条件已冻结；修改需取消并创建新任务');return old;}
    this.store.db.prepare('INSERT INTO opening_tasks(id,owner,policy,setupGasWei,created) VALUES(?,?,?,?,?)').run(id,owner.toLowerCase(),stringify(policy),setupGasWei,Date.now());
    this.store.audit(id,'OpeningRegistered',{setupGasWei});return this.task(id)!;
  }
  task(id:string):OpeningRegistered|undefined{const row=this.store.db.prepare('SELECT * FROM opening_tasks WHERE id=?').get(id.toLowerCase()) as Record<string,unknown>|undefined;return row?{...row,policy:JSON.parse(row.policy as string)} as OpeningRegistered:undefined;}
  tasks(owner?:string):OpeningRegistered[]{const rows=owner?this.store.db.prepare('SELECT * FROM opening_tasks WHERE owner=? ORDER BY created DESC').all(owner.toLowerCase()):this.store.db.prepare('SELECT * FROM opening_tasks ORDER BY created DESC').all();return rows.map(row=>({...row,policy:JSON.parse(row.policy as string)})) as OpeningRegistered[];}
  state(id:string,status:string,reason:string){this.store.db.prepare('UPDATE opening_tasks SET status=?,reason=? WHERE id=?').run(status,reason,id.toLowerCase());}
  attempt(id:string):OpeningAttempt|undefined{const row=this.store.db.prepare('SELECT * FROM opening_attempts WHERE taskId=?').get(id.toLowerCase()) as Record<string,unknown>|undefined;return row?{...row,confirmed:Boolean(row.confirmed)} as OpeningAttempt:undefined;}
  attempts(){return this.store.db.prepare('SELECT * FROM opening_attempts ORDER BY sentAt').all().map(row=>({...row,confirmed:Boolean(row.confirmed)})) as OpeningAttempt[];}
  insert(a:OpeningAttempt){this.store.db.prepare('INSERT INTO opening_attempts(taskId,hash,nonce,raw,sentAt,state,submissions,gasWei,builderFeeWei,blockNumber,blockHash,output,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.taskId.toLowerCase(),a.hash.toLowerCase(),a.nonce,a.raw,a.sentAt,a.state,a.submissions,a.gasWei,a.builderFeeWei,a.blockNumber,a.blockHash,a.output,Number(a.confirmed));}
  update(id:string,data:Partial<OpeningAttempt>){const allowed=['state','submissions','gasWei','builderFeeWei','blockNumber','blockHash','output','confirmed'];for(const [key,value] of Object.entries(data))if(allowed.includes(key))this.store.db.prepare(`UPDATE opening_attempts SET ${key}=? WHERE taskId=?`).run(typeof value==='boolean'?Number(value):value as string,id.toLowerCase());}
  publicAttempt(id:string){const a=this.attempt(id);if(!a)return null;const {raw:_raw,...safe}=a;return safe;}
}
