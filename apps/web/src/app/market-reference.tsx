'use client';

import { useEffect, useRef, useState } from 'react';
import { BSC, beijingLabel, type AppConfig, type PriceSnapshot, type WalletSnapshot } from '@nbdao/shared';
import { holdingReference, referenceNumber } from '@/lib/reference-price';

export default function MarketReference({ config, wallet, walletFresh, status, chainMatched }: {
  config: AppConfig | null; wallet: WalletSnapshot | null; walletFresh: boolean; status: string; chainMatched: boolean;
}) {
  const [price, setPrice] = useState<PriceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true; setLoading(true);
      try {
        const response = await fetch('/api/price', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (!response.ok) throw new Error('价格读取失败');
        const result = await response.json() as PriceSnapshot;
        const addresses = config?.addresses || BSC;
        if (result.chainId !== (config?.chainId || 56) || result.pair.toLowerCase() !== addresses.pair.toLowerCase() || result.token.toLowerCase() !== addresses.token.toLowerCase() || result.usdt.toLowerCase() !== addresses.usdt.toLowerCase() ||
          ![result.reserveToken, result.reserveUSDT, result.spotPriceUSDTPerTokenWei, result.blockNumber, result.timestamp].every((value) => /^\d+$/.test(value)) ||
          !Number.isInteger(result.tokenDecimals) || result.tokenDecimals < 0 || result.tokenDecimals > 36 || !Number.isInteger(result.usdtDecimals) || result.usdtDecimals < 0 || result.usdtDecimals > 36 ||
          BigInt(result.reserveToken) <= 0n || BigInt(result.reserveUSDT) <= 0n) throw new Error('池子价格数据不可用');
        const expected = BigInt(result.reserveUSDT) * 10n ** BigInt(result.tokenDecimals) * 10n ** 18n / (BigInt(result.reserveToken) * 10n ** BigInt(result.usdtDecimals));
        if (expected !== BigInt(result.spotPriceUSDTPerTokenWei)) throw new Error('池子价格精度不匹配');
        if (!controller.signal.aborted) { setPrice(result); setFailed(false); }
      } catch { if (!controller.signal.aborted) { setPrice(null); setFailed(true); } }
      finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    };
    setPrice(null); setFailed(false); retry.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { controller.abort(); clearInterval(timer); retry.current = null; };
  }, [config?.chainId, config?.addresses.pair, config?.addresses.token, config?.addresses.usdt]);

  let value: string | null = null;
  if (price && wallet && walletFresh && status === 'connected' && chainMatched) {
    try { value = referenceNumber(holdingReference(wallet.tokenBalance, wallet.reserveUSDT, wallet.reserveToken), price.usdtDecimals, 4, BigInt(wallet.tokenBalance) > 0n); }
    catch { value = null; }
  }
  const priceLabel = price ? referenceNumber(BigInt(price.spotPriceUSDTPerTokenWei), 18, 8, true) : loading && !failed ? '读取中…' : '暂不可用';
  const holdingLabel = !price ? '暂不可用' : status === 'reconnecting' ? '钱包恢复后显示' : status !== 'connected' ? '连接钱包后显示' : !chainMatched ? '切换目标网络后显示' : value === null ? '余额核查后显示' : value;
  return <div className="market-reference" data-testid="market-reference">
    <div className="market-metrics"><div><span>池内参考价格</span><strong className={price ? '' : 'unavailable'} data-testid="token-reference-price">{priceLabel}{price && <small>USDT / NBDAO</small>}</strong></div><div><span>持仓参考估值</span><strong className={value === null ? 'unavailable' : ''} data-testid="holding-reference-value">{holdingLabel}{value !== null && <small>USDT</small>}</strong>{value !== null && wallet && <span className="holding-snapshot">钱包快照 #{wallet.blockNumber}</span>}</div></div>
    <div className="market-meta"><span>{price ? `价格区块 #${price.blockNumber} · ${beijingLabel(price.timestamp)}` : failed ? '价格读取失败，不采用上次价格' : '读取交易池储备'}</span><button data-testid="price-refresh" disabled={loading} onClick={() => retry.current?.()}>{loading ? '刷新中…' : '刷新价格 ↻'}</button></div>
    <p>按池储备计算，未扣卖出税、利润费用、价格冲击和 Gas，不代表可卖出到账。</p>
  </div>;
}
