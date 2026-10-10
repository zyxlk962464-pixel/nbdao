import { keccak256, type Abi, type Address, type Hex } from 'viem';

export const DEPLOY_CHAIN_ID = 56;
export const DEPLOY_BYTECODE_HASH = '0x020fac725b8fa210b9e187cbdfbdd3cc7527b90df51610fcf8710ea86d1b8056' as Hex;
export const DEPLOY_FEE_CAP = 150000000000000n; // 0.00015 BNB, including the 20% gas-limit margin.
export const DEPLOY_CONFIRMATIONS = 3;
export type DeploymentInfo = { chainId: 56; artifact: 'NBDAOSeller'; bytecode: Hex; bytecodeHash: Hex; abi: Abi; walletRpcUrl: string; explorerUrl: string };
export type DeploymentPlan = DeploymentInfo & { owner: Address; nonce: number; blockNumber: string; blockHash: Hex; checkedAt: number;
  balanceWei: string; estimatedGas: string; gasLimit: string; gasPriceWei: string; maxFeeWei: string; feeCapWei: string; runtimeHash: Hex };
export type DeploymentRecord = { owner: Address; chainId: 56; bytecodeHash: Hex; nonce: number; createdAt: number; stage: 'wallet-request'|'submitted'|'confirmed'|'reverted'; hash: Hex|null; runtimeHash: Hex; gasLimit: string; gasPriceWei: string };
export type DeploymentReceipt = { state: 'pending'|'confirming'|'confirmed'|'reverted'; hash: Hex; confirmations: number; contractAddress?: Address; blockNumber?: string; blockHash?: Hex; feeWei?: string; runtimeHash?: Hex; reason: string };

export function deploymentCost(estimatedGas: bigint, gasPrice: bigint, balance: bigint) {
  if (estimatedGas <= 0n || gasPrice <= 0n) throw new Error('部署 Gas 估算无效');
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  const maxFee = gasLimit * gasPrice;
  if (maxFee > DEPLOY_FEE_CAP) throw new Error('本次部署费用超过 0.00015 BNB 上限，已停止');
  if (balance < maxFee) throw new Error('钱包 BNB 余额不足以覆盖本次部署费用上限');
  return { gasLimit, maxFee };
}
export function deploymentKey(owner: Address) { return `nbdao-deployment:${DEPLOY_CHAIN_ID}:${DEPLOY_BYTECODE_HASH}:${owner.toLowerCase()}`; }
export function validDeploymentRecord(value: unknown, owner: Address): value is DeploymentRecord {
  const record = value as Partial<DeploymentRecord> | null;
  return !!record && record.owner?.toLowerCase() === owner.toLowerCase() && record.chainId === DEPLOY_CHAIN_ID && record.bytecodeHash === DEPLOY_BYTECODE_HASH &&
    Number.isSafeInteger(record.nonce) && (record.nonce ?? -1) >= 0 && ['wallet-request','submitted','confirmed','reverted'].includes(record.stage || '') &&
    (record.hash === null || typeof record.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(record.hash)) && typeof record.runtimeHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(record.runtimeHash) &&
    Number.isFinite(record.createdAt) && typeof record.gasLimit === 'string' && /^\d+$/.test(record.gasLimit) && typeof record.gasPriceWei === 'string' && /^\d+$/.test(record.gasPriceWei) &&
    BigInt(record.gasLimit) > 0n && BigInt(record.gasPriceWei) > 0n && BigInt(record.gasLimit) * BigInt(record.gasPriceWei) <= DEPLOY_FEE_CAP;
}
export function normalizedRuntime(code: Hex, references: Record<string, { start: number; length: number }[]>) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error('部署运行代码无效');
  let value = code.slice(2).toLowerCase();
  for (const reference of Object.values(references).flat()) {
    const start = reference.start * 2, length = reference.length * 2;
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > value.length) throw new Error('编译产物 immutable 范围无效');
    value = value.slice(0, start) + '0'.repeat(length) + value.slice(start + length);
  }
  return `0x${value}` as Hex;
}
export function assertDeploymentTransaction(transaction: { from: Address; to?: Address|null; input: Hex; value: bigint; nonce: number; chainId?: number }, owner: Address, nonce: number) {
  if (transaction.from.toLowerCase() !== owner.toLowerCase() || transaction.to != null || transaction.value !== 0n || transaction.nonce !== nonce || transaction.chainId !== DEPLOY_CHAIN_ID || keccak256(transaction.input) !== DEPLOY_BYTECODE_HASH) throw new Error('交易的钱包、网络、nonce、金额或固定部署字节码不匹配；禁止重复部署，请在钱包核查');
}
