import { NextRequest, NextResponse } from 'next/server';
import { isAddress, type Address, type Hex } from 'viem';
import { deploymentReceipt } from '@/lib/deployment-server';
import { beginApiRequest, cloudDeploymentDisabled } from '@/lib/api-security';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  if (cloudDeploymentDisabled()) return NextResponse.json({ error: '线上合约已配置，重复部署接口已关闭' }, { status: 403 });
  const owner = request.nextUrl.searchParams.get('owner'), hash = request.nextUrl.searchParams.get('hash'), nonce = request.nextUrl.searchParams.get('nonce'), runtimeHash = request.nextUrl.searchParams.get('runtimeHash');
  if (!owner || !isAddress(owner) || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash) || !runtimeHash || !/^0x[0-9a-fA-F]{64}$/.test(runtimeHash) || !nonce || !/^\d+$/.test(nonce) || !Number.isSafeInteger(Number(nonce))) return NextResponse.json({ error: '回执核查参数无效' }, { status: 400 });
  const release = beginApiRequest(request);
  if (release instanceof Response) return release;
  try { return NextResponse.json(await deploymentReceipt(hash as Hex, owner as Address, Number(nonce), runtimeHash as Hex), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return NextResponse.json({ error: (error as { shortMessage?: string; message?: string }).shortMessage || (error as Error).message || '回执核查失败，不会重新发送' }, { status: 422 }); }
  finally { release(); }
}
