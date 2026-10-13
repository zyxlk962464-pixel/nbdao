import { describe, expect, it } from 'vitest';
import { BSC, UNIT, type AppConfig, type WalletSnapshot } from '../packages/shared/src/index.ts';
import { buildOpeningPlan, nextOpeningDate, openingAvailable, openingTimestamp, OPENING_CREATE_GAS, OPENING_GAS_RESERVE, splitOpeningBudget } from '../apps/web/src/lib/opening-plan.ts';

const owner = '0x0000000000000000000000000000000000000011';
const config: AppConfig = { mode: 'local', chainId: 31337, chainName: '本地测试', addresses: BSC,
  sellerAddress: null, openingSellerAddress: '0x0000000000000000000000000000000000000022', executor: '0x0000000000000000000000000000000000000033',
  openingReady: true, walletRpcUrl: 'http://127.0.0.1:8545', explorerUrl: '', ready: false, missing: [] };
const timestamp = Date.parse('2026-10-13T07:59:00+08:00') / 1000;
const wallet: WalletSnapshot = { owner, tokenBalance: (3n * UNIT).toString(), pending: '0', usdtBalance: '0', bnbBalance: UNIT.toString(), allowance: '0',
  blockNumber: '10', blockHash: `0x${'1'.repeat(64)}`, timestamp: timestamp.toString(), sellFee: '100', reserveToken: UNIT.toString(), reserveUSDT: UNIT.toString() };
const form = { date: '2026-10-13', totalBNB: '0.02', minimumUSDT: '30' };

describe('one-off Beijing 08:00 opening plan', () => {
  it('uses the selected Beijing date, a 12-second window, exact input and whole-wallet USDT floor', () => {
    const plan = buildOpeningPlan(form, wallet, config, 100_000_000n);
    expect(plan.notBefore).toBe(Date.parse('2026-10-13T00:00:00Z') / 1000);
    expect(plan.expiresAt - plan.notBefore).toBe(12);
    expect(plan.maxTotalInput).toBe(wallet.tokenBalance);
    expect(plan.minTotalUSDT).toBe((30n * UNIT).toString());
    expect(plan.policy).not.toHaveProperty('maxSellFeePercent');
  });
  it('defaults to the next 08:00, including exact boundary and month rollover', () => {
    expect(nextOpeningDate(timestamp)).toBe('2026-10-13');
    expect(nextOpeningDate(Date.parse('2026-10-13T08:00:00+08:00') / 1000)).toBe('2026-10-14');
    expect(nextOpeningDate(Date.parse('2026-10-31T23:00:00+08:00') / 1000)).toBe('2026-11-01');
  });
  it('rejects past, exact 08:00 and nonexistent dates without rolling them forward', () => {
    expect(() => openingTimestamp('2026-10-12', timestamp)).toThrow('已过');
    expect(() => openingTimestamp('2026-10-13', timestamp + 60)).toThrow('已过');
    expect(() => openingTimestamp('2026-02-30', timestamp)).toThrow('不存在');
    expect(() => buildOpeningPlan(form, { ...wallet, timestamp: (timestamp + 1).toString() }, config, 100_000_000n)).toThrow('提前 1 分钟');
  });
  it('includes actual setup gas and reserved creation/execution gas before allocating builder fees', () => {
    const total = 20_000_000_000_000_000n, spent = 8_000_000_000_000n, price = 100_000_000n;
    const budget = splitOpeningBudget(total, spent, price);
    expect(budget.createReserveWei).toBe(OPENING_CREATE_GAS * price);
    expect(budget.executionGasReserveWei).toBe(OPENING_GAS_RESERVE * price);
    expect(spent + budget.createReserveWei + budget.executionGasReserveWei + budget.builderFeeWei).toBe(total);
    expect(budget.maxExecutionCostWei).toBe(budget.executionGasReserveWei + budget.builderFeeWei);
    const setupTxHashes = [`0x${'a'.repeat(64)}` as const];
    const plan = buildOpeningPlan(form, wallet, config, price, spent, setupTxHashes);
    expect(plan.policy.setupTxHashes).toEqual(setupTxHashes);
    expect(plan.policy.setupTxHashes).not.toBe(setupTxHashes);
    expect(plan.policy.builderFeeWei).toBe(plan.maxBuilderFeeWei);
  });
  it('permits zero builder fee but rejects insufficient gas budget and excessive gas price', () => {
    const price = 100_000_000n, minimum = (OPENING_CREATE_GAS + OPENING_GAS_RESERVE) * price;
    expect(splitOpeningBudget(minimum, 0n, price).builderFeeWei).toBe(0n);
    expect(() => splitOpeningBudget(minimum - 1n, 0n, price)).toThrow('不足');
    expect(() => splitOpeningBudget(UNIT, 0n, 3_000_000_001n)).toThrow('3 Gwei');
    expect(() => splitOpeningBudget(UNIT, 0n, 0n)).toThrow('3 Gwei');
  });
  it('remains unavailable until the new opening contract and worker are explicitly configured', () => {
    expect(openingAvailable(null)).toBe(false);
    expect(openingAvailable({ ...config, openingSellerAddress: null })).toBe(false);
    expect(openingAvailable({ ...config, openingReady: false })).toBe(false);
    expect(openingAvailable({ ...config, mode: 'read-only' })).toBe(false);
    expect(openingAvailable(config)).toBe(true);
    expect(() => buildOpeningPlan(form, wallet, { ...config, openingReady: false }, 100_000_000n)).toThrow('尚待部署');
  });
  it('rejects empty holdings, zero minimum output and costs beyond BNB funds', () => {
    expect(() => buildOpeningPlan(form, { ...wallet, tokenBalance: '0' }, config, 100_000_000n)).toThrow('暂无');
    expect(() => buildOpeningPlan({ ...form, minimumUSDT: '0' }, wallet, config, 100_000_000n)).toThrow('大于 0');
    expect(() => buildOpeningPlan({ ...form, totalBNB: '2' }, wallet, config, 100_000_000n)).toThrow('不足');
  });
});
