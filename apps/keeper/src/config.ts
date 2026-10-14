import { existsSync, readFileSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { BSC, type Addresses, type AppConfig } from '../../../packages/shared/src/index.js';
export const ROOT = resolve(import.meta.dirname, '../../..');
try { process.loadEnvFile(resolve(ROOT, '.env')); } catch { /* optional */ }
export const LOCAL_EXECUTOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
export const LOCAL_OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
export type Runtime = { app: AppConfig; openingSeller?:Address; allowedOwner?: Address; cloud?: boolean; rpcUrls: string[]; historyRpcUrls?:string[]; forkRpc: string; key?: Hex; database: string; baselineFile: string; price: bigint|null; priceOracle?: Address; usdtOracle?: Address; priceMaxAge: number; pollMs: number; quoteTimeoutMs: number; deploymentBlock: bigint; host: string; port: number };
export function runtime(): Runtime {
  const mode = (process.env.SELLER_MODE ?? 'read-only') as AppConfig['mode'];
  if (!['read-only','local','live'].includes(mode)) throw new Error('SELLER_MODE 必须为 read-only、local 或 live');
  const localPath = resolve(ROOT, 'data/local.json');
  const local = mode==='local' && existsSync(localPath) ? JSON.parse(readFileSync(localPath,'utf8')) : null;
  const chainId = mode==='local' ? 31337 : 56;
  const pollMs=Number(process.env.KEEPER_POLL_MS??500);
  if(!Number.isSafeInteger(pollMs)||pollMs<100||pollMs>60000)throw new Error('KEEPER_POLL_MS 须为 100–60000 毫秒的整数');
  const rpcUrls = (process.env.RPC_URLS?.trim() || process.env.BSC_RPC_URL?.trim() || (mode==='local'?'http://127.0.0.1:8545':'https://bsc-dataseed.bnbchain.org')).split(',').map(s=>s.trim()).filter(Boolean);
  const historyRpcUrls=(process.env.SALE_HISTORY_RPC_URLS??'').split(',').map(value=>value.trim()).filter(Boolean);
  if(historyRpcUrls.some(value=>{try{return !['http:','https:'].includes(new URL(value).protocol);}catch{return true;}}))throw new Error('SALE_HISTORY_RPC_URLS 必须是 HTTP 或 HTTPS 历史 RPC 地址');
  if(mode==='local' && rpcUrls.some(url=>{try{const u=new URL(url);return !['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol);}catch{return true;}}))throw new Error('local 模式 RPC_URLS 必须使用 loopback 测试节点，如 http://127.0.0.1:8545');
  const seller = process.env.SELLER_ADDRESS?.trim() || local?.sellerAddress;
  const openingValue=process.env.OPENING_SELLER_ADDRESS?.trim();
  if(openingValue&&!isAddress(openingValue))throw new Error('OPENING_SELLER_ADDRESS 必须是有效的抢卖合约地址');
  const openingSeller=openingValue?getAddress(openingValue):undefined;
  const rawKey = process.env.KEEPER_PRIVATE_KEY?.trim() || (mode==='local' ? LOCAL_EXECUTOR_KEY : undefined);
  const key = rawKey && /^0x[\da-fA-F]{64}$/.test(rawKey) ? rawKey as Hex : undefined;
  const account = key ? privateKeyToAccount(key) : null;
  const executor = account?.address ?? (isAddress(process.env.EXECUTOR_ADDRESS??'')?getAddress(process.env.EXECUTOR_ADDRESS!):null);
  const ownerValue=process.env.ALLOWED_OWNER_ADDRESS?.trim();
  if(ownerValue&&!isAddress(ownerValue))throw new Error('ALLOWED_OWNER_ADDRESS 必须是有效的钱包地址');
  const allowedOwner=ownerValue?getAddress(ownerValue):mode==='live'?executor??undefined:undefined;
  const cloud=Boolean(process.env.RAILWAY_ENVIRONMENT_ID||process.env.RAILWAY_PROJECT_ID);
  const database=resolve(ROOT,process.env.KEEPER_DATABASE??'data/keeper.sqlite');
  const missing:string[]=[];
  if (!seller || !isAddress(seller)) missing.push('SELLER_ADDRESS');
  if (!executor) missing.push('EXECUTOR_ADDRESS / KEEPER_PRIVATE_KEY');
  if (mode==='local' && !local) missing.push('请先运行 pnpm demo');
  if (mode==='live' && !key) missing.push('KEEPER_PRIVATE_KEY');
  if (mode==='live' && !allowedOwner) missing.push('ALLOWED_OWNER_ADDRESS');
  if (mode==='live' && rpcUrls.length<2) missing.push('至少两个 RPC_URLS');
  const baselineFile=resolve(ROOT,process.env.DEPENDENCY_BASELINE??'docs/evidence/chain-check.json');
  if (mode==='live' && !existsSync(baselineFile)) missing.push('DEPENDENCY_BASELINE');
  if (mode==='live' && !process.env.DEPLOYMENT_BLOCK) missing.push('DEPLOYMENT_BLOCK');
  if (mode==='live' && process.env.LIVE_EXECUTION!=='I_UNDERSTAND') missing.push('LIVE_EXECUTION=I_UNDERSTAND');
  let price:bigint|null=null;
  if (mode==='local') price=BigInt(local?.bnbPrice??'600000000000000000000');
  const oracle=isAddress(process.env.BNB_USDT_ORACLE??'')?getAddress(process.env.BNB_USDT_ORACLE!):undefined;
  if (mode==='live' && !oracle) missing.push('BNB_USDT_ORACLE');
  if(cloud&&mode==='live'){
    const mount=process.env.RAILWAY_VOLUME_MOUNT_PATH;
    const path=mount?relative(resolve(mount),database):'..';
    if(!mount||!existsSync(mount)||path==='..'||path.startsWith('../')||isAbsolute(path))missing.push('KEEPER_DATABASE 必须位于 Railway 持久卷');
    if(process.env.EXECUTION_HANDOFF!=='LOCAL_KEEPER_STOPPED')missing.push('停止本机 Keeper 后设置 EXECUTION_HANDOFF=LOCAL_KEEPER_STOPPED');
    let imported=false;try{imported=JSON.parse(readFileSync(database+'.import.json','utf8')).cutoverReady===true;}catch{}
    if(!imported)missing.push('先导入停止本机执行后的完整数据库快照');
  }
  const openingMissing=[...missing,...(!openingSeller?['OPENING_SELLER_ADDRESS 尚未部署或配置']:[]),...(mode!=='live'?['指定日期抢卖仅在明确启用的 live 模式可执行']:[])];
  return {app:{mode,chainId,chainName:mode==='local'?'本地演练 · 31337':'BNB Smart Chain',addresses:(local?.addresses??BSC) as Addresses,sellerAddress:seller&&isAddress(seller)?getAddress(seller):null,executor,walletRpcUrl:mode==='local'?rpcUrls[0]!:(process.env.WALLET_RPC_URL??'https://bsc-dataseed.bnbchain.org'),explorerUrl:mode==='local'?'':'https://bscscan.com',ready:missing.length===0,missing,blockPollMs:pollMs,openingSellerAddress:openingSeller??null,openingReady:openingMissing.length===0,openingMissing},openingSeller,allowedOwner,cloud,rpcUrls,historyRpcUrls,forkRpc:mode==='local'?rpcUrls[0]!:process.env.FORK_RPC_URL?.trim()||rpcUrls[0]!,key,database,baselineFile,price,priceOracle:oracle,usdtOracle:isAddress(process.env.USDT_USD_ORACLE??'')?getAddress(process.env.USDT_USD_ORACLE!):undefined,priceMaxAge:Number(process.env.ORACLE_MAX_AGE_SECONDS??3600),pollMs,quoteTimeoutMs:Number(process.env.QUOTE_TIMEOUT_MS??90000),deploymentBlock:BigInt(process.env.DEPLOYMENT_BLOCK?.trim()||local?.deploymentBlock||0),host:process.env.KEEPER_HOST??'127.0.0.1',port:Number(process.env.KEEPER_PORT??8787)};
}
