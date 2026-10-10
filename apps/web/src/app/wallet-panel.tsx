'use client';

import { useEffect, useRef, useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, type Connector } from 'wagmi';
import { display, shortAddress, type AppConfig, type WalletSnapshot } from '@nbdao/shared';
import { walletConnectState } from './providers';
import { walletError } from '@/lib/wallet-errors';
import { WalletSession } from '@/lib/wallet-session';

type Choice = { connector: Connector; name: string };
function providerName(provider: unknown) {
  const flags = provider as Record<string, unknown> | undefined;
  if (flags?.isRabby) return 'Rabby';
  if (flags?.isTrust || flags?.isTrustWallet) return 'Trust Wallet';
  if (flags?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (flags?.isBraveWallet) return 'Brave Wallet';
  if (flags?.isOkxWallet || flags?.isOKExWallet) return 'OKX Wallet';
  if (flags?.isMetaMask) return 'MetaMask';
  return '浏览器钱包';
}
export default function WalletPanel({ config, wallet, fresh, refreshing, busy, refresh, open, setOpen }: {
  config: AppConfig | null; wallet: Pick<WalletSnapshot, 'owner'|'bnbBalance'> | null; fresh: boolean; refreshing: boolean; busy: boolean;
  refresh: () => Promise<void>; open: boolean; setOpen: (open: boolean) => void;
}) {
  const connection = useConnection();
  const { address, chainId, status } = connection;
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [scan, setScan] = useState(0);
  const [pendingName, setPendingName] = useState('');
  const [error, setError] = useState('');
  const [lastChoice, setLastChoice] = useState<Choice | null>(null);
  const [copied, setCopied] = useState(false);
  const connectingRef = useRef(false);
  const switchingRef = useRef(false);
  const modal = useRef<HTMLElement>(null);
  const connectorKey = connectors.map((connector) => connector.uid).join(':');
  const session = useRef(new WalletSession());
  const generation = session.current.update(`${address || ''}:${chainId || ''}:${connection.connector?.uid || ''}:${status}`);
  const connected = status === 'connected' && !!address;
  const sameChain = !!config && config.chainId === chainId;
  const currentWallet = wallet?.owner.toLowerCase() === address?.toLowerCase() && sameChain ? wallet : null;
  const injectedChoices = choices.filter(({ connector }) => connector.type === 'injected');
  const connectedName = choices.find((choice) => choice.connector.uid === connection.connector?.uid)?.name || (connection.connector?.name === 'Injected' ? '浏览器钱包' : connection.connector?.name);
  const network = chainId === 56 ? 'BSC · 56' : chainId === 31337 ? '本地测试 · 31337' : chainId ? `当前网络 · ${chainId}` : '网络待确认';

  useEffect(() => {
    let cancelled = false;
    setDetecting(true);
    void Promise.all(connectors.map(async (connector) => {
      if (connector.type !== 'injected') return { connector, provider: null };
      try {
        const provider = await connector.getProvider();
        return { connector, provider: provider && typeof (provider as { request?: unknown }).request === 'function' ? provider : null };
      } catch { return { connector, provider: null }; }
    })).then((results) => {
      if (cancelled) return;
      const named = results.filter((entry) => entry.connector.type === 'injected' && entry.connector.id !== 'injected' && entry.provider);
      const ids = new Set<string>();
      const providers = new Set<unknown>();
      const discovered: Choice[] = [];
      for (const entry of results) {
        const { connector, provider } = entry;
        if (connector.type === 'injected' && (!provider || connector.id === 'injected' && named.length > 0)) continue;
        if (ids.has(connector.id) || provider && providers.has(provider)) continue;
        ids.add(connector.id); if (provider) providers.add(provider);
        discovered.push({ connector, name: connector.id === 'injected' ? providerName(provider) : connector.name });
      }
      setChoices(discovered); setDetecting(false);
    });
    return () => { cancelled = true; };
  }, [connectorKey, scan]);
  useEffect(() => {
    const request = () => { window.dispatchEvent(new Event('eip6963:requestProvider')); setScan((value) => value + 1); };
    window.addEventListener('ethereum#initialized', request);
    const late = setTimeout(request, 700);
    return () => { clearTimeout(late); window.removeEventListener('ethereum#initialized', request); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => modal.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (event.key !== 'Tab') return;
      const elements = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); previousFocus?.focus(); };
  }, [open, setOpen]);
  useEffect(() => { setCopied(false); setError(''); }, [address, chainId, connection.connector?.uid]);
  async function choose(choice: Choice) {
    if (connectingRef.current || busy || status === 'reconnecting') return;
    connectingRef.current = true; setPendingName(choice.name); setLastChoice(choice); setError('');
    try { await connect.mutateAsync({ connector: choice.connector }); setOpen(false); }
    catch (e) { setError(walletError(e, '钱包连接失败，请检查钱包后重试。')); }
    finally { connectingRef.current = false; setPendingName(''); }
  }
  async function switchNetwork() {
    if (!config || !connected || busy || switchingRef.current) return;
    switchingRef.current = true; setError('');
    try {
      await switchChain.mutateAsync({ chainId: config.chainId, addEthereumChainParameter: {
        chainName: config.chainId === 56 ? 'BNB Smart Chain' : '本地测试链',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: [config.walletRpcUrl],
        ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}),
      } });
    } catch (e) { if (session.current.isCurrent(generation)) setError(walletError(e, '网络切换失败，请在钱包中切换到目标网络后重试。')); }
    finally { switchingRef.current = false; }
  }
  async function copyAddress() {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); if (session.current.isCurrent(generation)) setCopied(true); }
    catch { if (session.current.isCurrent(generation)) setError('复制失败，请长按或选中完整地址复制。'); }
  }
  const stateLabel = pendingName ? `请在 ${pendingName} 中确认连接` : status === 'reconnecting' ? '正在恢复钱包连接' : status === 'connecting' ? '等待钱包连接确认' : connected ? '钱包已连接' : '钱包未连接';
  return <>
    <button className={connected ? 'wallet-button' : 'button primary'} data-testid="wallet-open" onClick={() => setOpen(true)}>
      {connected && address ? <><span className="wallet-dot" />{shortAddress(address)}</> : status === 'reconnecting' || status === 'connecting' || pendingName ? <><span className="spinner" />连接处理中</> : '连接钱包'}
    </button>
    {open && <div className="modal-backdrop" onClick={() => setOpen(false)}><section ref={modal} className="wallet-modal" data-testid="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(event) => event.stopPropagation()}>
      <div className="modal-heading"><h2 id="wallet-title">{connected ? '当前钱包' : '连接持币钱包'}</h2><button className="close-button" aria-label="关闭钱包窗口" onClick={() => setOpen(false)}>×</button></div>
      <div className="wallet-state" data-testid="wallet-connect-status" role="status"><span className={connected ? 'wallet-state-dot' : 'small-dot'} />{stateLabel}</div>
      {connected && address ? <>
        <div className="wallet-identity"><span>{connectedName}</span><p className="full-address" data-testid="wallet-full-address">{address}</p><button data-testid="wallet-copy-address" className="button compact" onClick={() => { void copyAddress(); }}>{copied ? '已复制地址' : '复制完整地址'}</button></div>
        <div className="wallet-network"><div><span>当前链</span><strong data-testid="wallet-chain">{network}</strong></div><div><span>钱包 BNB</span><strong data-testid="wallet-bnb">{fresh && currentWallet ? display(currentWallet.bnbBalance, 6) : '—'} BNB</strong></div></div>
        {!sameChain && config && <div className="wallet-network-warning"><p>请选择 {config.chainName}（{config.chainId}）后读取余额和操作。</p><button data-testid="wallet-switch-chain" className="button secondary compact" disabled={busy || switchChain.isPending} onClick={() => { void switchNetwork(); }}>{switchChain.isPending ? '请确认切换网络' : config.chainId === 56 ? '切换 / 添加 BSC' : '切换本地测试链'}</button></div>}
        <button className="button compact full wallet-refresh" data-testid="wallet-refresh" disabled={!sameChain || refreshing} onClick={() => { void refresh(); }}>{refreshing ? '正在刷新余额' : '刷新钱包余额'}</button>
        <p className="wallet-disconnect-note">断开连接不会取消链上任务。需要停止卖出时，请在任务区取消。</p>
        <button data-testid="wallet-disconnect" className="button secondary full" disabled={disconnect.isPending} onClick={() => { void disconnect.mutateAsync().then(() => { setOpen(false); setError(''); }).catch((e) => setError(walletError(e))); }}>{disconnect.isPending ? '正在断开' : '断开连接'}</button>
      </> : <>
        <p className="muted">连接后读取余额，资产操作均由你的钱包确认。</p>
        {detecting && <p className="wallet-detecting" role="status">正在检测可用钱包…</p>}
        {!detecting && injectedChoices.length === 0 && <div className="wallet-no-provider" data-testid="wallet-no-provider"><strong>未检测到浏览器钱包</strong><p>请在已安装钱包扩展的浏览器打开此页面；使用手机钱包时，可配置 WalletConnect 后扫码连接。</p><button className="button compact" data-testid="wallet-rescan" onClick={() => { window.dispatchEvent(new Event('eip6963:requestProvider')); setScan((value) => value + 1); }}>重新检测</button></div>}
        {choices.map((choice) => <button key={choice.connector.uid} data-testid={`wallet-connector-${choice.connector.id}`} className="connector-option" disabled={!!pendingName || busy || status === 'reconnecting' || status === 'connecting'} onClick={() => { void choose(choice); }}><span className="connector-name"><span className="connector-avatar">{choice.name.slice(0, 1)}</span>{choice.name}</span><span>{pendingName === choice.name ? '等待确认' : '连接 →'}</span></button>)}
        {walletConnectState !== 'enabled' && <p className="wallet-config-note">{walletConnectState === 'invalid' ? '手机钱包连接配置无效：Project ID 应为 32 位十六进制字符。' : '手机钱包连接尚未配置；配置 WalletConnect Project ID 后可启用扫码连接。'}</p>}
      </>}
      {error && <div className="inline-error" data-testid="wallet-error" role="alert">{error}{lastChoice && !connected && choices.some((choice) => choice.connector.uid === lastChoice.connector.uid) && <button className="wallet-retry" disabled={!!pendingName || busy} onClick={() => { void choose(lastChoice); }}>重试连接</button>}</div>}
      {busy && <p className="wallet-config-note">另有钱包操作尚未结束，请等待回执后再发起新的操作。</p>}
    </section></div>}
  </>;
}
