'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, http } from 'viem';
import { beijingLabel, type SellTaxSnapshot } from '@nbdao/shared';
import TaxHistoryPanel from './tax-history';

const stale = (timestamp: string) => !/^\d+$/.test(timestamp) || Number(timestamp) * 1000 < Date.now() - 30000 || Number(timestamp) * 1000 > Date.now() + 10000;

export default function SellTax({ chainId, readOnly, rpcUrl, blockPollMs = 500 }: { chainId?: number; readOnly: boolean; rpcUrl?: string; blockPollMs?: number }) {
  const [snapshot, setSnapshot] = useState<SellTaxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let queued = false;
    let latest: SellTaxSnapshot | null = null;
    const load = async () => {
      if (controller.signal.aborted) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      try {
        const response = await fetch('/api/tax', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4500)]) });
        if (!response.ok) throw new Error('税率读取失败');
        const result = await response.json() as SellTaxSnapshot;
        if (!/^\d+$/.test(result.blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(result.blockHash) || stale(result.timestamp) || typeof result.reason !== 'string' ||
          result.sellFeeAfterSync !== null && (!/^\d+$/.test(result.sellFeeAfterSync) || Number(result.sellFeeAfterSync) > 100)) throw new Error('税率快照不可用');
        if (!controller.signal.aborted) { latest = result; setSnapshot(result); setFailed(false); }
      } catch { if (!controller.signal.aborted) { latest = null; setSnapshot(null); setFailed(true); } }
      finally { inFlight = false; if (!controller.signal.aborted) { setLoading(false); if (queued) { queued = false; void load(); } } }
    };
    setSnapshot(null); setLoading(true); setFailed(false);
    const client = createPublicClient({ transport: http(rpcUrl || 'https://bsc-dataseed.bnbchain.org', { timeout: 5000, retryCount: 0 }) });
    const unwatch = client.watchBlockNumber({ poll: true, pollingInterval: blockPollMs, emitOnBegin: true, emitMissed: false,
      onBlockNumber: () => { void load(); },
      onError: () => { if (!controller.signal.aborted) { latest = null; setSnapshot(null); setFailed(true); setLoading(false); } },
    });
    const expire = setInterval(() => {
      if (latest && stale(latest.timestamp)) { latest = null; setSnapshot(null); setFailed(true); }
    }, 1000);
    return () => { controller.abort(); unwatch(); clearInterval(expire); };
  }, [chainId, rpcUrl, blockPollMs]);

  const fee = snapshot?.sellFeeAfterSync ?? null;
  const basicRate = fee === null ? null : Number(fee);
  const allocationAvailable = basicRate !== null && (basicRate === 0 || basicRate >= 3);
  const basicFixed = allocationAvailable ? basicRate === 0 ? '0%' : '1%' : '待有效快照';
  const highRate = allocationAvailable ? `${Math.max(0, basicRate! - 3)}%` : '待有效快照';
  return <div className="sell-tax-reference" data-testid="sell-tax-reference" aria-live="polite">
    <div className="sell-tax-main"><div><span>当前预计基础卖出税率</span><strong data-testid="sell-tax-value">{fee === null ? loading && !failed ? '读取中…' : '暂不可用' : `${fee}%`}</strong></div>
      <div className="sell-tax-target"><span>费用参考</span><strong className="tax-unavailable" data-testid="sell-tax-status">{fee === null ? '暂不可用' : '以实际到账为准'}</strong></div></div>
    <div className="sell-tax-meta"><span>{snapshot ? `快照 #${snapshot.blockNumber} · ${beijingLabel(snapshot.timestamp)}` : failed ? '读取失败或快照过期，不采用旧税率' : '读取当前链上状态'}</span><span>{readOnly ? '只读观察 · ' : ''}新区块刷新</span></div>
    {snapshot && fee === null && snapshot.reason && <p>{snapshot.reason}</p>}
    <p>自然同步后的预计基础税，不含利润扣费；交易入块时仍可变化。新任务按最低到账金额判断成交，税率仅供参考。</p>
    <TaxHistoryPanel />
    {chainId === 56 && <details className="tax-breakdown" open data-testid="tax-breakdown">
      <summary>卖出扣费组成 <span>规则与计算基数</span></summary>
      <div className="tax-cost-group"><div className="tax-cost-heading"><strong>基础卖出税</strong><span>按本笔卖出量计算</span></div>
        <dl className="tax-cost-list" data-testid="basic-tax-parts">
          <div><dt>挖矿奖励</dt><dd>{basicFixed}</dd></div><div><dt>团队分配</dt><dd>{basicFixed}</dd></div>
          <div><dt>资金池名义份额</dt><dd>{basicFixed}</dd></div><div><dt>动态高税附加部分</dt><dd data-testid="high-tax-part">{highRate}</dd></div>
        </dl>
        <p>以上是基础税内部的名义拆分，已包含在上方 {fee === null ? '待确认的基础税' : `${fee}% 基础税`} 中，不会再加收一次。实际按整数金额及内部换币结果分配。</p>
        <p>高税部分等于基础税超过 3% 的部分：例如基础税 100% 时为 97%，基础税 20% 时为 17%。这部分换成 USDT 后统一支付给代币的高税收款地址（highFeeAddress）；代币源码未将它再拆成团队税或基金会税，收款地址可由代币管理员修改。利润扣费另计。</p>
      </div>
      <div className="tax-cost-group"><div className="tax-cost-heading"><strong>利润扣费</strong><span>利润计费部分的 25%</span></div>
        <dl className="tax-cost-list"><div><dt>挖矿奖励</dt><dd>5%</dd></div><div><dt>基金会</dt><dd>5%</dd></div><div><dt>团队分配</dt><dd>10%</dd></div><div><dt>资金池名义份额</dt><dd>5%</dd></div></dl>
        <p>这四项均按利润计费部分计算。实际扣费取决于本笔金额、钱包成本记录与未售奖励；奖励或成本足额时可为 0。这里展示分配规则，未估算你本笔的实际利润税。</p>
      </div>
      <div className="tax-cost-group"><div className="tax-cost-heading"><strong>兑换与网络费用</strong><span>计算基数不同</span></div>
        <dl className="tax-cost-list"><div><dt>直接卖出 · Pancake V2</dt><dd>0.25%</dd></div><div><dt>团队费用换币 · V3</dt><dd>0.01%</dd></div><div><dt>网络 Gas</dt><dd>按实际 BNB 消耗</dd></div></dl>
        <p>V2 作用于实际入池量；V3 仅作用于内部团队费用换币额。池内调整、价格冲击也会影响实收，不能把这些比例直接相加当成总税率。</p>
      </div>
      <p className="tax-cost-example">例如：基础税 5%、无奖励抵扣且无成本记录时，利润扣费为卖出量的 23.75%，代币扣费合计 28.75%；还需考虑兑换费用、价格影响与 Gas。</p>
    </details>}
  </div>;
}
