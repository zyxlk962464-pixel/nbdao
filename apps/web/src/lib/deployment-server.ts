import 'server-only';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, keccak256, type Address, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { BSC, executorAbi, factoryAbi, pairAbi, routerAbi, tokenAbi } from '@nbdao/shared';
import { assertDeploymentTransaction, DEPLOY_BYTECODE_HASH, DEPLOY_CONFIRMATIONS, DEPLOY_FEE_CAP, deploymentCost, normalizedRuntime, type DeploymentInfo, type DeploymentPlan, type DeploymentReceipt } from './deployment';

type Artifact = { abi: DeploymentInfo['abi']; bytecode: { object: Hex; linkReferences: Record<string, unknown> }; deployedBytecode: { object: Hex; immutableReferences: Record<string, { start: number; length: number }[]> } };
function artifact() {
  const value = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/out/NBDAOSeller.sol/NBDAOSeller.json'), 'utf8')) as Artifact;
  if (keccak256(value.bytecode.object) !== DEPLOY_BYTECODE_HASH || Object.keys(value.bytecode.linkReferences).length) throw new Error('编译产物不是已核对的固定部署版本');
  return value;
}
export function deploymentInfo(): DeploymentInfo {
  const value = artifact();
  return { chainId: 56, artifact: 'NBDAOSeller', bytecode: value.bytecode.object, bytecodeHash: DEPLOY_BYTECODE_HASH,
    abi: value.abi.filter((item) => item.type === 'constructor'), walletRpcUrl: process.env.NEXT_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org', explorerUrl: 'https://bscscan.com' };
}
function client() { return createPublicClient({ chain: bsc, transport: http(deploymentInfo().walletRpcUrl, { timeout: 15000, retryCount: 1 }) }); }
async function checkBindings(c: ReturnType<typeof client>) {
  if (await c.getChainId() !== 56) throw new Error('部署仅允许 BSC 主网 Chain ID 56');
  const addresses = [BSC.token, BSC.usdt, BSC.pair, BSC.router, BSC.factory];
  const codes = await Promise.all(addresses.map((address) => c.getCode({ address })));
  if (codes.some((code) => !code || code === '0x')) throw new Error('目标资产或交易池没有合约代码');
  const [token0, token1, factory, pairFactory, pair, basePair, decimals, uDecimals] = await Promise.all([
    c.readContract({ address: BSC.pair, abi: pairAbi, functionName: 'token0' }), c.readContract({ address: BSC.pair, abi: pairAbi, functionName: 'token1' }),
    c.readContract({ address: BSC.router, abi: routerAbi, functionName: 'factory' }), c.readContract({ address: BSC.pair, abi: pairAbi, functionName: 'factory' }),
    c.readContract({ address: BSC.factory, abi: factoryAbi, functionName: 'getPair', args: [BSC.token, BSC.usdt] }),
    c.readContract({ address: BSC.token, abi: tokenAbi, functionName: 'basePair' }), c.readContract({ address: BSC.token, abi: tokenAbi, functionName: 'decimals' }),
    c.readContract({ address: BSC.usdt, abi: tokenAbi, functionName: 'decimals' }),
  ]);
  if (token0.toLowerCase() !== BSC.usdt || token1.toLowerCase() !== BSC.token || factory.toLowerCase() !== BSC.factory || pairFactory.toLowerCase() !== BSC.factory || pair.toLowerCase() !== BSC.pair || basePair.toLowerCase() !== BSC.pair || decimals !== 18 || uDecimals !== 18) throw new Error('代币、池、Router 或精度绑定不匹配');
}
export async function deploymentPreflight(owner: Address): Promise<DeploymentPlan> {
  const info = deploymentInfo(), c = client();
  await checkBindings(c);
  const [balance, gasPrice, nonce, pendingNonce, block] = await Promise.all([c.getBalance({ address: owner }), c.getGasPrice(), c.getTransactionCount({ address: owner, blockTag: 'latest' }), c.getTransactionCount({ address: owner, blockTag: 'pending' }), c.getBlock()]);
  if (nonce !== pendingNonce) throw new Error('钱包已有待确认交易，请先在 MetaMask 核查，暂不准备新部署');
  const [called, estimate] = await Promise.all([c.call({ account: owner, data: info.bytecode, value: 0n }), c.estimateGas({ account: owner, data: info.bytecode, value: 0n, gasPrice, nonce })]);
  if (!called.data || called.data === '0x') throw new Error('免费部署模拟没有返回运行代码');
  const value = artifact();
  if (normalizedRuntime(called.data, value.deployedBytecode.immutableReferences) !== normalizedRuntime(value.deployedBytecode.object, value.deployedBytecode.immutableReferences)) throw new Error('部署模拟返回的运行代码不匹配');
  const { gasLimit, maxFee } = deploymentCost(estimate, gasPrice, balance);
  return { ...info, owner, nonce, blockNumber: block.number!.toString(), blockHash: block.hash!, checkedAt: Date.now(), balanceWei: balance.toString(), estimatedGas: estimate.toString(), gasLimit: gasLimit.toString(), gasPriceWei: gasPrice.toString(), maxFeeWei: maxFee.toString(), feeCapWei: DEPLOY_FEE_CAP.toString(), runtimeHash: keccak256(called.data) };
}
export async function deploymentReceipt(hash: Hex, owner: Address, nonce: number, runtimeHash: Hex): Promise<DeploymentReceipt> {
  const c = client();
  if (await c.getChainId() !== 56) throw new Error('回执 RPC 不是 BSC 主网');
  let transaction;
  try { transaction = await c.getTransaction({ hash }); }
  catch (error) { if ((error as Error).name === 'TransactionNotFoundError') return { state: 'pending', hash, confirmations: 0, reason: 'RPC 暂未找到交易，请在 MetaMask 活动记录核查；不会重新发送' }; throw error; }
  assertDeploymentTransaction(transaction, owner, nonce);
  let receipt;
  try { receipt = await c.getTransactionReceipt({ hash }); }
  catch (error) { if ((error as Error).name === 'TransactionReceiptNotFoundError') return { state: 'pending', hash, confirmations: 0, reason: '交易仍待链上确认；不会重新发送' }; throw error; }
  const [head, canonical] = await Promise.all([c.getBlockNumber(), c.getBlock({ blockNumber: receipt.blockNumber })]);
  const confirmations = Number(head - receipt.blockNumber + 1n);
  if (canonical.hash !== receipt.blockHash) return { state: 'pending', hash, confirmations: 0, reason: '区块回执需要重新核查；不会重新发送' };
  if (confirmations < DEPLOY_CONFIRMATIONS) return { state: 'confirming', hash, confirmations, reason: `等待 ${DEPLOY_CONFIRMATIONS} 个区块确认` };
  const feeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
  if (receipt.status !== 'success') return { state: 'reverted', hash, confirmations, feeWei, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, reason: '部署交易回滚，Gas 已消耗，不会自动重试' };
  if (!receipt.contractAddress) throw new Error('部署回执没有合约地址');
  const address = receipt.contractAddress, code = await c.getCode({ address }), value = artifact();
  if (!code || normalizedRuntime(code, value.deployedBytecode.immutableReferences) !== normalizedRuntime(value.deployedBytecode.object, value.deployedBytecode.immutableReferences) || keccak256(code) !== runtimeHash) throw new Error('已部署运行代码与固定产物/预检不匹配，暂不采用该地址');
  const [token, usdt, pair, router, factory, unit, chain] = await Promise.all([
    c.readContract({ address, abi: executorAbi, functionName: 'token' }), c.readContract({ address, abi: executorAbi, functionName: 'usdt' }),
    c.readContract({ address, abi: executorAbi, functionName: 'pair' }), c.readContract({ address, abi: executorAbi, functionName: 'router' }),
    c.readContract({ address, abi: executorAbi, functionName: 'factory' }), c.readContract({ address, abi: executorAbi, functionName: 'tokenUnit' }),
    c.readContract({ address, abi: executorAbi, functionName: 'deploymentChainId' }),
  ]);
  if (token.toLowerCase() !== BSC.token || usdt.toLowerCase() !== BSC.usdt || pair.toLowerCase() !== BSC.pair || router.toLowerCase() !== BSC.router || factory.toLowerCase() !== BSC.factory || unit !== 10n ** 18n || chain !== 56n) throw new Error('已部署合约绑定不匹配');
  return { state: 'confirmed', hash, confirmations, contractAddress: address, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, feeWei, runtimeHash: keccak256(code), reason: '部署回执与固定运行代码核验通过；未授权代币、未创建卖出任务' };
}
