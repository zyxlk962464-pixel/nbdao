import { backup,DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { chmodSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tables=['tasks','attempts','quotes','audit','leases','tax_history','opening_tasks','opening_attempts'] as const;
type Summary={counts:Record<string,number>;pending:number;gasSpentWei:string;activeLeases:number;setupGasSpentWei?:string;builderFeeSpentWei?:string};
type Manifest={version:1;createdAt:string;sha256:string;cutoverReady:boolean;summary:Summary};
function hash(path:string){return createHash('sha256').update(readFileSync(path)).digest('hex');}
function inspect(db:DatabaseSync):Summary{
  const integrity=db.prepare('PRAGMA integrity_check').get() as {integrity_check:string};
  if(integrity.integrity_check!=='ok')throw new Error('SQLite 完整性检查失败');
  const counts:Record<string,number>={};
  const exists=(table:string)=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  for(const table of tables)counts[table]=exists(table)?Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n):0;
  const opening=exists('opening_attempts');
  const pending=Number(db.prepare("SELECT count(*) AS n FROM attempts WHERE state IN ('signed','pending','mined')").get()!.n)+(opening?Number(db.prepare("SELECT count(*) AS n FROM opening_attempts WHERE state IN ('signed','pending','mined','unknown')").get()!.n):0);
  const gasRows=[...db.prepare('SELECT gasWei FROM attempts').all(),...(opening?db.prepare('SELECT gasWei FROM opening_attempts').all():[])];
  const gasSpentWei=gasRows.reduce((total,row)=>total+BigInt(String(row.gasWei)),0n).toString();
  const setupGasSpentWei=(exists('opening_tasks')?db.prepare('SELECT setupGasWei FROM opening_tasks').all():[]).reduce((total,row)=>total+BigInt(String(row.setupGasWei)),0n).toString();
  const builderFeeSpentWei=(opening?db.prepare('SELECT builderFeeWei FROM opening_attempts').all():[]).reduce((total,row)=>total+BigInt(String(row.builderFeeWei)),0n).toString();
  const activeLeases=Number(db.prepare('SELECT count(*) AS n FROM leases WHERE expires>?').get(Date.now())!.n);
  return {counts,pending,gasSpentWei,setupGasSpentWei,builderFeeSpentWei,activeLeases};
}
function sameSpend(a:Summary,b:Summary){return a.pending===b.pending&&a.gasSpentWei===b.gasSpentWei&&(a.setupGasSpentWei??'0')===(b.setupGasSpentWei??'0')&&(a.builderFeeSpentWei??'0')===(b.builderFeeSpentWei??'0');}
export async function exportDatabase(sourcePath:string,targetPath:string,online=false){
  const source=resolve(sourcePath),target=resolve(targetPath);
  if(source===target||existsSync(target)||existsSync(target+'.manifest.json'))throw new Error('导出目标已存在，不能覆盖');
  if(!existsSync(source))throw new Error('源数据库不存在');
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  const db=new DatabaseSync(source,{readOnly:true}),temporary=target+'.'+randomUUID()+'.tmp';
  try{
    if(!online&&inspect(db).activeLeases)throw new Error('本机执行器仍持有租约，请停止 Keeper 后重新导出；演练副本可加 --online');
    await backup(db,temporary);
    const copy=new DatabaseSync(temporary);let summary:Summary;
    try{copy.exec('PRAGMA journal_mode=DELETE');summary=inspect(copy);}finally{copy.close();}
    if(!online&&(summary.activeLeases||inspect(db).activeLeases))throw new Error('导出期间执行器仍在运行，不能用于切换实盘');
    chmodSync(temporary,0o600);renameSync(temporary,target);
    const manifest:Manifest={version:1,createdAt:new Date().toISOString(),sha256:hash(target),cutoverReady:!online,summary};
    writeFileSync(target+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    return manifest;
  }finally{db.close();for(const file of [temporary,temporary+'-wal',temporary+'-shm'])rmSync(file,{force:true});}
}
export async function restoreDatabase(sourcePath:string,targetPath:string){
  const source=resolve(sourcePath),target=resolve(targetPath);
  if(source===target)throw new Error('导入源与运行数据库不能相同');
  const manifest=JSON.parse(readFileSync(source+'.manifest.json','utf8')) as Manifest;
  if(manifest.version!==1||typeof manifest.cutoverReady!=='boolean'||manifest.sha256!==hash(source))throw new Error('迁移文件校验失败，未导入');
  if(existsSync(target+'.import.json')){
    const imported=JSON.parse(readFileSync(target+'.import.json','utf8')) as Manifest;
    if(imported.sha256!==manifest.sha256||!existsSync(target))throw new Error('该数据库已导入另一份快照，不能覆盖已有状态');
    return {alreadyImported:true,cutoverReady:imported.cutoverReady,summary:imported.summary};
  }
  if(existsSync(target)){
    const existing=new DatabaseSync(target,{readOnly:true});
    try{const summary=inspect(existing);if(summary.activeLeases||tables.some(table=>summary.counts[table]!>0))throw new Error('运行数据库已有记录，不能覆盖；请核对迁移目标');}finally{existing.close();}
  }
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  const db=new DatabaseSync(source,{readOnly:true}),temporary=target+'.'+randomUUID()+'.tmp';
  try{
    const expected=inspect(db);
    if(!sameSpend(expected,manifest.summary)||tables.some(t=>expected.counts[t]!== (manifest.summary.counts[t]??0)))throw new Error('迁移清单与数据库记录不符');
    await backup(db,temporary);
    const copy=new DatabaseSync(temporary);
    try{copy.exec('PRAGMA journal_mode=DELETE; DELETE FROM leases;');const after=inspect(copy);if(!sameSpend(after,expected))throw new Error('导入交易与 Gas 记录校验失败');}finally{copy.close();}
    chmodSync(temporary,0o600);
    for(const suffix of ['-wal','-shm'])rmSync(target+suffix,{force:true});
    renameSync(temporary,target);
    writeFileSync(target+'.import.json',JSON.stringify({...manifest,importedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
    return {alreadyImported:false,cutoverReady:manifest.cutoverReady,summary:expected};
  }finally{db.close();for(const file of [temporary,temporary+'-wal',temporary+'-shm'])rmSync(file,{force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);
  const [command,source,target,...options]=process.argv.slice(2);
  if(!source||!target||!['export','restore'].includes(command??'')||options.some(o=>o!=='--online'))throw new Error('用法：migrate-db.ts export|restore 源数据库 目标数据库 [--online]');
  const result=command==='export'?await exportDatabase(source,target,options.includes('--online')):await restoreDatabase(source,target);
  console.log(JSON.stringify(result));
}
