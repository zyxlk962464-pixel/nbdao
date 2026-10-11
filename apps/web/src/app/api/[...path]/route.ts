import { NextRequest, NextResponse } from 'next/server';
import { beginApiRequest, boundedBody } from '@/lib/api-security';

export const dynamic = 'force-dynamic';
const allowedRead = /^(?:config|price|tax(?:\/history)?|wallet\/0x[a-fA-F0-9]{40}|tasks\/0x[a-fA-F0-9]{40}|task\/0x[a-fA-F0-9]{64})$/;
const allowedWrite = /^(?:quote|tasks\/register)$/;

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join('/');
  if (!(req.method === 'GET' ? allowedRead : allowedWrite).test(path)) return NextResponse.json({ error: '未知接口' }, { status: 404 });
  const release = beginApiRequest(req);
  if (release instanceof Response) return release;
  // Keep the execution service private; the browser only calls this same-origin route.
  const base = process.env.KEEPER_API_URL || 'http://127.0.0.1:8787';
  try {
    let body: string | undefined;
    try { body = req.method === 'POST' ? await boundedBody(req) : undefined; }
    catch { return NextResponse.json({ error: '请求体过大或编码无效' }, { status: 413 }); }
    const response = await fetch(`${base.replace(/\/$/, '')}/${path}`, {
      method: req.method, headers: { 'Content-Type': 'application/json' }, body,
      cache: 'no-store', signal: AbortSignal.timeout(path === 'quote' ? 120000 : 15000),
    });
    const content = await response.text();
    return new NextResponse(content, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '执行服务暂时不可用，请检查本地服务与 RPC 配置。' }, { status: 503 });
  } finally { release(); }
}
export const GET = proxy;
export const POST = proxy;
