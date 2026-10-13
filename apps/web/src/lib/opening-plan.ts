import { beijingSeconds, decimal, type AppConfig, type OpeningPolicy, type WalletSnapshot } from '@nbdao/shared';
import type { Address, Hex } from 'viem';

export const OPENING_WINDOW_SECONDS = 12;
export const OPENING_CREATE_GAS = 300_000n;
export const OPENING_EXECUTION_GAS = 1_450_000n;
export const OPENING_GAS_RESERVE = 1_500_000n;
export const OPENING_MAX_GAS_PRICE = 3_000_000_000n;
export type OpeningForm = { date: string; totalBNB: string; minimumUSDT: string };
export type OpeningPlan = {
  owner: Address; executor: Address; notBefore: number; expiresAt: number;
  maxTotalInput: string; minTotalUSDT: string; maxBuilderFeeWei: string;
  maxExecutionCostWei: string; maxGasPrice: string; policy: OpeningPolicy;
};
export function nextOpeningDate(nowSeconds: number) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('链上时间不可用');
  const date = new Date(nowSeconds * 1000 + 8 * 3600_000).toISOString().slice(0, 10);
  return beijingSeconds(date) > nowSeconds ? date : new Date((beijingSeconds(date) + 86400) * 1000 + 8 * 3600_000).toISOString().slice(0, 10);
}
export function openingTimestamp(date: string, nowSeconds: number) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('链上时间不可用，请刷新');
  const timestamp = beijingSeconds(date);
  if (timestamp <= nowSeconds) throw new Error('所选日期的北京时间 08:00 已过，请选择下一次日期');
  return timestamp;
}
export function splitOpeningBudget(totalWei: bigint, setupGasWei: bigint, gasPriceWei: bigint) {
  if (gasPriceWei <= 0n || gasPriceWei > OPENING_MAX_GAS_PRICE) throw new Error('当前 Gas 单价须大于 0 且不高于 3 Gwei，请稍后再试');
  if (totalWei <= 0n || setupGasWei < 0n) throw new Error('BNB 总费用上限须大于 0');
  const createReserveWei = OPENING_CREATE_GAS * gasPriceWei;
  const executionGasReserveWei = OPENING_GAS_RESERVE * gasPriceWei;
  const maxExecutionCostWei = totalWei - setupGasWei - createReserveWei;
  if (maxExecutionCostWei < executionGasReserveWei) throw new Error('BNB 总费用不足以覆盖已花费用、创建任务及执行 Gas，未发送下一笔交易');
  return { createReserveWei, executionGasReserveWei, maxExecutionCostWei, builderFeeWei: maxExecutionCostWei - executionGasReserveWei };
}
export function openingAvailable(config: AppConfig | null) {
  return !!config && config.openingReady === true && !!config.openingSellerAddress && !!config.executor && config.mode !== 'read-only' && [56, 31337].includes(config.chainId);
}
export function buildOpeningPlan(form: OpeningForm, wallet: WalletSnapshot, config: AppConfig, gasPriceWei: bigint, setupGasWei = 0n, setupTxHashes: Hex[] = []): OpeningPlan {
  if (!openingAvailable(config) || !config.executor) throw new Error('08:00 卖出合约尚待部署或执行服务未就绪');
  const balance = BigInt(wallet.tokenBalance);
  if (balance <= 0n) throw new Error('钱包暂无可卖出的 NBDAO');
  const totalWei = decimal(form.totalBNB), minimum = decimal(form.minimumUSDT);
  if (minimum <= 0n) throw new Error('请输入大于 0 的最低到账 USDT');
  if (totalWei > BigInt(wallet.bnbBalance) + setupGasWei) throw new Error('钱包 BNB 不足以覆盖总费用上限');
  const notBefore = openingTimestamp(form.date, Number(wallet.timestamp));
  if (notBefore - Number(wallet.timestamp) < 60) throw new Error('请至少提前 1 分钟完成任务设置，为回执确认和服务登记留出时间');
  const budget = splitOpeningBudget(totalWei, setupGasWei, gasPriceWei);
  return { owner: wallet.owner, executor: config.executor, notBefore, expiresAt: notBefore + OPENING_WINDOW_SECONDS,
    maxTotalInput: balance.toString(), minTotalUSDT: minimum.toString(), maxBuilderFeeWei: budget.builderFeeWei.toString(),
    maxExecutionCostWei: budget.maxExecutionCostWei.toString(), maxGasPrice: gasPriceWei.toString(),
    policy: { totalCostWei: totalWei.toString(), setupTxHashes: [...setupTxHashes], gasPriceWei: gasPriceWei.toString(), builderFeeWei: budget.builderFeeWei.toString(), confirmations: 3 } };
}
