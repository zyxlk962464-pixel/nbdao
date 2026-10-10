import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { readClient } from '../apps/keeper/src/chain.ts';

type Rpc = { id: number; method: string; params?: unknown[] };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function rpc(handler: (requests: Rpc[]) => unknown) {
  const bodies: Rpc[][] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = JSON.parse(body) as Rpc | Rpc[], requests = Array.isArray(json) ? json : [json]; bodies.push(requests);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(handler(requests)));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test RPC port');
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}
const success = (requests: Rpc[]) => requests.map(r => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x38' : '0x1234' })).reverse();
describe('RPC reads: real HTTP transport against local test nodes only', () => {
  it('batches concurrent reads and matches responses by ID even when reversed', async () => {
    const node = await rpc(success), client = readClient([node.url]);
    const [chain, block] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
    expect(chain).toBe(56); expect(block).toBe(0x1234n);
    expect(node.bodies).toHaveLength(1); expect(node.bodies[0]).toHaveLength(2);
  });
  it('moves rate-limited reads to the next node while preserving the explicit eth_call block and sender', async () => {
    const limited = await rpc(requests => requests.map(r => ({ jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'Request exceeds defined limit' } })));
    const healthy = await rpc(success), client = readClient([limited.url, healthy.url]);
    const from = '0x0000000000000000000000000000000000000011', to = '0x0000000000000000000000000000000000000022';
    const [block, result] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.request({ method: 'eth_call', params: [{ from, to, data: '0x1234' }, '0x1234'] })]);
    expect(block).toBe(0x1234n); expect(result).toBe('0x1234');
    expect(limited.bodies).toHaveLength(1); expect(healthy.bodies).toHaveLength(1);
    expect(healthy.bodies[0]?.find(r => r.method === 'eth_call')?.params).toEqual([{ from, to, data: '0x1234' }, '0x1234']);
  });
  it('keeps a genuine execution revert instead of looking for a node that accepts it', async () => {
    const reverting = await rpc(requests => requests.map(r => ({ jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted', data: '0x' } })));
    const healthy = await rpc(success), client = readClient([reverting.url, healthy.url]);
    await expect(client.call({ to: '0x0000000000000000000000000000000000000022', data: '0x1234', blockNumber: 10n })).rejects.toThrow('reverted');
    expect(healthy.bodies).toHaveLength(0);
  });
});
