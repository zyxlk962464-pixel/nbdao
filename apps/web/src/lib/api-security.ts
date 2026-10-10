/** Bounded, process-wide limits. Forwarded IPs are only a fairness hint, not authentication. */
type Bucket = { start: number; count: number };
type Limits = { buckets: Map<string, Bucket>; active: number; reads: number };
const globalLimits = globalThis as typeof globalThis & { nbdaoApiLimits?: Limits };
const limits = globalLimits.nbdaoApiLimits ??= { buckets: new Map(), active: 0, reads: 0 };
const windowMs = 60000;

export function beginApiRequest(request: Request): Response | (() => void) {
  const write = request.method !== 'GET';
  if (write) {
    const origin = request.headers.get('origin');
    try {
      if (request.headers.get('sec-fetch-site') === 'cross-site' || origin && new URL(origin).host !== request.headers.get('host'))
        return Response.json({ error: '只允许从本应用提交操作' }, { status: 403 });
    } catch { return Response.json({ error: '请求来源无效' }, { status: 403 }); }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
      return Response.json({ error: '请求必须使用 JSON' }, { status: 415 });
  }
  const now = Date.now();
  for (const [key, value] of limits.buckets) if (now - value.start >= windowMs) limits.buckets.delete(key);
  const ip = (request.headers.get('x-forwarded-for') ?? 'unknown').split(',').at(-1)!.trim().slice(0, 128);
  const keys = [`global:${write}`, `${ip}:${write}`];
  if (limits.buckets.size > 4096 || limits.active >= 8 || !write && limits.reads >= 6)
    return limited();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const bucket = limits.buckets.get(key) ?? { start: now, count: 0 };
    const maximum = i === 0 ? write ? 60 : 600 : write ? 20 : 240;
    if (bucket.count >= maximum) return limited();
    bucket.count++; limits.buckets.set(key, bucket);
  }
  limits.active++; if (!write) limits.reads++;
  let released = false;
  return () => { if (!released) { released = true; limits.active--; if (!write) limits.reads--; } };
}
function limited() {
  return Response.json({ error: '请求过于频繁，请稍后重试；后台监控仍独立运行' },
    { status: 429, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' } });
}
export async function boundedBody(request: Request, maximum = 32768): Promise<string> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('请求过大');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new Error('请求过大'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function cloudDeploymentDisabled() {
  return !!(process.env.RAILWAY_ENVIRONMENT_ID && process.env.SELLER_ADDRESS);
}
