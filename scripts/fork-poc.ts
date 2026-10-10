import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient,createWalletClient,http,parseAbi,type Address,type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { BSC,tokenAbi,routerAbi,executorAbi,UNIT,minBig,safeChunkCap,stringify } from '../packages/shared/src/index.js';

// Every state-changing request below is sent only to this script's loopback Anvil.
const source=process.env.BSC_ARCHIVE_RPC_URL??process.env.BSC_RPC_URL??'https://bsc-dataseed.bnbchain.org';
const upstream=createPublicClient({chain:bsc,transport:http(source,{timeout:20000,retryCount:1})});
const owner=(process.env.FORK_HOLDER??'0xbB6C066bc80E891d1B5C60654147Dc561Ca14b12') as Address;
const operator='0x1000000000000000000000000000000000000001' as Address;
const block=await upstream.getBlock();
const report:Record<string,unknown>={kind:'real-token-isolated-fork',owner,isUserWallet:false,blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,
  assumptions:['公开持有人样本，不代表用户钱包','仅本地补充 Gas、授权和创建测试任务','不修改 NBDAO 业务存储、不添加白名单、不向上游发送任何交易'],scenarios:[]};
let child:ReturnType<typeof spawn>|undefined;
let tail='';
async function port() { const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return p; }
function brief(e:unknown) { const m=e instanceof Error?e.message:String(e);return m.replace(/https?:\/\/[^\s)]+/g,'[RPC]').slice(0,1400); }
try {
  const n=await port();const url=`http://127.0.0.1:${n}`;
  const binary=existsSync('.tools/anvil')?resolve('.tools/anvil'):'anvil';
  child=spawn(binary,['--host','127.0.0.1','--port',String(n),'--chain-id','56','--fork-url',source,'--fork-block-number',String(block.number),'--block-base-fee-per-gas','0','--gas-price','1000000000','--silent'],{stdio:['ignore','ignore','pipe']});
  child.stderr?.on('data',d=>{tail=(tail+d).slice(-2500);});
  child.on('error',e=>{tail=brief(e);});
  const c=createPublicClient({chain:bsc,transport:http(url,{timeout:30000,retryCount:0})});
  async function rpc<T>(method:string,params:unknown[]=[]):Promise<T> {
    if(!url.startsWith('http://127.0.0.1:'))throw new Error('Local-only write guard');
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
    const v=await r.json() as {result:T;error?:{message:string}};if(v.error)throw new Error(v.error.message);return v.result;
  }
  let available=false;
  for(let i=0;i<80;i++) { try{available=(await rpc<string>('web3_clientVersion')).toLowerCase().includes('anvil');if(available)break;}catch{}await new Promise(r=>setTimeout(r,250)); }
  if(!available)throw new Error('Anvil 无法建立分叉：'+tail);
  console.log('Fork 就绪，读取真实持有人状态');
  if(await c.getChainId()!==56)throw new Error('Fork chain mismatch');
  const [whitelisted,balance,pending]=await Promise.all([
    c.readContract({address:BSC.token,abi:tokenAbi,functionName:'isWL',args:[owner]}),
    c.readContract({address:BSC.token,abi:tokenAbi,functionName:'balanceOf',args:[owner]}),
    c.readContract({address:BSC.token,abi:tokenAbi,functionName:'pending',args:[owner]}),
  ]);
  report.initial={whitelisted,balance,pending};
  if(whitelisted||balance===0n)throw new Error('样本必须是有余额的非白名单持有人');
  const artifact=JSON.parse(readFileSync('packages/contracts/out/NBDAOSeller.sol/NBDAOSeller.json','utf8')) as {abi:typeof executorAbi;bytecode:{object:Hex}};
  for(const a of [owner,operator]) { await rpc('anvil_impersonateAccount',[a]);await rpc('anvil_setBalance',[a,'0x56bc75e2d63100000']); }
  const w=createWalletClient({chain:bsc,transport:http(url),account:operator});
  const uw=createWalletClient({chain:bsc,transport:http(url),account:owner});
  const txFees={type:'legacy' as const,gasPrice:1000000000n};
  report.stage='deploy';console.log('在隔离分叉部署执行合约');
  const dh=await w.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,...txFees});
  const deployed=await c.waitForTransactionReceipt({hash:dh,timeout:30000});
  if(!deployed.contractAddress)throw new Error('本地部署失败');
  const seller=deployed.contractAddress;
  const cap=balance*2n;
  report.stage='approve';
  for(const spender of [seller,BSC.router]) {
    const hash=await uw.writeContract({address:BSC.token,abi:tokenAbi,functionName:'approve',args:[spender,cap],...txFees});
    await c.waitForTransactionReceipt({hash,timeout:30000});
  }
  const now=(await c.getBlock()).timestamp;
  report.stage='createTask';
  const hash=await uw.writeContract({address:seller,abi:executorAbi,functionName:'createTask',...txFees,args:[{
    executor:operator,notBefore:now,expiresAt:now+10n*86400n,maxChunks:32,maxTotalInput:cap,
    minUSDTPerToken:1n,maxDustTokens:0n,maxGasPrice:100000000000n,
  }]});await c.waitForTransactionReceipt({hash,timeout:30000});
  const id=await c.readContract({address:seller,abi:executorAbi,functionName:'activeTaskId',args:[owner]});
  report.seller=seller;report.taskId=id;
  let snapshot=await rpc<Hex>('evm_snapshot');
  const results:Record<string,unknown>[]=[];
  report.scenarios=results;
  async function reset() { await rpc('evm_revert',[snapshot]);snapshot=await rpc<Hex>('evm_snapshot'); }
  async function testScenario(name:string) {
    report.stage=name;console.log(name);
    const fee=await c.readContract({address:BSC.token,abi:tokenAbi,functionName:'getSellFee'});
    const held=await c.readContract({address:BSC.token,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
    const amount=minBig(held,safeChunkCap(fee[2]),10n*UNIT);
    const state=await rpc<Hex>('evm_snapshot');
    const r:Record<string,unknown>={name,fee,amount,time:(await c.getBlock()).timestamp};
    if(amount===0n)throw new Error('No sellable sample input');
    try {
      const h=await uw.writeContract({address:BSC.router,abi:routerAbi,functionName:'swapExactTokensForTokensSupportingFeeOnTransferTokens',...txFees,args:[amount,1n,[BSC.token,BSC.usdt],owner,(await c.getBlock()).timestamp+3600n]});
      const rec=await c.waitForTransactionReceipt({hash:h,timeout:30000});r.router={status:rec.status,gas:rec.gasUsed};
    } catch(e) { r.router={status:'rejected',error:brief(e)}; }
    await rpc('evm_revert',[state]);
    const before=await c.readContract({address:BSC.usdt,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
    try {
      const h=await w.writeContract({address:seller,abi:executorAbi,functionName:'executeChunk',...txFees,args:[owner,id,0,amount,amount/UNIT||1n,(await c.getBlock()).timestamp+3600n]});
      const rec=await c.waitForTransactionReceipt({hash:h,timeout:30000});
      const after=await c.readContract({address:BSC.usdt,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
      const task=await c.readContract({address:seller,abi:executorAbi,functionName:'getTask',args:[id]});
      r.seller={status:rec.status,gas:rec.gasUsed,usdtDelta:after-before,soldInput:task.soldInput,receivedUSDT:task.receivedUSDT};
      if(rec.status==='success'&&(after<=before||task.soldInput!==amount))throw new Error('成交统计不一致');
    } catch(e) { r.seller={status:'rejected',error:brief(e)}; }
    results.push(r);
    report.currentStateResult=results[0];
  }
  await testScenario('原始区块状态');
  await reset();
  // Protocol-only evolution is a controlled scenario; it does not forecast future markets.
  for(let day=1;day<=3;day++) {
    await rpc('evm_setNextBlockTimestamp',[Number((now/86400n+BigInt(day))*86400n+1n)]);
    await rpc('evm_mine');
    for(let call=1;call<=2;call++) {
      const h=await w.writeContract({address:BSC.token,abi:tokenAbi,functionName:'sync',args:[true],...txFees});await c.waitForTransactionReceipt({hash:h,timeout:30000});
      const snap=await rpc<Hex>('evm_snapshot');
      await testScenario(`仅协议演进 第 ${day} 日 第 ${call} 次 sync 后`);
      await rpc('evm_revert',[snap]);
    }
  }
  report.scenarios=results;
  report.currentStateResult=results[0];
  report.successfulControlledScenarios=results.filter(r=>(r.seller as {status?:string})?.status==='success').length;
  report.completed=true;
  console.log(stringify({completed:true,currentState:results[0],successfulControlledScenarios:report.successfulControlledScenarios}));
} catch(e) {
  report.completed=false;report.blocker=brief(e);report.anvilDiagnostics=tail;console.error('真实分叉未通过：',brief(e));process.exitCode=1;
} finally {
  child?.kill('SIGTERM');mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/fork-poc.json',stringify(report));
}
