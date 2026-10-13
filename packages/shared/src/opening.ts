import type { Address,Hex } from 'viem';

export const OPENING_GAS_CEILING=1_500_000n;
export const OPENING_TRANSACTION_GAS=1_450_000n;
export const OPENING_WINDOW_SECONDS=12;
export const OPENING_BUILDER='0x4848489f0b2bedd788c696e2d79b6b69d7484848' as Address;
export type OpeningTaskParams={executor:Address;notBefore:bigint;expiresAt:bigint;maxTotalInput:bigint;minTotalUSDT:bigint;maxBuilderFeeWei:bigint;maxExecutionCostWei:bigint;maxGasPrice:bigint};
export type OpeningPolicy={totalCostWei:string;setupTxHashes:Hex[];gasPriceWei:string;builderFeeWei:string;confirmations:3};
export type OpeningTaskView={
  taskId:Hex;owner:Address;executor:Address;status:number;notBefore:string;expiresAt:string;
  maxTotalInput:string;minTotalUSDT:string;maxBuilderFeeWei:string;maxExecutionCostWei:string;maxGasPrice:string;
  soldInput:string;receivedUSDT:string;residual:string;gasSpentWei:string;builderFeeSpentWei:string;
  setupGasWei:string;serviceStatus:string;reason:string;attempts:number;txHash:Hex|null;policy:OpeningPolicy|null;
};
export function openingPolicyMessage(chainId:number,seller:Address,taskId:Hex,p:OpeningPolicy){
  const policy={totalCostWei:p.totalCostWei,setupTxHashes:p.setupTxHashes.map(h=>h.toLowerCase()),gasPriceWei:p.gasPriceWei,builderFeeWei:p.builderFeeWei,confirmations:p.confirmations};
  return `NBDAO 指定日期 08:00 抢卖服务确认\nChain ID: ${chainId}\n执行合约: ${seller.toLowerCase()}\n任务: ${taskId.toLowerCase()}\n服务参数: ${JSON.stringify(policy)}\nBNB 总预算包含本次授权、创建任务、执行 Gas 和抢排序费。仅向固定 48 Club 构建者投递；最低 USDT 为实际到账，不扣除 BNB 成本。不保证首块或首笔成交，窗口到期不再重试。`;
}
