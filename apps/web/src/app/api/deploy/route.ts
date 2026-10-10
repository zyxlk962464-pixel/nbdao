import { NextRequest, NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { deploymentInfo, deploymentPreflight } from '@/lib/deployment-server';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const owner = request.nextUrl.searchParams.get('owner');
    if (!owner) return NextResponse.json(deploymentInfo(), { headers: { 'Cache-Control': 'no-store' } });
    if (!isAddress(owner)) return NextResponse.json({ error: '钱包地址无效' }, { status: 400 });
    return NextResponse.json(await deploymentPreflight(owner as Address), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: (error as { shortMessage?: string; message?: string }).shortMessage || (error as Error).message || '部署预检失败，未发送交易' }, { status: 422 }); }
}
