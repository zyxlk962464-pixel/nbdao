import { createServer } from 'node:http';
import { isAddress, recoverMessageAddress, type Address } from 'viem';
import { policyMessage,stringify,ZERO_ID,type PlanInput } from '../../../packages/shared/src/index.js';
import { runtime } from './config.js';
import { Store } from './store.js';
import { Chain,message } from './chain.js';
import { Optimizer } from './optimizer.js';
import { Worker } from './worker.js';
import { plan,policy,taskId } from './validation.js';
import { assertOwnerAllowed,assertTaskAllowed } from './access.js';
import { ReadGate } from './read-gate.js';
process.umask(0o077);
const config=runtime(),store=new Store(config.database),chain=new Chain(config),optimizer=new Optimizer(config,chain),worker=new Worker(config,chain,optimizer,store);
const rates=new Map<string,{start:number;count:number}>();
const reads=new ReadGate();
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
    // Health polling has its own cheap path; a public read flood must not make a healthy worker fail healthchecks.
    if(req.method==='GET'&&req.url==='/status'){res.end(stringify({status:'ok',mode:config.app.mode,ready:config.app.ready,monitor:worker.status()}));return;}
    const ip=`${req.socket.remoteAddress??'local'}:${req.method==='GET'?'read':'write'}`,now=Date.now(),limit=rates.get(ip);if(!limit||now-limit.start>60000)rates.set(ip,{start:now,count:1});else if(++limit.count>(req.method==='GET'?600:120)){res.statusCode=429;throw new Error('请求过于频繁');}
    const url=new URL(req.url??'/','http://localhost');const parts=url.pathname.split('/').filter(Boolean);let body:unknown;
    if(req.method==='POST'){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>32768){res.statusCode=413;throw new Error('请求体过大');}chunks.push(bytes);}body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
    let result:unknown;
    if(req.method==='GET'&&url.pathname==='/config')result={...config.app,monitor:worker.status()};
    else if(req.method==='GET'&&url.pathname==='/status')result={status:'ok',mode:config.app.mode,ready:config.app.ready};
    else if(req.method==='GET'&&url.pathname==='/price')result=await reads.run('price',()=>chain.price());
    else if(req.method==='GET'&&url.pathname==='/tax')result=await reads.run('tax',()=>chain.tax());
    else if(req.method==='GET'&&url.pathname==='/health'){result={mode:config.app.mode,ready:config.app.ready,missing:config.app.missing,...await chain.health()};}
    else if(req.method==='GET'&&parts[0]==='wallet'&&isAddress(parts[1]??'')){assertOwnerAllowed(config,parts[1]!);result=await reads.run(url.pathname,()=>chain.wallet(parts[1] as Address));}
    else if(req.method==='GET'&&parts[0]==='task'){const id=taskId(parts[1]);result=await reads.run(url.pathname,async()=>{assertOwnerAllowed(config,(await chain.rawTask(id)).owner);return chain.view(id,store);});}
    else if(req.method==='GET'&&parts[0]==='tasks'&&isAddress(parts[1]??'')){const owner=parts[1] as Address;assertOwnerAllowed(config,owner);result=await reads.run(url.pathname,async()=>{const ids=store.tasks(owner).map(t=>t.id);if(config.app.sellerAddress){const active=await chain.client.readContract({address:config.app.sellerAddress,abi:(await import('../../../packages/shared/src/index.js')).executorAbi,functionName:'activeTaskId',args:[owner]});if(active!==ZERO_ID&&!ids.includes(active))ids.unshift(active);}return {tasks:await Promise.all(ids.map(id=>chain.view(id,store)))};});}
    else if(req.method==='POST'&&url.pathname==='/quote'){if(config.cloud||config.app.mode==='live'){res.statusCode=403;throw new Error('云端与实盘报价仅由执行监控触发');}const b=body as {plan:unknown;taskId?:unknown};const p=plan(b.plan),id=b.taskId?taskId(b.taskId):undefined;assertOwnerAllowed(config,p.owner);if(id){const t=await chain.rawTask(id);if(t.owner.toLowerCase()!==p.owner.toLowerCase()||t.params.executor.toLowerCase()!==p.executor.toLowerCase())throw new Error('任务与钱包不匹配');}result=await optimizer.quote(p,id);store.saveQuote((result as {id:string}).id,id,result);}
    else if(req.method==='POST'&&url.pathname==='/tasks/register'){
      const b=body as {taskId:unknown;policy:unknown;message:unknown;signature:unknown};const id=taskId(b.taskId),p=policy(b.policy);if(!config.app.sellerAddress)throw new Error('执行合约未配置');const t=await chain.rawTask(id);assertTaskAllowed(config,t);if(t.status<1||t.status>2)throw new Error('链上任务不存在或已结束');if((await chain.client.getBlock()).timestamp>=t.params.expiresAt)throw new Error('监控窗口已到期，请创建新任务');const expected=policyMessage(config.app.chainId,config.app.sellerAddress,id,p);if(b.message!==expected||typeof b.signature!=='string')throw new Error('签名消息不匹配');const signer=await recoverMessageAddress({message:expected,signature:b.signature as `0x${string}`});if(signer.toLowerCase()!==t.owner.toLowerCase())throw new Error('服务参数必须由任务 owner 签名');const existing=store.task(id);store.register(id,t.owner,p);if(!existing)worker.wake();result=await chain.view(id,store);
    }else{res.statusCode=404;throw new Error('接口不存在');}
    res.end(stringify(result));
  }catch(e){if(res.statusCode===200)res.statusCode=400;res.end(stringify({error:message(e)}));}
});
server.listen(config.port,config.host,()=>{console.log(`Keeper http://${config.host}:${config.port} · ${config.app.mode} · ${config.app.ready?'配置就绪':config.app.missing.join('、')}`);worker.start();});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(stopping)return;stopping=true;optimizer.close();const stopped=worker.stop();server.close(()=>{void stopped.then(()=>{store.close();process.exit(0);});});});
