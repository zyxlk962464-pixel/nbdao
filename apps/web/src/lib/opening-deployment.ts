import {keccak256,type Address,type Hex} from 'viem';
export const OPENING_DEPLOY_HASH='0x65a1988e6969433a155d273d8ccd1a258ccfb523b7dca5c22437e20502a92587' as Hex;
export const OPENING_DEPLOY_CAP=500000000000000n;
export type OpeningDeploymentPlan={owner:Address;bytecode:Hex;bytecodeHash:Hex;nonce:number;gasLimit:string;gasPriceWei:string;maxFeeWei:string;checkedAt:number;walletRpcUrl:string};
export type OpeningDeploymentReceipt={state:'pending'|'reverted'|'confirmed';hash:Hex;contractAddress?:Address;blockNumber?:string;feeWei?:string;reason:string};
export function openingDeploymentCost(estimate:bigint,price:bigint,balance:bigint){
  if(estimate<=0n||price<=0n)throw new Error('部署 Gas 估算无效');
  const gasLimit=(estimate*120n+99n)/100n,maxFee=gasLimit*price;
  if(maxFee>OPENING_DEPLOY_CAP)throw new Error('部署最高费用超过 0.0005 BNB');
  if(balance<maxFee)throw new Error('钱包 BNB 余额不足以覆盖部署最高费用');
  return {gasLimit,maxFee};
}
export function assertOpeningDeploymentPlan(p:OpeningDeploymentPlan,owner:Address){
  if(p.owner.toLowerCase()!==owner.toLowerCase()||p.bytecodeHash!==OPENING_DEPLOY_HASH||keccak256(p.bytecode)!==OPENING_DEPLOY_HASH||!Number.isSafeInteger(p.nonce)||p.nonce<0||BigInt(p.gasLimit)<=0n||BigInt(p.gasPriceWei)<=0n||BigInt(p.maxFeeWei)!==BigInt(p.gasLimit)*BigInt(p.gasPriceWei)||BigInt(p.maxFeeWei)>OPENING_DEPLOY_CAP)throw new Error('部署代码、钱包或费用不匹配');
}
