import { describe, expect, it } from 'vitest';
import { BSC, minimumOutput, policyMessage, UNIT, type AppConfig, type WalletSnapshot } from '../packages/shared/src/index.ts';
import { bindPlanStart, buildPlan, buildPolicy, initialForm } from '../apps/web/src/lib/plan';

const owner = '0x0000000000000000000000000000000000000011';
const config: AppConfig = { mode: 'local', chainId: 31337, chainName: '本地测试', addresses: BSC,
  sellerAddress: '0x0000000000000000000000000000000000000022', executor: '0x0000000000000000000000000000000000000033',
  walletRpcUrl: 'http://127.0.0.1:8545', explorerUrl: '', ready: true, missing: [] };
const wallet: WalletSnapshot = { owner, tokenBalance: (3n * UNIT).toString(), pending: '0', usdtBalance: '0', bnbBalance: UNIT.toString(), allowance: '0',
  blockNumber: '10', blockHash: `0x${'1'.repeat(64)}`, timestamp: '1791504000', sellFee: '5', reserveToken: (100n * UNIT).toString(), reserveUSDT: (100n * UNIT).toString() };
const form = () => ({ ...initialForm(), minimumUSDT: '1' });

describe('wallet sale plan', () => {
  it('defaults to a 60-minute preview from the chain snapshot with a 5% tax limit', () => {
    const plan = buildPlan(form(), wallet, config);
    expect(plan.notBefore).toBe(Number(wallet.timestamp));
    expect(plan.expiresAt - plan.notBefore).toBe(3600);
    expect(plan.policy.maxSellFeePercent).toBe(5);
    expect(initialForm()).not.toHaveProperty('date');
  });
  it('accepts a latest creation timestamp instead of using browser time or approval time', () => {
    const creationTime = BigInt(wallet.timestamp) + 7200n;
    const plan = buildPlan({ ...form(), windowMinutes: '20' }, wallet, config, creationTime);
    expect(plan.notBefore).toBe(Number(creationTime));
    expect(plan.expiresAt).toBe(Number(creationTime) + 1200);
  });
  it('rebinds the creation window without changing approval amounts, floors or signed policy', () => {
    const approved = buildPlan({ ...form(), minimumUSDT: '40', maxSellFeePercent: '3', gasBudgetBNB: '0.03', maxTxGasBNB: '0.003', maxChunks: '10' }, wallet, config);
    const before = structuredClone(approved);
    const started = bindPlanStart(approved, BigInt(wallet.timestamp) + 86400n);
    expect(started.notBefore).toBe(Number(wallet.timestamp) + 86400);
    expect(started.expiresAt).toBe(started.notBefore + 3600);
    expect({ ...started, notBefore: approved.notBefore, expiresAt: approved.expiresAt }).toEqual(before);
    expect(approved).toEqual(before);
    expect(started.policy).toBe(approved.policy);
    expect(minimumOutput(BigInt(started.maxTotalInput), BigInt(started.minUSDTPerToken))).toBeGreaterThanOrEqual(40n * UNIT);
    const taskId = `0x${'a'.repeat(64)}` as const;
    expect(policyMessage(config.chainId, config.sellerAddress!, taskId, started.policy)).toBe(policyMessage(config.chainId, config.sellerAddress!, taskId, approved.policy));
  });
  it('ceilings the price floor so a full sale cannot fall below the chosen minimum', () => {
    const plan = buildPlan(form(), wallet, config);
    expect(BigInt(plan.minUSDTPerToken)).toBe(333333333333333334n);
    expect(minimumOutput(BigInt(wallet.tokenBalance), BigInt(plan.minUSDTPerToken))).toBeGreaterThanOrEqual(UNIT);
  });
  it('defaults to finite approval of the current reward-inclusive balance', () => {
    expect(buildPlan(form(), wallet, config).maxTotalInput).toBe(wallet.tokenBalance);
  });
  it('only increases the input cap with explicitly configured reward headroom', () => {
    const plan = buildPlan({ ...form(), extraTokens: '0.5' }, wallet, config);
    expect(BigInt(plan.maxTotalInput)).toBe(35n * UNIT / 10n);
  });
  it('rejects empty wallets and zero output floors', () => {
    expect(() => buildPlan(form(), { ...wallet, tokenBalance: '0' }, config)).toThrow('暂无');
    expect(() => buildPlan({ ...form(), minimumUSDT: '0' }, wallet, config)).toThrow('大于 0');
  });
  it('rejects unavailable deployment config and invalid chain time', () => {
    expect(() => buildPlan(form(), wallet, { ...config, ready: false })).toThrow('尚未就绪');
    expect(() => buildPlan(form(), { ...wallet, timestamp: 'not-a-time' }, config)).toThrow('链上时间');
    expect(() => bindPlanStart(buildPlan(form(), wallet, config), 0)).toThrow('链上时间');
    expect(() => bindPlanStart(buildPlan(form(), wallet, config), Number.MAX_SAFE_INTEGER)).toThrow('链上时间');
  });
  it('rejects dust that would mislabel the entire balance as completed', () => {
    expect(() => buildPlan({ ...form(), dustTokens: '3' }, wallet, config)).toThrow('小于当前余额');
  });
  it('enforces on-chain chunk limits and finite service budget', () => {
    expect(() => buildPlan({ ...form(), maxChunks: '257' }, wallet, config)).toThrow('1–256');
    expect(() => buildPlan({ ...form(), gasBudgetBNB: '0' }, wallet, config)).toThrow('Gas');
    expect(() => buildPlan({ ...form(), maxTxGasBNB: '0.03' }, wallet, config)).toThrow('单笔上限');
    expect(() => buildPlan({ ...form(), maxGasGwei: '0' }, wallet, config)).toThrow('大于 0');
  });
  it('rejects amount sums and price floors that overflow uint256 before requesting approval', () => {
    expect(() => buildPlan({ ...form(), dustTokens: '0', extraTokens: '0.000000000000000001' }, { ...wallet, tokenBalance: (2n ** 256n - 1n).toString() }, config)).toThrow('合约');
    expect(() => buildPlan({ ...form(), dustTokens: '0', minimumUSDT: '100000000000000000000000000000000000000000000000000000000000' }, { ...wallet, tokenBalance: '1' }, config)).toThrow('合约');
  });
  it('allows recovering service policy without requiring a nonzero wallet balance', () => {
    const policy = buildPolicy(form());
    expect(policy.slippageBps).toBe(100);
    expect(policy.maxAttempts).toBe(20);
    expect(policy.gasBudgetWei).toBe('20000000000000000');
  });
  it.each(['', '-1', '30.01', '1e1', '0.001'])('rejects malformed or unsafe slippage %s', (value) => {
    expect(() => buildPolicy({ ...form(), slippagePercent: value })).toThrow('滑点');
  });
  it.each(['0', '1441', '1.5', '-1', ''])('rejects invalid monitoring duration %s', (windowMinutes) => {
    expect(() => buildPlan({ ...form(), windowMinutes }, wallet, config)).toThrow('监控时长');
  });
  it.each(['1', '1440'])('supports monitoring duration boundary %s', (windowMinutes) => {
    const plan = buildPlan({ ...form(), windowMinutes }, wallet, config);
    expect(bindPlanStart(plan, 2000000000n).expiresAt).toBe(2000000000 + Number(windowMinutes) * 60);
  });
  it.each(['', '-1', '101', '5.5', '1e1'])('rejects invalid maximum base tax %s', (maxSellFeePercent) => {
    expect(() => buildPolicy({ ...form(), maxSellFeePercent })).toThrow('最高基础卖出税率');
  });
  it.each(['0', '100'])('supports integer maximum base tax boundary %s', (maxSellFeePercent) => {
    expect(buildPolicy({ ...form(), maxSellFeePercent }).maxSellFeePercent).toBe(Number(maxSellFeePercent));
  });
});
