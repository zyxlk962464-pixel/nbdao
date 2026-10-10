import { spawn } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chownSync, chmodSync, existsSync, mkdirSync, lstatSync } from 'node:fs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
try{process.loadEnvFile(resolve(root,'.env'));}catch{}
process.umask(0o077);
const port=Number(process.env.PORT??3000),keeperPort=Number(process.env.KEEPER_PORT??8787);
for(const value of [port,keeperPort])if(!Number.isSafeInteger(value)||value<1||value>65535)throw new Error('服务端口必须是 1–65535 的整数');
if(port===keeperPort)throw new Error('网页端口不能与 Keeper 端口相同');

// Import happens before either service opens SQLite. No key is used by this operation.
if(process.env.KEEPER_IMPORT_FILE){
  const result=await new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','scripts/migrate-db.ts','restore',process.env.KEEPER_IMPORT_FILE,process.env.KEEPER_DATABASE??'/data/keeper.sqlite'],{cwd:root,env:process.env,stdio:'inherit'});
    child.once('error',reject);child.once('exit',resolveResult);
  });
  if(result!==0)throw new Error('数据库导入失败，未启动执行服务');
}

// Root only initializes permissions and supervises signals. Both application children drop privileges.
const isolated=process.env.RUNTIME_ISOLATION==='1';
const keeperIdentity=isolated?{uid:1002,gid:1002}:{};
const webIdentity=isolated?{uid:1001,gid:1001}:{};
if(isolated){
  if(process.platform!=='linux'||process.getuid?.()!==0)throw new Error('隔离镜像必须由初始化进程启动，不能静默回退到共享权限');
  const database=resolve(root,process.env.KEEPER_DATABASE??'/data/keeper.sqlite');
  const mount=resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH??dirname(database));
  const path=relative(mount,database);
  if(!path||path==='..'||path.startsWith('../')||isAbsolute(path))throw new Error('数据库必须位于执行服务目录内');
  function privatePath(path,identity,directory=false){
    if(directory)mkdirSync(path,{recursive:true,mode:0o700});
    if(lstatSync(path).isSymbolicLink())throw new Error('私有运行路径不能是符号链接');
    chownSync(path,identity.uid,identity.gid);chmodSync(path,directory?0o700:0o600);
  }
  privatePath(mount,keeperIdentity,true);
  let current=dirname(database);
  while(current!==mount){privatePath(current,keeperIdentity,true);current=dirname(current);}
  for(const suffix of ['', '-wal', '-shm', '.import.json'])if(existsSync(database+suffix))privatePath(database+suffix,keeperIdentity);
  privatePath('/tmp/nbdao-keeper',keeperIdentity,true);privatePath('/tmp/nbdao-web',webIdentity,true);
}

const children=[];let stopping=false;let exitCode=0;let shutdownTimer;
function shutdown(code=0){
  if(stopping)return;stopping=true;exitCode=code;
  for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
  shutdownTimer=setTimeout(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');},15000);
  shutdownTimer.unref();
}
function run(args,cwd,env,identity){
  const child=spawn(process.execPath,args,{cwd,env,stdio:'inherit',...identity});children.push(child);
  child.once('error',()=>shutdown(1));
  child.once('exit',()=>{if(!stopping)shutdown(1);if(children.every(c=>c.exitCode!==null||c.signalCode!==null)){clearTimeout(shutdownTimer);process.exit(exitCode);}});
}
const common={...process.env,NODE_ENV:'production',KEEPER_HOST:'127.0.0.1',KEEPER_PORT:String(keeperPort)};
const webEnv={...common,PORT:String(port),KEEPER_API_URL:`http://127.0.0.1:${keeperPort}`};
delete webEnv.KEEPER_PRIVATE_KEY;delete webEnv.DEPLOYER_PRIVATE_KEY;
// Account/CLI credentials are not required by either application at runtime.
for(const key of Object.keys(webEnv))if(/(?:PRIVATE_KEY|MNEMONIC|RAILWAY_TOKEN|RAILWAY_API_TOKEN|GITHUB_TOKEN|GH_TOKEN)/i.test(key))delete webEnv[key];
if(isolated){common.TMPDIR='/tmp/nbdao-keeper';webEnv.TMPDIR='/tmp/nbdao-web';}
run(['--import','tsx','apps/keeper/src/main.ts'],root,common,keeperIdentity);
run([resolve(root,'apps/web/node_modules/next/dist/bin/next'),'start','--hostname','0.0.0.0','--port',String(port)],resolve(root,'apps/web'),webEnv,webIdentity);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>shutdown(0));
