import { parseAbi, parseUnits, formatUnits, type Address, type Hex } from 'viem';
export { executorAbi } from './executor-abi.ts';
export { openingExecutorAbi } from './opening-executor-abi.ts';
export * from './api.ts';
export * from './opening.ts';

export const BSC = {
  token: '0x63d1eacebb70bbbf0641e7c88e9099301bba3688',
  usdt: '0x55d398326f99059ff775485246999027b3197955',
  pair: '0x17662cadea9e98a5a660ca1fe993f136d3cb0ae1',
  router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
  factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
  fund: '0xe384b8c558513b50865de6fae8d56a27bc8be7ac',
  autoSwap: '0x3d0c49b3187b869a40fc88a98b2ae1b9efd2fca1',
  wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
} as const satisfies Record<string, Address>;
export type Addresses = { [K in keyof typeof BSC]: Address };
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)', 'function decimals() view returns (uint8)',
  'function pending(address) view returns (uint256)', 'function reward(address)', 'function sync(bool)',
  'function basePair() view returns (address)', 'function launched() view returns (bool)',
  'function isWL(address) view returns (bool)', 'function getSellFee() view returns (uint256,bool,uint256)',
  'function lastDayReserves() view returns (uint256,uint256,uint256,uint256)',
  'function lastMiningDay() view returns (uint256)',
  'function info() view returns (uint256 accERC20PerPower,uint256 totalPower,uint256 startTime,uint256 usdtAmount,uint256 tokenAmount,uint256 miningRate,uint256 burnRate,uint256 miningAmount,uint256 burnAmount,uint256 totalSupply,uint256 remainSupply,uint256 deadTotal,uint256 todayAmount,uint256 dailyLimit)',
  'function userInfo(address) view returns (address inviter,uint256 id,uint256 tOwnedU,uint256 lpAmount,uint256 orderUsdtAmount,uint256 bnbAmount,uint256 power,uint256 lastReleaseDay,uint256 teamBNBAmount,uint256 hasTeamReward,uint256 rewardDebt,uint256 rewardTotalAmount,uint256 sellRewardAmount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export const pairAbi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function factory() view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)',
  'function sync()', 'function swap(uint256,uint256,address,bytes)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
]);
export const routerAbi = parseAbi([
  'function factory() view returns (address)', 'function getAmountOut(uint256,uint256,uint256) pure returns (uint256)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
]);
export const factoryAbi = parseAbi(['function getPair(address,address) view returns (address)']);
export const ZERO_ID = `0x${'0'.repeat(64)}` as Hex;
export const UNIT = 10n ** 18n;
export const STATUS = ['None','Armed','Running','Completed','CompletedWithDust','Cancelled','Expired','StoppedWithRemaining'] as const;
export const STATUS_ZH = ['无任务','等待开始','执行中','清仓完成','完成 · 剩少量余币','已取消','已过期','停止 · 仍有余币'];
export const serviceLabels: Record<string,string> = {
  WaitingForStart:'等待监控开始', WaitingForTax:'监控税率中', WindowExpired:'监控已到期', AwaitingQuote:'检查卖出条件', WaitingForConditions:'等待成交条件', NeedsApproval:'授权额度不足',
  PendingTx:'等待链上确认', Confirming:'确认与对账中', DependencyChanged:'依赖变更 · 已停止广播',
  BudgetExhausted:'Gas 预算不足', AttemptsExhausted:'尝试次数已用尽', StoppedUneconomic:'尾款不满足经济阈值',
  StoppedWithDust:'余币已达阈值 · 已停止',
  MissingConfiguration:'运行配置不完整', Ready:'可以执行', Recovering:'交易恢复中', Closed:'任务已结束', Error:'等待问题处理',
};
export function ceilDiv(a: bigint, b: bigint) { if (a < 0n || b <= 0n) throw new Error('Invalid division'); return (a + b - 1n) / b; }
export function minimumOutput(amount: bigint, price: bigint) { return ceilDiv(amount * price, UNIT); }
export function floorFromTotal(totalMin: bigint, initialBalance: bigint) { return ceilDiv(totalMin * UNIT, initialBalance); }
export function minBig(...values: bigint[]) { return values.reduce((a,b)=>a<b?a:b); }
export function safeChunkCap(reserve: bigint) { return reserve > 0n ? reserve * 150n / 10000n : 0n; }
export function legalIntegerCap(reserve: bigint) { return reserve > 0n ? (2n * reserve - 1n) / 100n : 0n; }
export function slipMinimum(output: bigint, bps: number, hard: bigint) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 3000) throw new Error('滑点须在 0–30% 范围内');
  const m = output * BigInt(10000-bps) / 10000n; return m > hard ? m : hard;
}
export function decimal(value: string, decimals = 18) {
  if (value.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0)>decimals) throw new Error('请输入有效的非负金额');
  const amount = parseUnits(value, decimals);
  if (amount >= 2n ** 256n) throw new Error('金额超过合约可表示范围');
  return amount;
}
export function display(value: string | bigint | undefined, digits = 4) {
  if (value === undefined) return '—';
  const [whole,frac=''] = formatUnits(BigInt(value),18).split('.');
  return (whole??'0').replace(/\B(?=(\d{3})+(?!\d))/g,',') + (frac.slice(0,digits).replace(/0+$/,'') ? '.'+frac.slice(0,digits).replace(/0+$/,'') : '');
}
export function beijingSeconds(date: string, time = '08:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('日期或时间格式错误');
  const ms = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(ms) || new Date(ms+8*3600000).toISOString().slice(0,16) !== `${date}T${time}`) throw new Error('日期或时间不存在');
  return Math.floor(ms/1000);
}
export function beijingLabel(timestamp: string | number | bigint) {
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(Number(timestamp)*1000);
}
export function stringify(value: unknown) { return JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v); }
export function shortAddress(a: string) { return `${a.slice(0,6)}…${a.slice(-4)}`; }
export type Policy = {
  slippageBps: number; maxAttempts: number; gasBudgetWei: string; maxTxGasWei: string;
  minEconomicUSDT: string; confirmations: number; maxQuoteAgeBlocks: number;
  /** Service-side ceiling on the predicted post-sync basic sell fee. Omitted for legacy tasks. */
  maxSellFeePercent?: number;
};
export type PlanInput = {
  owner: Address; executor: Address; notBefore: number; expiresAt: number; maxChunks: number;
  maxTotalInput: string; minUSDTPerToken: string; maxDustTokens: string; maxGasPrice: string; policy: Policy;
};
export type BatchQuote = { input: string; output: string; gas: string; gasWei: string; minOut: string; residual: string };
export type Candidate = { name: string; chunks: BatchQuote[]; output: string; gasWei: string; netUSDT: string; residual: string; complete: boolean; error?: string };
export type Quote = {
  id: string; owner: Address; blockNumber: string; blockHash: Hex; timestamp: string; simulatedAt: string;
  futureScenario: boolean; bnbPrice: string; candidates: Candidate[]; best?: Candidate; reason: string;
  fingerprint: string; assumptions: string[];
};
