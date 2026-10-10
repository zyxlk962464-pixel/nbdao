import { describe, expect, it } from 'vitest';
import { LatestRead, OperationGate, WalletSession } from '../apps/web/src/lib/wallet-session.js';

describe('wallet operation isolation', () => {
  it('an A → B → A transition cannot revive a result from the first A session', () => {
    const session = new WalletSession();
    const firstA = session.update('wallet-a:56:connector-1:connected');
    expect(session.update('wallet-a:56:connector-1:connected')).toBe(firstA);
    session.update('wallet-b:56:connector-1:connected');
    const secondA = session.update('wallet-a:56:connector-1:connected');
    expect(secondA).not.toBe(firstA);
    expect(session.isCurrent(firstA)).toBe(false);
    expect(session.isCurrent(secondA)).toBe(true);
  });

  it('switching connector or disconnecting invalidates old requests even for the same address and chain', () => {
    const session = new WalletSession();
    const injected = session.update('wallet-a:56:injected:connected');
    const remote = session.update('wallet-a:56:walletconnect:connected');
    expect(session.isCurrent(injected)).toBe(false);
    session.update('wallet-a:56:walletconnect:disconnected');
    expect(session.isCurrent(remote)).toBe(false);
  });

  it('an unsettled request retains the operation gate through account and chain changes', () => {
    const session = new WalletSession();
    const gate = new OperationGate();
    session.update('wallet-a:56:injected:connected');
    const approval = gate.acquire()!;
    expect(gate.acquire()).toBeNull(); // A second click before React rerenders.
    session.update('wallet-b:31337:injected:connected');
    expect(gate.busy).toBe(true);
    expect(gate.acquire()).toBeNull();
    gate.release(approval);
    expect(gate.busy).toBe(false);
    expect(gate.acquire()).not.toBeNull();
  });

  it('a late finally from an old operation cannot release a newer wallet request', () => {
    const gate = new OperationGate();
    const first = gate.acquire()!;
    gate.release(first);
    const second = gate.acquire()!;
    gate.release(first);
    gate.release(Symbol('unrelated'));
    expect(gate.busy).toBe(true);
    expect(gate.acquire()).toBeNull();
    gate.release(second);
    expect(gate.busy).toBe(false);
  });

  it('late balance/task reads cannot overwrite a newer snapshot or a different wallet', async () => {
    const session = new WalletSession();
    const reads = new LatestRead();
    let displayed = '';
    function apply(generation: number, sequence: number, value: string) {
      if (session.isCurrent(generation) && reads.isCurrent(sequence)) displayed = value;
    }
    const a = session.update('wallet-a:56:injected:connected');
    const old = reads.start();
    let finishOld!: () => void;
    const delayed = new Promise<void>((resolve) => { finishOld = resolve; })
      .then(() => apply(a, old, 'old wallet-a snapshot'));
    const fresh = reads.start();
    apply(a, fresh, 'fresh wallet-a snapshot');
    finishOld();
    await delayed;
    expect(displayed).toBe('fresh wallet-a snapshot');
    session.update('wallet-b:56:injected:connected');
    // Still reject A even before B has started its first refresh.
    apply(a, fresh, 'late wallet-a response');
    expect(displayed).toBe('fresh wallet-a snapshot');
    const b = session.generation;
    apply(b, reads.start(), 'wallet-b snapshot');
    expect(displayed).toBe('wallet-b snapshot');
  });
});
