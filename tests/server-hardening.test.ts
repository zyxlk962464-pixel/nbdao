import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginApiRequest, boundedBody } from '../apps/web/src/lib/api-security.ts';
import { ReadGate } from '../apps/keeper/src/read-gate.ts';
import { Worker } from '../apps/keeper/src/worker.ts';
import type { Runtime } from '../apps/keeper/src/config.ts';
import type { Chain } from '../apps/keeper/src/chain.ts';
import type { Optimizer } from '../apps/keeper/src/optimizer.ts';
import type { Store } from '../apps/keeper/src/store.ts';

afterEach(() => {
  vi.useRealTimers();
  const state = (globalThis as typeof globalThis & { nbdaoApiLimits?: { buckets: Map<string, unknown>; active: number; reads: number } }).nbdaoApiLimits;
  state?.buckets.clear(); if (state) { state.active = 0; state.reads = 0; }
});
const readRequest = () => new Request('https://example.com/api/tax', { headers: { host: 'example.com' } });
describe('public API resource and body boundaries', () => {
  it('rejects cross-site registration before reading its body', () => {
    const result = beginApiRequest(new Request('https://example.com/api/tasks/register', { method: 'POST',
      headers: { host: 'example.com', origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' }));
    expect(result).toBeInstanceOf(Response); expect((result as Response).status).toBe(403);
  });
  it('reserves concurrency for a legitimate registration and releases it only once', () => {
    const releases = Array.from({ length: 6 }, () => beginApiRequest(readRequest()));
    expect((beginApiRequest(readRequest()) as Response).status).toBe(429);
    const write = beginApiRequest(new Request('https://example.com/api/tasks/register', { method: 'POST',
      headers: { host: 'example.com', origin: 'https://example.com', 'content-type': 'application/json' }, body: '{}' }));
    expect(typeof write).toBe('function'); if (typeof write === 'function') { write(); write(); }
    for (const release of releases) if (typeof release === 'function') release();
    const next = beginApiRequest(readRequest()); expect(typeof next).toBe('function'); if (typeof next === 'function') next();
  });
  it('limits streamed UTF-8 bytes even without a Content-Length header', async () => {
    const bytes = new TextEncoder().encode('币'.repeat(12000)); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; } });
    const request = new Request('https://example.com', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(boundedBody(request)).rejects.toThrow('请求过大'); expect(cancelled).toBe(true);
    expect(await boundedBody(new Request('https://example.com', { method: 'POST', body: '{"message":"币"}' }))).toBe('{"message":"币"}');
  });
});
describe('display queries are isolated from execution RPC work', () => {
  it('merges duplicate pending reads and expires the display-only cache', async () => {
    vi.useFakeTimers(); const gate = new ReadGate(); let resolve!: (n: number) => void;
    const read = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    const a = gate.run('tax', read), b = gate.run('tax', read); await Promise.resolve(); resolve(30);
    expect(await a).toBe(30); expect(await b).toBe(30); expect(read).toHaveBeenCalledTimes(1);
    expect(await gate.run('tax', read)).toBe(30);
    vi.advanceTimersByTime(251); const fresh = vi.fn(async () => 20);
    expect(await gate.run('tax', fresh)).toBe(20); expect(fresh).toHaveBeenCalledTimes(1);
  });
  it('caps distinct concurrent reads and frees failed slots', async () => {
    const gate = new ReadGate(); const resolve: (() => void)[] = [];
    const pending = Array.from({ length: 4 }, (_, i) => gate.run(String(i), () => new Promise<void>(r => { resolve.push(r); })));
    await expect(gate.run('overflow', async () => 1)).rejects.toThrow('查询繁忙');
    for (const finish of resolve) finish(); await Promise.all(pending);
    await expect(gate.run('failure', async () => { throw new Error('RPC failure'); })).rejects.toThrow('RPC failure');
    expect(await gate.run('failure', async () => 2)).toBe(2);
  });
});
describe('background Worker needs no browser requests', () => {
  it('starts its own block subscription, checks blocks and reports stale monitoring', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    let head!: () => void; const unsubscribe = vi.fn();
    const config = { app: { mode: 'live', ready: true }, cloud: true, pollMs: 500, quoteTimeoutMs: 90000 } as Runtime;
    const chain = { client: { watchBlockNumber: (options: { onBlockNumber: () => void }) => { head = options.onBlockNumber; return unsubscribe; } } } as unknown as Chain;
    const worker = new Worker(config, chain, {} as Optimizer, { release: vi.fn() } as unknown as Store);
    const tick = vi.spyOn(worker, 'tick').mockResolvedValue(undefined);
    worker.start(); expect(worker.status().location).toBe('cloud'); expect(worker.status().enabled).toBe(true);
    head(); await Promise.resolve(); expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31000); expect(worker.status().healthy).toBe(false);
    head(); await Promise.resolve(); expect(worker.status().healthy).toBe(true);
    await worker.stop(); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(worker.status().enabled).toBe(false);
  });
});
