import type { Address, Hex } from 'viem';
import type { Addresses, Policy } from './index.ts';
export type AppConfig = {
  mode: 'read-only'|'local'|'live'; chainId: number; chainName: string;
  addresses: Addresses; sellerAddress: Address|null; executor: Address|null;
  walletRpcUrl: string; explorerUrl: string; ready: boolean; missing: string[];
  /** HTTP head detection interval; business checks run only for new blocks. */
  blockPollMs?: number;
};
/** Spot pool reference, not an executable sale quote. Price is scaled by 10^18. */
export type PriceSnapshot = {
  chainId: number; pair: Address; token: Address; usdt: Address;
  tokenDecimals: number; usdtDecimals: number; spotPriceUSDTPerTokenWei: string;
  reserveToken: string; reserveUSDT: string;
  blockNumber: string; blockHash: Hex; timestamp: string; poolTimestamp: string;
};
/** Predicted basic fee after the token's natural pre-sale sync at this block. Not a total-fee or execution guarantee. */
export type SellTaxSnapshot = {
  sellFeeAfterSync: string|null; blockNumber: string; blockHash: Hex; timestamp: string; reason: string;
};
export type WalletSnapshot = {
  owner: Address; tokenBalance: string; pending: string; usdtBalance: string;
  bnbBalance: string; allowance: string; blockNumber: string; blockHash: Hex;
  timestamp: string; sellFee: string; reserveToken: string; reserveUSDT: string;
};
export type TaskView = {
  taskId: Hex; owner: Address; executor: Address; status: number;
  serviceStatus: string; reason: string; nextChunkIndex: number;
  notBefore: string; expiresAt: string; maxChunks: number; maxTotalInput: string;
  minUSDTPerToken: string; maxDustTokens: string; maxGasPrice: string;
  soldInput: string; receivedUSDT: string; residual: string;
  gasSpentWei: string; attempts: number; policy: Policy|null;
  fills: { hash: Hex; index: number; input: string; output: string; gasWei: string; blockNumber: string; confirmed: boolean }[];
  windowExpired?: boolean;
  /** Stored on-chain status when the effective view has become expired by timestamp. */
  chainStatus?: number;
};
export function policyMessage(chainId: number, seller: Address, taskId: Hex, policy: Policy) {
  const normalized: Policy = {
    slippageBps:policy.slippageBps,maxAttempts:policy.maxAttempts,
    gasBudgetWei:policy.gasBudgetWei,maxTxGasWei:policy.maxTxGasWei,
    minEconomicUSDT:policy.minEconomicUSDT,confirmations:policy.confirmations,
    maxQuoteAgeBlocks:policy.maxQuoteAgeBlocks,
    ...(policy.maxSellFeePercent === undefined ? {} : {maxSellFeePercent:policy.maxSellFeePercent}),
  };
  return `NBDAO 自动清仓服务参数确认\nChain ID: ${chainId}\n执行合约: ${seller.toLowerCase()}\n任务: ${taskId.toLowerCase()}\n服务参数: ${JSON.stringify(normalized)}\n该签名用于绑定本任务的执行预算和滑点，不授予额外资产权限。`;
}
