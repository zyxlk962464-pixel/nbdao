'use client';

import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { beijingLabel, type LatestSale, type SaleRecord } from '@nbdao/shared';
import './last-sale.css';

type SaleState = { result: LatestSale | null; loading: boolean; failed: boolean };
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const integer = (value: unknown): value is string => typeof value === 'string' && /^\d{1,78}$/.test(value);

function readLatestSale(value: unknown): LatestSale {
  if (!value || typeof value !== 'object') throw new Error('成交记录不可用');
  const result = value as LatestSale;
  if (!Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 || result.status === 'ready' && result.checkedAt === 0 || result.checkedAt > Date.now() + 60_000 ||
    !['loading', 'ready', 'stale'].includes(result.status) || typeof result.reason !== 'string' ||
    result.scanBlockNumber !== null && !integer(result.scanBlockNumber)) throw new Error('核查状态不可用');
  if (result.sale === null) return result;
  const sale = result.sale;
  if (!sale || ![sale.owner, sale.txSender, sale.recipient].every((address) => typeof address === 'string' && addressPattern.test(address)) ||
    typeof sale.txHash !== 'string' || !hashPattern.test(sale.txHash) || typeof sale.blockHash !== 'string' || !hashPattern.test(sale.blockHash) ||
    !Number.isSafeInteger(sale.chainId) || sale.chainId <= 0 || sale.source !== 'market' ||
    ![sale.timestamp, sale.blockNumber, sale.gasWei, sale.gasUsed, sale.swapUSDT].every(integer) ||
    ![sale.soldInput, sale.receivedUSDT, sale.builderFeeWei].every((amount) => amount === null || integer(amount)) ||
    Number(sale.timestamp) <= 0 || !Number.isSafeInteger(Number(sale.timestamp)) || Number(sale.timestamp) * 1000 > Date.now() + 60_000 ||
    sale.soldInput !== null && BigInt(sale.soldInput) <= 0n || !Number.isSafeInteger(sale.holderCount) || sale.holderCount < 1 ||
    !Number.isSafeInteger(sale.logIndex) || sale.logIndex < 0 || typeof sale.taxReason !== 'string' || typeof sale.settlementReason !== 'string' ||
    sale.taxPercent !== null && (typeof sale.taxPercent !== 'string' || !/^(?:0|[1-9]\d?)(?:\.\d+)?$|^100(?:\.0+)?$/.test(sale.taxPercent))) throw new Error('成交记录校验失败');
  return result;
}

function amount(value: string) {
  const [whole, fraction] = formatUnits(BigInt(value), 18).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

function transactionUrl(sale: SaleRecord, explorerUrl?: string) {
  const base = explorerUrl || (sale.chainId === 56 ? 'https://bscscan.com' : '');
  if (!base) return null;
  try {
    const url = new URL(`${base.replace(/\/+$/, '')}/tx/${sale.txHash}`);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export default function LastSale({ explorerUrl }: { explorerUrl?: string }) {
  const [state, setState] = useState<SaleState>({ result: null, loading: true, failed: false });
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      setState((old) => ({ ...old, loading: true }));
      try {
        const response = await fetch('/api/sales/latest', { cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw new Error('成交记录读取失败');
        const result = readLatestSale(await response.json());
        if (!controller.signal.aborted) setState({ result, loading: false, failed: false });
      } catch {
        if (!controller.signal.aborted) setState((old) => ({ ...old, loading: false, failed: true }));
      } finally { inFlight = false; }
    };
    refresh.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => { controller.abort(); clearInterval(timer); refresh.current = null; };
  }, []);

  const { result, loading, failed } = state;
  const sale = result?.sale || null;
  const expired = failed || result?.status === 'stale' || result?.status === 'loading';
  const reason = failed ? '刷新失败，当前最新成交状态待重新核查。' : result?.status !== 'ready' ? result?.reason || '服务端正在核查链上成交。' : '';
  const link = sale ? transactionUrl(sale, explorerUrl) : null;

  return <section className="panel last-sale" aria-label="上一次成功卖出" data-testid="last-sale">
    <div className="panel-heading last-sale-heading">
      <div><div className="eyebrow">NBDAO / USDT 池 · 全池成交记录</div><h2>上一次成功卖出</h2></div>
      <button type="button" className="button compact" data-testid="last-sale-refresh" disabled={loading} onClick={() => refresh.current?.()}>{loading ? '刷新中…' : '刷新记录 ↻'}</button>
    </div>
    <div aria-live="polite">
      {sale ? <>
        <div className="last-sale-wallet"><span>持币钱包</span><code data-testid="last-sale-owner">{sale.owner}</code></div>
        {sale.txSender.toLowerCase() !== sale.owner.toLowerCase() && <p className="last-sale-note">交易发起者 {sale.txSender}</p>}
        {sale.recipient.toLowerCase() !== sale.owner.toLowerCase() && <p className="last-sale-note">兑换收款地址 {sale.recipient}</p>}
        <div className="last-sale-metrics">
          <div className="metric"><span>卖出代币数</span><strong data-testid="last-sale-input">{sale.soldInput === null ? '无法确认' : amount(sale.soldInput)}{sale.soldInput !== null && <small>NBDAO</small>}</strong></div>
          <div className="metric"><span>实际 Gas</span><strong data-testid="last-sale-gas">{amount(sale.gasWei)}<small>BNB</small></strong></div>
          <div className="metric"><span>实际代币扣税率</span><strong data-testid="last-sale-tax">{sale.taxPercent === null ? '无法确认' : `${sale.taxPercent}%`}</strong></div>
          <div className="metric"><span>实收 USDT</span><strong className={sale.receivedUSDT === null ? 'last-sale-unavailable' : undefined} data-testid="last-sale-output">{sale.receivedUSDT === null ? '由其他地址收取 / 无法确认' : amount(sale.receivedUSDT)}{sale.receivedUSDT !== null && <small>USDT</small>}</strong></div>
        </div>
        <p className="last-sale-note">按该笔日志核算，包含基础与利润扣费，不含兑换费、Gas 和排序费。</p>
        {sale.taxPercent === null && sale.taxReason && <p className="last-sale-note" data-testid="last-sale-tax-reason">{sale.taxReason}</p>}
        {sale.receivedUSDT === null && <p className="last-sale-note" data-testid="last-sale-settlement">本次兑换换出 {amount(sale.swapUSDT)} USDT；{sale.settlementReason || '持币钱包最终实收无法确认。'}</p>}
        {sale.holderCount > 1 && <p className="last-sale-note">本笔包含 {sale.holderCount} 个持币地址，展示其中最后一次实际卖出；Gas 为整笔交易消耗。</p>}
        {sale.builderFeeWei !== null && BigInt(sale.builderFeeWei) > 0n && <p className="last-sale-note">另付抢排序费 {amount(sale.builderFeeWei)} BNB；单独列示，未计入上方 Gas。</p>}
        <div className="last-sale-meta"><span>成交时间 {beijingLabel(sale.timestamp)} · 北京时间</span><span className={`last-sale-status${expired ? ' expired' : ''}`} data-testid="last-sale-status">{expired ? result?.status === 'loading' && !failed ? '正在核查最新成交' : '核查已过期' : '已确认成功'}</span></div>
        {link ? <a className="transaction-link" href={link} target="_blank" rel="noopener noreferrer">查看成交交易 ↗</a> : <p className="last-sale-hash">交易 {sale.txHash}</p>}
      </> : <p className="last-sale-empty" data-testid="last-sale-empty">{failed || result?.status === 'stale' ? '池内成交记录暂不可用，请刷新重试。' : !result || result.status === 'loading' ? '服务端正在核查链上成交…' : '暂未找到可核实的池内卖出。'}</p>}
      {reason && <p className={expired && sale ? 'last-sale-stale' : 'last-sale-note'} role="status">{expired && sale && '显示上次已确认的记录。'}{reason}</p>}
      {result && result.checkedAt > 0 && <p className="last-sale-checked">最后核查 {beijingLabel(result.checkedAt / 1000)} · 北京时间{result.scanBlockNumber && ` · 扫描区块 #${result.scanBlockNumber}`}</p>}
    </div>
  </section>;
}
