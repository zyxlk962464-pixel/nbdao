import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** Fixed cap: the deployment itself may consume at most 0.00015 BNB. */
export const DEPLOYMENT_FEE_CAP_WEI = 150_000_000_000_000n;
export function deploymentCost(estimatedGas:bigint,gasPrice:bigint){
  if(estimatedGas<=0n||gasPrice<=0n)throw new Error('部署 Gas 估算或价格无效');
  const gas=(estimatedGas*120n+99n)/100n;
  const maxFeeWei=gas*gasPrice;
  return {estimatedGas,gas,gasPrice,maxFeeWei,capWei:DEPLOYMENT_FEE_CAP_WEI,withinCap:maxFeeWei<=DEPLOYMENT_FEE_CAP_WEI};
}
export function requireDeploymentBudget(cost:ReturnType<typeof deploymentCost>,balance:bigint,pendingNonce:number,latestNonce:number){
  if(!cost.withinCap)throw new Error('部署最高费用超过固定 0.00015 BNB 上限；停止，不自动提高预算');
  if(balance<cost.maxFeeWei)throw new Error('部署账户 BNB 不足以覆盖本笔最高费用；停止');
  if(!Number.isSafeInteger(pendingNonce)||!Number.isSafeInteger(latestNonce)||pendingNonce<0||pendingNonce!==latestNonce)throw new Error('部署账户存在未确认交易或 nonce 异常；停止，先核验现有交易');
}
export function requireNoDeploymentRecord(paths:string[]){if(paths.some(path=>existsSync(path)))throw new Error('已有部署记录或部署意图。禁止再次广播；请先按记录 hash/账户 nonce 人工核验链上回执，不要直接重跑或删除意图文件');}
export function reserveDeploymentIntent(path:string,value:string){mkdirSync(dirname(path),{recursive:true});try{writeFileSync(path,value,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('已有部署意图，禁止重复签名或广播；请人工核验链上回执');throw error;}}
