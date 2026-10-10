import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Store, type Attempt } from '../apps/keeper/src/store.js';
import { taskId } from '../apps/keeper/src/validation.js';
import { Optimizer } from '../apps/keeper/src/optimizer.js';
import { Worker } from '../apps/keeper/src/worker.js';
import { LOCAL_OWNER_KEY, runtime, type Runtime } from '../apps/keeper/src/config.js';
import type { Chain } from '../apps/keeper/src/chain.js';
import { policyMessage, type PlanInput, type Policy } from '../packages/shared/src/index.js';

const lower = `0x${'ab'.repeat(32)}` as Hex;
const upper = `0x${'AB'.repeat(32)}` as Hex;
const txHash = `0x${'cd'.repeat(32)}` as Hex;
const seller = '0x0000000000000000000000000000000000000001' as const;
const account = privateKeyToAccount(LOCAL_OWNER_KEY);
const policy: Policy = {
  slippageBps: 100, maxAttempts: 1, gasBudgetWei: '10', maxTxGasWei: '10',
  minEconomicUSDT: '0', confirmations: 3, maxQuoteAgeBlocks: 10,
};
const stores: Store[] = [];
const directories: string[] = [];

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'nbdao-keeper-review-'));
  directories.push(dir);
  const path = join(dir, 'keeper.sqlite');
  const store = new Store(path);
  stores.push(store);
  return { store, path };
}

function paidAttempt(id: Hex): Attempt {
  return {
    hash: txHash, taskId: id, nonce: 1, raw: '0x01', input: '100', minOut: '1', index: 0,
    sentAt: 1, state: 'failed', gasWei: '7', blockNumber: '123',
    blockHash: txHash, output: '0', confirmed: true,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('independent keeper financial review', () => {
  it('canonicalizes task IDs at the API boundary', () => {
    expect(taskId(upper)).toBe(lower);
  });

  it('a replayed owner signature with different ID casing cannot reset attempts or paid Gas', async () => {
    const message = policyMessage(56, seller, lower, policy);
    const signature = await account.signMessage({ message });
    expect(policyMessage(56, seller, upper, policy)).toBe(message);
    const recovered = await recoverMessageAddress({ message: policyMessage(56, seller, upper, policy), signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    const { store } = database();
    store.register(lower, recovered, policy);
    store.insert(paidAttempt(lower));
    // Direct Store calls also enforce the invariant, independently of validation.
    store.register(upper, recovered, policy);
    expect(store.tasks()).toHaveLength(1);
    expect(store.attempts(upper)).toHaveLength(1);
    expect(store.spent(upper)).toBe(7n);
    expect(() => store.register(upper, recovered, { ...policy, gasBudgetWei: '100' })).toThrow('冻结');
  });

  it('recovers paid attempt accounting from a single legacy mixed-case row after restart', () => {
    const { store, path } = database();
    store.register(lower, account.address, policy);
    store.insert(paidAttempt(lower));
    store.db.prepare('UPDATE tasks SET id=?').run(upper);
    store.db.prepare('UPDATE attempts SET taskId=?, hash=?').run(upper, txHash.toUpperCase().replace('0X', '0x'));
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = new Store(path);
    stores.push(recovered);
    expect(recovered.tasks()).toHaveLength(1);
    expect(recovered.task(upper)?.id).toBe(lower);
    expect(recovered.spent(lower)).toBe(7n);
    expect(recovered.attempts(lower)[0]?.hash).toBe(txHash);
  });

  it('releases the simulator lock if its first RPC request fails', async () => {
    const getBlock = vi.fn().mockRejectedValue(new Error('temporary RPC outage'));
    const chain = { client: { getBlock } } as unknown as Chain;
    const optimizer = new Optimizer({ app: { mode: 'local' } } as Runtime, chain);
    const plan = {} as PlanInput;
    await expect(optimizer.quote(plan)).rejects.toThrow('temporary RPC outage');
    expect(optimizer.busy).toBe(false);
    await expect(optimizer.quote(plan)).rejects.toThrow('temporary RPC outage');
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it('read-only mode never reaches transaction or chain execution, even when configuration is ready', async () => {
    const getBlock = vi.fn().mockRejectedValue(new Error('must not access execution chain'));
    const state = vi.fn();
    const store = { tasks: () => [{ id: lower }], state } as unknown as Store;
    const config = { app: { mode: 'read-only', ready: true } } as Runtime;
    const worker = new Worker(config, { client: { getBlock } } as unknown as Chain, {} as Optimizer, store);
    await worker.tick();
    expect(getBlock).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledWith(lower, 'MissingConfiguration', '只读模式不发送交易。');
  });

  it('defaults to read-only, and live mode requires its explicit execution marker', () => {
    vi.stubEnv('SELLER_MODE', undefined);
    expect(runtime().app.mode).toBe('read-only');
    vi.stubEnv('SELLER_MODE', 'live');
    vi.stubEnv('LIVE_EXECUTION', '');
    expect(runtime().app.ready).toBe(false);
    expect(runtime().app.missing).toContain('LIVE_EXECUTION=I_UNDERSTAND');
  });
});
