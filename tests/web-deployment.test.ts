import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { DEPLOY_BYTECODE_HASH, DEPLOY_FEE_CAP, assertDeploymentTransaction, deploymentCost, normalizedRuntime, validDeploymentRecord } from '../apps/web/src/lib/deployment.ts';
import { readFileSync } from 'node:fs';

const owner = '0x0000000000000000000000000000000000000011' as const;
const artifact = JSON.parse(readFileSync('packages/contracts/out/NBDAOSeller.sol/NBDAOSeller.json','utf8'));
describe('bounded MetaMask deployment', () => {
  it('pins the actual production artifact and empty constructor', () => {
    expect(keccak256(artifact.bytecode.object)).toBe(DEPLOY_BYTECODE_HASH);
    expect(artifact.abi.find((item: { type: string }) => item.type === 'constructor').inputs).toEqual([]);
  });
  it('ceilings the gas margin and blocks fee/balance overspend', () => {
    expect(deploymentCost(101n, 1n, 1000n)).toEqual({ gasLimit: 122n, maxFee: 122n });
    expect(() => deploymentCost(2000000n, 100000000n, 10n**18n)).toThrow('超过');
    expect(() => deploymentCost(100n, 1n, 119n)).toThrow('余额不足');
    expect(deploymentCost(125n, 1000000000000n, DEPLOY_FEE_CAP).maxFee).toBe(DEPLOY_FEE_CAP);
  });
  it('refuses altered sender, nonce, target, native value or network', () => {
    const transaction = { from: owner, to: null, input: artifact.bytecode.object as Hex, value: 0n, nonce: 7, chainId: 56 };
    expect(() => assertDeploymentTransaction(transaction, owner, 7)).not.toThrow();
    for (const patch of [{ from: '0x0000000000000000000000000000000000000022' }, { to: owner }, { nonce: 8 }, { value: 1n }, { chainId: 31337 }, { input: '0x00' }]) expect(() => assertDeploymentTransaction({ ...transaction, ...patch } as typeof transaction, owner, 7)).toThrow('不匹配');
  });
  it('only masks declared immutable slots and rejects malformed ranges', () => {
    const references = { '1': [{ start: 1, length: 1 }] };
    expect(normalizedRuntime('0x112233', references)).toBe(normalizedRuntime('0x11ff33', references));
    expect(normalizedRuntime('0x112244', references)).not.toBe(normalizedRuntime('0x112233', references));
    expect(() => normalizedRuntime('0x112233', { '1': [{ start: 2, length: 2 }] })).toThrow('范围');
  });
  it('keeps pre-request/no-hash records valid while isolating owner and rejecting excess budgets', () => {
    const record = { owner, chainId: 56, bytecodeHash: DEPLOY_BYTECODE_HASH, nonce: 7, createdAt: Date.now(), stage: 'wallet-request', hash: null, runtimeHash: `0x${'1'.repeat(64)}`, gasLimit: '1972571', gasPriceWei: '50000000' };
    expect(validDeploymentRecord(record, owner)).toBe(true);
    expect(validDeploymentRecord(record, '0x0000000000000000000000000000000000000022')).toBe(false);
    expect(validDeploymentRecord({ ...record, gasPriceWei: '1000000000' }, owner)).toBe(false);
  });
});
