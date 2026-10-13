'use client';
import {useEffect,useRef,useState} from 'react';
import {useConnection,useWalletClient} from 'wagmi';
import {bsc} from 'viem/chains';
import {type Hex} from 'viem';
import {BSC,display,type AppConfig} from '@nbdao/shared';
import WalletPanel from '../../wallet-panel';
import {OPENING_DEPLOY_HASH,assertOpeningDeploymentPlan,type OpeningDeploymentPlan,type OpeningDeploymentReceipt} from '@/lib/opening-deployment';
import {WalletSession} from '@/lib/wallet-session';

async function read<T>(url:string):Promise<T>{const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(60000)});const data=await response.json();if(!response.ok)throw new Error(data.error||'只读核查失败');return data;}
export default function OpeningDeploy(){
  const connection=useConnection(),wallet=useWalletClient({chainId:56});
  const {address,chainId,status}=connection;
  const [plan,setPlan]=useState<OpeningDeploymentPlan|null>(null),[receipt,setReceipt]=useState<OpeningDeploymentReceipt|null>(null),[hash,setHash]=useState<Hex|null>(null);
  const [intent,setIntent]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[open,setOpen]=useState(false),[hashInput,setHashInput]=useState('');
  const locked=useRef(false),session=useRef(new WalletSession());const generation=session.current.update(`${address??''}:${chainId??''}:${status}:${connection.connector?.uid??''}`);
  const key=address?`nbdao-opening-deployment:${OPENING_DEPLOY_HASH}:${address.toLowerCase()}`:null;
  const connected=status==='connected'&&chainId===56&&!!address;
  const config:AppConfig={mode:'read-only',chainId:56,chainName:'BNB Smart Chain',addresses:BSC,sellerAddress:null,executor:null,walletRpcUrl:plan?.walletRpcUrl||'https://bsc-dataseed.bnbchain.org',explorerUrl:'https://bscscan.com',ready:false,missing:[]};
  useEffect(()=>{setPlan(null);setReceipt(null);setHash(null);setIntent(false);setError('');if(!key)return;try{const raw=localStorage.getItem(key);if(raw){const saved=JSON.parse(raw);setIntent(true);if(/^0x[\da-fA-F]{64}$/.test(saved.hash??''))setHash(saved.hash);}}catch{setIntent(true);setError('部署恢复记录不可用，请核对钱包活动记录，禁止重复部署');}},[key,generation]);
  async function check(tx=hash){if(!address||!tx)return;const id=generation;const result=await read<OpeningDeploymentReceipt>(`/api/opening/deploy?owner=${address}&hash=${tx}`);if(session.current.isCurrent(id))setReceipt(result);}
  useEffect(()=>{if(!hash||!connected||receipt?.state==='confirmed'||receipt?.state==='reverted')return;let stopped=false;const poll=()=>{void check(hash).catch(e=>{if(!stopped)setError(e.message);});};poll();const timer=setInterval(poll,8000);return()=>{stopped=true;clearInterval(timer);};},[hash,connected,generation,receipt?.state]);
  async function prepare(){if(!connected||!address||locked.current||intent)return;locked.current=true;setBusy('正在核对部署与费用');setError('');const id=generation;try{const p=await read<OpeningDeploymentPlan>(`/api/opening/deploy?owner=${address}`);if(!session.current.isCurrent(id))return;assertOpeningDeploymentPlan(p,address);setPlan(p);}catch(e){if(session.current.isCurrent(id))setError((e as Error).message);}finally{locked.current=false;setBusy('');}}
  async function deploy(){if(!connected||!address||!key||!plan||!wallet.data||locked.current||intent)return;locked.current=true;setBusy('请在钱包确认部署交易');setError('');const id=generation;let reserved=false;try{
    const fresh=await read<OpeningDeploymentPlan>(`/api/opening/deploy?owner=${address}`);if(!session.current.isCurrent(id))throw new Error('钱包已变化');
    assertOpeningDeploymentPlan(fresh,address);if(fresh.nonce!==plan.nonce||BigInt(fresh.maxFeeWei)>BigInt(plan.maxFeeWei))throw new Error('部署费用或 nonce 已变化，请重新核对');
    if(localStorage.getItem(key))throw new Error('已有部署意图，请恢复核查');
    const saved=JSON.stringify({owner:address,nonce:fresh.nonce,hash:null});localStorage.setItem(key,saved);if(localStorage.getItem(key)!==saved)throw new Error('无法保存恢复记录，已停止');reserved=true;setIntent(true);
    const tx=await wallet.data.sendTransaction({account:address,chain:bsc,data:fresh.bytecode,value:0n,nonce:fresh.nonce,gas:BigInt(fresh.gasLimit),gasPrice:BigInt(fresh.gasPriceWei),type:'legacy'});
    localStorage.setItem(key,JSON.stringify({owner:address,nonce:fresh.nonce,hash:tx}));if(session.current.isCurrent(id))setHash(tx);
  }catch(e){const x=e as {code?:number;cause?:{code?:number};message?:string};if(reserved&&(x.code===4001||x.cause?.code===4001)){localStorage.removeItem(key);if(session.current.isCurrent(id))setIntent(false);}if(session.current.isCurrent(id))setError(x.message||'钱包请求未完成，请核对活动记录');}finally{locked.current=false;setBusy('');}}
  return <div className="app-shell"><main><a href="/opening">← 返回日期抢卖</a><section className="panel plan-panel"><p className="eyebrow">新版执行合约</p><h1>部署 08:00 抢卖合约</h1><p>一次性部署费用单独支付，不计入之后某次任务的 BNB 预算。此操作不会授权代币或创建抢卖任务。</p>
    <WalletPanel config={config} wallet={null} fresh={false} refreshing={false} busy={!!busy} refresh={async()=>{}} open={open} setOpen={setOpen}/>
    {plan&&<p>本次部署最高费用 <strong>{display(plan.maxFeeWei,8)} BNB</strong>，钱包将显示实际交易。</p>}
    <button className="button" disabled={!connected||!!busy||intent} onClick={()=>void prepare()}>核对部署费用</button>{plan&&<button className="button primary" disabled={!connected||!!busy||intent} onClick={()=>void deploy()}>在钱包确认部署</button>}
    {busy&&<p role="status">{busy}</p>}{error&&<p role="alert" className="inline-error">{error}</p>}{hash&&<p><a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer">查看部署交易</a></p>}
    {intent&&!hash&&<label className="field"><span>恢复部署交易 hash</span><input value={hashInput} onChange={e=>setHashInput(e.target.value)} placeholder="从钱包活动记录复制 0x…"/><button className="button" disabled={!/^0x[\da-fA-F]{64}$/.test(hashInput)||!!busy} onClick={()=>{const tx=hashInput as Hex;if(key)localStorage.setItem(key,JSON.stringify({hash:tx}));setHash(tx);}}>只读核对，不重新提交</button></label>}
    {receipt&&<p role="status">{receipt.reason}</p>}{receipt?.contractAddress&&<><p>新版合约：<code>{receipt.contractAddress}</code></p><p>部署完成后，将此地址配置为云端 OPENING_SELLER_ADDRESS，即可在日期页面创建任务。</p></>}
  </section></main></div>;
}
