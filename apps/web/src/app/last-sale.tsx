'use client';

import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { beijingLabel, type PreviousDaySales, type SaleRecord } from '@nbdao/shared';
import './last-sale.css';

type SaleState = { result: PreviousDaySales | null; loading: boolean; failed: boolean };
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const integer = (value: unknown): value is string => typeof value === 'string' && /^\d{1,78}$/.test(value);

function previousBeijingDate() {
  return new Date(Date.now() + 8 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

function readPreviousDay(value: unknown): PreviousDaySales {
  if (!value || typeof value !== 'object') throw new Error('成交记录不可用');
  const result = value as PreviousDaySales;
  if (result.status === 'loading' && result.checkedAt === 0 && result.date === '' &&
    result.startTimestamp === '' && result.endTimestamp === '' && Array.isArray(result.records) &&
    result.records.length === 0 && result.scanBlockNumber === null && typeof result.reason === 'string') return result;
  if (!Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 || result.status === 'ready' && result.checkedAt === 0 || result.checkedAt > Date.now() + 60_000 ||
    !['loading', 'ready', 'stale'].includes(result.status) || typeof result.reason !== 'string' ||
    result.scanBlockNumber !== null && !integer(result.scanBlockNumber) ||
    typeof result.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.date) ||
    !integer(result.startTimestamp) || !integer(result.endTimestamp) || !Array.isArray(result.records)) throw new Error('核查状态不可用');
  const start = Number(result.startTimestamp), end = Number(result.endTimestamp);
  if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(end) || end - start !== 86_400 ||
    Date.parse(`${result.date}T00:00:00+08:00`) !== start * 1000) throw new Error('成交日期不可用');
  const keys = new Set<string>();
  const transactions = new Map<string, SaleRecord>();
  for (const sale of result.records) {
    if (!sale || ![sale.owner, sale.txSender, sale.recipient].every((address) => typeof address === 'string' && addressPattern.test(address)) ||
      typeof sale.txHash !== 'string' || !hashPattern.test(sale.txHash) || typeof sale.blockHash !== 'string' || !hashPattern.test(sale.blockHash) ||
      !Number.isSafeInteger(sale.chainId) || sale.chainId <= 0 || sale.source !== 'market' ||
      ![sale.timestamp, sale.blockNumber, sale.gasWei, sale.gasUsed, sale.swapUSDT].every(integer) ||
      ![sale.soldInput, sale.receivedUSDT, sale.builderFeeWei].every((amount) => amount === null || integer(amount)) ||
      !Number.isSafeInteger(Number(sale.timestamp)) || Number(sale.timestamp) < start || Number(sale.timestamp) >= end ||
      Number(sale.timestamp) * 1000 > Date.now() + 60_000 ||
      sale.soldInput !== null && BigInt(sale.soldInput) <= 0n || !Number.isSafeInteger(sale.holderCount) || sale.holderCount < 1 ||
      !Number.isSafeInteger(sale.logIndex) || sale.logIndex < 0 || typeof sale.taxReason !== 'string' || typeof sale.settlementReason !== 'string' ||
      sale.taxPercent !== null && (typeof sale.taxPercent !== 'string' || !/^(?:0|[1-9]\d?)(?:\.\d+)?$|^100(?:\.0+)?$/.test(sale.taxPercent))) throw new Error('成交记录校验失败');
    const hash = sale.txHash.toLowerCase(), key = `${hash}:${sale.logIndex}`;
    const existing = transactions.get(hash);
    if (keys.has(key) || existing && (existing.gasWei !== sale.gasWei || existing.timestamp !== sale.timestamp ||
      existing.txSender.toLowerCase() !== sale.txSender.toLowerCase())) throw new Error('成交记录重复或不一致');
    keys.add(key);
    transactions.set(hash, sale);
  }
  return result;
}

function amount(value: string) {
  const [whole, fraction] = formatUnits(BigInt(value), 18).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

function compactAmount(value: string) {
  const [whole, fraction = ''] = amount(value).split('.');
  const shortened = fraction.slice(0, 8).replace(/0+$/, '');
  return (fraction.length > 8 ? '≈' : '') + whole + (shortened ? `.${shortened}` : '');
}

function shortAddress(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }

function transactionUrl(sale: SaleRecord, explorerUrl?: string) {
  const base = explorerUrl || (sale.chainId === 56 ? 'https://bscscan.com' : '');
  if (!base) return null;
  try {
    const url = new URL(`${base.replace(/\/+$/, '')}/tx/${sale.txHash}`);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function groupSales(records: SaleRecord[]) {
  const groups = new Map<string, SaleRecord[]>();
  for (const record of records) {
    const key = record.txHash.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return [...groups.values()];
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
        const response = await fetch('/api/sales/previous-day', { cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw new Error('成交记录读取失败');
        const result = readPreviousDay(await response.json());
        if (!controller.signal.aborted) setState({ result, loading: false, failed: false });
      } catch {
        if (!controller.signal.aborted) setState((old) => ({
          result: old.result?.date === previousBeijingDate() ? old.result : null,
          loading: false, failed: true,
        }));
      } finally { inFlight = false; }
    };
    refresh.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => { controller.abort(); clearInterval(timer); refresh.current = null; };
  }, []);

  const { result, loading, failed } = state;
  const groups = groupSales(result?.records || []);
  const incomplete = failed || !result || result.status !== 'ready';
  const reason = failed ? '刷新失败，扫描未完成，可能缺记录。' : incomplete ? result?.reason || '服务端正在扫描上一天的链上卖出，扫描未完成，可能缺记录。' : '';

  return <section className="panel last-sale" aria-label="上一天全部成功卖出" data-testid="last-sale">
    <div className="panel-heading last-sale-heading">
      <div><div className="eyebrow">NBDAO / USDT 池 · 全池成交记录</div><h2>上一天全部成功卖出</h2></div>
      <button type="button" className="button compact" data-testid="last-sale-refresh" disabled={loading} onClick={() => refresh.current?.()}>{loading ? '刷新中…' : '刷新记录 ↻'}</button>
    </div>
    <div aria-live="polite">
      <div className="last-sale-summary">
        <div><span>北京时间日期</span><strong data-testid="last-sale-date">{result?.date || '正在读取…'}</strong><small>00:00 至次日 00:00</small></div>
        <div><span>{incomplete ? '已扫描成功交易' : '成功交易'}</span><strong data-testid="last-sale-transactions">{groups.length}<small>笔</small></strong></div>
        <div><span>{incomplete ? '已扫描卖出记录' : '卖出记录'}</span><strong data-testid="last-sale-records">{result?.records.length || 0}<small>条</small></strong></div>
        <span className={`last-sale-status${incomplete ? ' expired' : ''}`} data-testid="last-sale-status">{incomplete ? '扫描未完成' : '全日扫描完成'}</span>
      </div>
      {reason && <p className="last-sale-stale" role="status">{failed && groups.length > 0 && '保留同一天已核实的记录。'}{reason}{result?.status === 'stale' && !failed && ' 扫描未完成，可能缺记录。'}</p>}
      <p className="last-sale-note">记录包含其他钱包，同一批量交易分条展示；Gas 为整笔交易的实际费用，只在交易标题中列一次。扣税率包含基础与利润扣费，不含兑换费、Gas 和排序费。</p>
      {groups.length > 0 ? <div className="last-sale-transactions">
        {groups.map((sales) => {
          const first = sales[0], link = transactionUrl(first, explorerUrl);
          return <article className="last-sale-transaction" key={first.txHash} data-testid="sale-transaction">
            <div className="last-sale-transaction-heading">
              <div><h3>{beijingLabel(first.timestamp)} <small>北京时间</small></h3><p>{sales.length} 条卖出 · 区块 #{first.blockNumber}</p></div>
              {link ? <a className="transaction-link" href={link} target="_blank" rel="noopener noreferrer" title={first.txHash}>查看交易 ↗</a> : <code className="last-sale-hash">{first.txHash}</code>}
            </div>
            <div className="last-sale-transaction-meta">
              <div className="last-sale-sender"><span>交易发起者</span><code data-testid="sale-tx-sender">{first.txSender}</code></div>
              <div className="last-sale-gas"><span>整笔实际 Gas</span><strong data-testid="sale-gas">{amount(first.gasWei)} <small>BNB</small></strong></div>
            </div>
            <table className="last-sale-table"><thead><tr><th scope="col">持币钱包</th><th scope="col">卖出代币数</th><th scope="col">实际扣税率</th><th scope="col">实收 USDT</th></tr></thead><tbody>
              {sales.map((sale) => <tr key={`${sale.txHash}:${sale.logIndex}`} data-testid="sale-record">
                <td data-label="持币钱包"><code data-testid="sale-owner">{sale.owner}</code>{sale.recipient.toLowerCase() !== sale.owner.toLowerCase() && <small className="last-sale-row-note" title={sale.recipient}>兑换收款地址 {shortAddress(sale.recipient)}</small>}</td>
                <td data-label="卖出代币数"><strong data-testid="sale-input" title={sale.soldInput === null ? undefined : `${amount(sale.soldInput)} NBDAO`}>{sale.soldInput === null ? '无法确认' : compactAmount(sale.soldInput)}</strong>{sale.soldInput !== null && <small className="last-sale-unit">NBDAO</small>}</td>
                <td data-label="实际扣税率"><strong data-testid="sale-tax">{sale.taxPercent === null ? '无法确认' : `${sale.taxPercent}%`}</strong>{sale.taxPercent === null && <small className="last-sale-row-note">{sale.taxReason}</small>}</td>
                <td data-label="实收 USDT"><strong className={sale.receivedUSDT === null ? 'last-sale-unavailable' : undefined} data-testid="sale-output" title={sale.receivedUSDT === null ? undefined : `${amount(sale.receivedUSDT)} USDT`}>{sale.receivedUSDT === null ? '无法确认' : compactAmount(sale.receivedUSDT)}</strong>{sale.receivedUSDT !== null ? <small className="last-sale-unit">USDT</small> : <small className="last-sale-row-note">兑换换出 <span title={`${amount(sale.swapUSDT)} USDT`}>{compactAmount(sale.swapUSDT)}</span> USDT；{sale.settlementReason || '持币钱包最终实收无法确认。'}</small>}</td>
              </tr>)}
            </tbody></table>
            {first.builderFeeWei !== null && BigInt(first.builderFeeWei) > 0n && <p className="last-sale-note">整笔另付抢排序费 {amount(first.builderFeeWei)} BNB，未计入上方 Gas。</p>}
          </article>;
        })}
      </div> : <p className="last-sale-empty" data-testid="last-sale-empty">{!incomplete ? '该日未查到外部卖出。' : failed ? '暂时无法读取记录，请刷新重试。' : '正在扫描该日成交，已核实的记录会陆续显示。'}</p>}
      {result && result.checkedAt > 0 && <p className="last-sale-checked">最后核查 {beijingLabel(result.checkedAt / 1000)} · 北京时间{result.scanBlockNumber && ` · 扫描区块 #${result.scanBlockNumber}`}</p>}
    </div>
  </section>;
}
