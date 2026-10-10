import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
try { process.loadEnvFile('.env'); } catch {}
const children=[];
function run(command,args){const c=spawn(command,args,{stdio:'inherit',env:process.env});children.push(c);c.once('exit',code=>{if(!stopping){stop();process.exitCode=code??1;}});return c;}
let stopping=false;function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');}
if(process.env.SELLER_MODE==='local'&&!existsSync(resolve('data/local.json')))throw new Error('本地模式请先运行 pnpm demo');
run(process.execPath,['--import','tsx','apps/keeper/src/main.ts']);
run('pnpm',['--filter','@nbdao/web','dev']);
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>stop());
