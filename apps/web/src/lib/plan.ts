import { decimal, floorFromTotal, type AppConfig, type PlanInput, type Policy, type WalletSnapshot } from '@nbdao/shared';

export type FormValues = {
  windowMinutes: string; minimumUSDT: string; extraTokens: string; dustTokens: string;
  maxChunks: string; slippagePercent: string; gasBudgetBNB: string; maxTxGasBNB: string;
  maxGasGwei: string; minEconomicUSDT: string;
};
export function initialForm(): FormValues {
  return { windowMinutes: '60', minimumUSDT: '', extraTokens: '0', dustTokens: '0.000001',
    maxChunks: '128', slippagePercent: '1', gasBudgetBNB: '0.02', maxTxGasBNB: '0.002', maxGasGwei: '3', minEconomicUSDT: '0.1' };
}
function integer(value: string, min: number, max: number, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${label}须为整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}须在 ${min}–${max} 之间`);
  return number;
}
function chainTime(value: number | bigint | string) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('链上时间不可用，请重新读取后再创建任务');
  return timestamp;
}
/** Rebind only the monitoring window; never recalculate amounts or signed service conditions. */
export function bindPlanStart(plan: PlanInput, startTimestamp: number | bigint | string): PlanInput {
  const duration = plan.expiresAt - plan.notBefore;
  if (!Number.isSafeInteger(duration) || duration < 60 || duration > 1440 * 60 || duration % 60 !== 0) throw new Error('监控时长须在 1–1440 分钟之间');
  const notBefore = chainTime(startTimestamp);
  const expiresAt = notBefore + duration;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('链上时间不可用，请重新读取后再创建任务');
  return { ...plan, notBefore, expiresAt };
}
export function buildPlan(form: FormValues, wallet: WalletSnapshot, config: AppConfig, startTimestamp: number | bigint | string = wallet.timestamp): PlanInput {
  if (!config.ready || !config.sellerAddress || !config.executor) throw new Error('部署与执行服务配置尚未就绪');
  const balance = BigInt(wallet.tokenBalance);
  if (balance <= 0n) throw new Error('钱包暂无可卖出的 NBDAO');
  const totalMinimum = decimal(form.minimumUSDT);
  if (totalMinimum <= 0n) throw new Error('请设置大于 0 的卖出后最低获得金额');
  const notBefore = chainTime(startTimestamp);
  const expiresAt = notBefore + integer(form.windowMinutes, 1, 1440, '监控时长分钟数') * 60;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('链上时间不可用，请重新读取后再创建任务');
  const maxTotalInput = balance + decimal(form.extraTokens);
  const minUSDTPerToken = floorFromTotal(totalMinimum, balance);
  if (maxTotalInput >= 2n ** 256n || minUSDTPerToken >= 2n ** 256n) throw new Error('授权额度或最低单价超过合约可表示范围');
  const maxDustTokens = decimal(form.dustTokens);
  if (maxDustTokens >= balance) throw new Error('余币阈值须小于当前余额');
  const policy = buildPolicy(form);
  const maxGas = decimal(form.maxGasGwei, 9);
  if (maxGas <= 0n) throw new Error('Gas 单价上限须大于 0');
  return { owner: wallet.owner, executor: config.executor, notBefore, expiresAt, maxChunks: integer(form.maxChunks, 1, 256, '最多批数'),
    maxTotalInput: maxTotalInput.toString(), minUSDTPerToken: minUSDTPerToken.toString(), maxDustTokens: maxDustTokens.toString(), maxGasPrice: maxGas.toString(), policy };
}
export function buildPolicy(form: FormValues): Policy {
  if (!/^\d+(?:\.\d{1,2})?$/.test(form.slippagePercent)) throw new Error('滑点须为 0–30%，最多两位小数');
  const slippage = Number(form.slippagePercent);
  const slippageBps = Math.round(slippage * 100);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 30 || Math.abs(slippage * 100 - slippageBps) > 1e-8) throw new Error('滑点须为 0–30%，最多两位小数');
  const gasBudget = decimal(form.gasBudgetBNB);
  const maxTxGas = decimal(form.maxTxGasBNB);
  if (gasBudget <= 0n || maxTxGas <= 0n || maxTxGas > gasBudget) throw new Error('Gas 预算须大于 0，且单笔上限不得超过总预算');
  return { slippageBps, maxAttempts: 20, gasBudgetWei: gasBudget.toString(), maxTxGasWei: maxTxGas.toString(),
    minEconomicUSDT: decimal(form.minEconomicUSDT).toString(), confirmations: 3, maxQuoteAgeBlocks: 3 };
}
