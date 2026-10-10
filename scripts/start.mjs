import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const children=[];let stopping=false;let exitCode=0;let shutdownTimer;
function shutdown(code=0){
  if(stopping)return;stopping=true;exitCode=code;
  for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
  shutdownTimer=setTimeout(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');},15000);
  shutdownTimer.unref();
}
function run(args,cwd,env){
  const child=spawn(process.execPath,args,{cwd,env,stdio:'inherit'});children.push(child);
  child.once('error',()=>shutdown(1));
  child.once('exit',()=>{if(!stopping)shutdown(1);if(children.every(c=>c.exitCode!==null||c.signalCode!==null)){clearTimeout(shutdownTimer);process.exit(exitCode);}});
}
const common={...process.env,NODE_ENV:'production',KEEPER_HOST:'127.0.0.1',KEEPER_PORT:String(keeperPort)};
const webEnv={...common,PORT:String(port),KEEPER_API_URL:`http://127.0.0.1:${keeperPort}`};
delete webEnv.KEEPER_PRIVATE_KEY;delete webEnv.DEPLOYER_PRIVATE_KEY;
run(['--import','tsx','apps/keeper/src/main.ts'],root,common);
run([resolve(root,'apps/web/node_modules/next/dist/bin/next'),'start','--hostname','0.0.0.0','--port',String(port)],resolve(root,'apps/web'),webEnv);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>shutdown(0));
