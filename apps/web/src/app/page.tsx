'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection, useSignMessage, useSwitchChain, useWriteContract } from 'wagmi';
import { createPublicClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { beijingLabel, display, executorAbi, minimumOutput, policyMessage, serviceLabels, shortAddress, STATUS_ZH, stringify, tokenAbi,
  type AppConfig, type PlanInput, type TaskView, type WalletSnapshot } from '@nbdao/shared';
import { bindPlanStart, buildPlan, buildPolicy, initialForm, type FormValues } from '@/lib/plan';
import { localChain } from './providers';
import WalletPanel from './wallet-panel';
import MarketReference from './market-reference';
import SellTax from './sell-tax';
import { LatestRead, OperationGate, WalletSession } from '@/lib/wallet-session';
import { walletError as walletConnectionError } from '@/lib/wallet-errors';

type Prepared = { plan: PlanInput; key: string };
type Created = { id: Hex; plan: PlanInput };
type PendingWalletTx = { hash: Hex; kind: 'approve' | 'create' | 'cancel'; owner: Address; chainId: number; seller: Address; plan?: PlanInput; amount?: string };
const active = (t: TaskView) => t.status === 1 || t.status === 2;
function errorText(error: unknown) {
  const e = error as { shortMessage?: string; message?: string };
  const text = e?.shortMessage || e?.message || '操作失败，请重试';
  if (/rejected|denied|cancelled|canceled/i.test(text)) return '已取消钱包请求，资金操作未继续。';
  return text.length > 420 ? `${text.slice(0, 420)}…` : text;
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : stringify(body), cache: 'no-store', signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `服务请求失败（${response.status}）`);
  return result as T;
}
function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{help && <small>{help}</small>}</label>;
}
function Metric({ label, value, unit, subtle }: { label: string; value: ReactNode; unit?: string; subtle?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}<small>{unit}</small></strong>{subtle && <p>{subtle}</p>}</div>;
}
function Arrow() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

export default function Home() {
  const connection = useConnection();
  const { address, chainId, isConnected } = connection;
  const switchChain = useSwitchChain();
  const writeContract = useWriteContract();
  const signMessage = useSignMessage();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [walletError, setWalletError] = useState('');
  const [walletFresh, setWalletFresh] = useState(false);
  const [tasksFresh, setTasksFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [form, setForm] = useState<FormValues>(() => initialForm());
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hash, setHash] = useState<Hex | null>(null);
  const [showWallets, setShowWallets] = useState(false);
  const [pendingTx, setPendingTx] = useState<PendingWalletTx | null>(null);
  const session = `${address?.toLowerCase() || ''}:${chainId || ''}:${connection.connector?.uid || ''}:${connection.status}`;
  const sessionRef = useRef(new WalletSession());
  const generation = sessionRef.current.update(session);
  const operationGate = useRef(new OperationGate());
  const latestRead = useRef(new LatestRead());
  const recoveryStarted = useRef('');
  const pendingMemory = useRef(new Map<string, PendingWalletTx>());
  const pendingContext = useRef<{ key: string | null; generation: number }>({ key: null, generation });
  pendingContext.current = { generation, key: address && config?.sellerAddress && chainId === config.chainId ? `nbdao-pending:${config.chainId}:${config.sellerAddress.toLowerCase()}:${address.toLowerCase()}` : null };
  const sameChain = !!config && chainId === config.chainId;
  const visibleWallet = wallet?.owner.toLowerCase() === address?.toLowerCase() && sameChain ? wallet : null;
  const canManage = connection.status === 'connected' && !!config?.sellerAddress && sameChain && [56, 31337].includes(config.chainId);
  const ready = canManage && !configError && !!config?.ready && !!config.executor && config.mode !== 'read-only' && !!visibleWallet && walletFresh && tasksFresh && !pendingTx;
  const visibleTasks = tasks.filter((task) => task.owner.toLowerCase() === address?.toLowerCase());
  const taskExpired = (task: TaskView) => task.windowExpired === true || !!visibleWallet && Number(task.expiresAt) <= Number(visibleWallet.timestamp);
  const currentTask = visibleTasks.find((task) => active(task) && !taskExpired(task)) || visibleTasks[0];
  const hasActive = !!currentTask && active(currentTask) && !taskExpired(currentTask);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      try {
        const next = await api<AppConfig>('config', undefined, controller.signal);
        if (!controller.signal.aborted) { setConfig((old) => stringify(old) === stringify(next) ? old : next); setConfigError(''); }
      } catch (e) { if (!controller.signal.aborted) setConfigError(errorText(e)); }
      finally { inFlight = false; }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 10000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);
  useEffect(() => {
    setWallet(null); setTasks([]); setPrepared(null); setCreated(null); setError(''); setNotice(''); setHash(null); setWalletError('');
    setWalletFresh(false); setTasksFresh(false); setRefreshing(false); setPendingTx(null); recoveryStarted.current = '';
    if (operationGate.current.busy) setBusy('上一钱包操作尚未结束，请等待回执');
  }, [generation]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!address || !config || chainId !== config.chainId || connection.status !== 'connected' || !sessionRef.current.isCurrent(generation)) return;
    const owner = address;
    const sequence = latestRead.current.start();
    setRefreshing(true);
    const results = await Promise.allSettled([api<WalletSnapshot>(`wallet/${owner}`, undefined, signal), api<{ tasks: TaskView[] }>(`tasks/${owner}`, undefined, signal)]);
    if (!sessionRef.current.isCurrent(generation) || !latestRead.current.isCurrent(sequence) || signal?.aborted) return;
    setRefreshing(false);
    if (results[0].status === 'fulfilled' && results[0].value.owner.toLowerCase() === owner.toLowerCase()) { setWallet(results[0].value); setWalletFresh(true); setWalletError(''); }
    else { setWalletFresh(false); setWalletError(results[0].status === 'rejected' ? errorText(results[0].reason) : '余额返回的钱包不匹配，请重新刷新'); }
    if (results[1].status === 'fulfilled') { setTasks(results[1].value.tasks.filter((task) => task.owner.toLowerCase() === owner.toLowerCase())); setTasksFresh(true); }
    else { setTasksFresh(false); setWalletError(errorText(results[1].reason)); }
  }, [address, chainId, config, connection.status, generation]);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const interval = setInterval(() => { void reload(controller.signal); }, 8000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [reload]);
  useEffect(() => {
    if (!address || !config?.sellerAddress || !sameChain || connection.status !== 'connected') return;
    const key = `nbdao-created:${config.chainId}:${config.sellerAddress.toLowerCase()}:${address.toLowerCase()}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const data = JSON.parse(saved) as Created;
        if (/^0x[0-9a-fA-F]{64}$/.test(data.id) && data.plan.owner.toLowerCase() === address.toLowerCase()) setCreated(data);
      }
      const pending = localStorage.getItem(`nbdao-pending:${config.chainId}:${config.sellerAddress.toLowerCase()}:${address.toLowerCase()}`);
      if (pending) {
        const data = JSON.parse(pending) as PendingWalletTx;
        if (/^0x[0-9a-fA-F]{64}$/.test(data.hash) && data.owner.toLowerCase() === address.toLowerCase() && data.chainId === config.chainId && data.seller.toLowerCase() === config.sellerAddress.toLowerCase()) setPendingTx(data);
      }
    } catch { /* Wallet can still recover its on-chain task through the task list. */ }
  }, [address, config, sameChain, connection.status, generation]);

  const planResult = useMemo(() => {
    try { return { plan: wallet && config && wallet.owner.toLowerCase() === address?.toLowerCase() ? buildPlan(form, wallet, config) : null, error: '' }; }
    catch (e) { return { plan: null, error: errorText(e) }; }
  }, [form, wallet, config, address]);
  const formKey = stringify(form);
  const preparedMatches = !!prepared && prepared.key === formKey && prepared.plan.owner.toLowerCase() === address?.toLowerCase()
    && prepared.plan.policy.maxSellFeePercent === undefined;
  // Freeze the amount and floor when requesting approval; balance refreshes must not change that plan.
  const createdPlan = created && created.plan.owner.toLowerCase() === address?.toLowerCase() ? created.plan : null;
  const reviewedPlan = createdPlan || (preparedMatches ? prepared!.plan : planResult.plan);
  const canPrepare = ready && !busy && !hasActive && !created && !planResult.error && !!reviewedPlan;
  const canCreate = canPrepare && BigInt(wallet?.allowance || '0') >= BigInt(reviewedPlan!.maxTotalInput);
  const createdView = visibleTasks.find((task) => task.taskId === created?.id);
  const createdWindowExpired = !!created && (createdView?.windowExpired === true || !!visibleWallet && created.plan.expiresAt <= Number(visibleWallet.timestamp));
  const needsRegistration = created && !createdWindowExpired && !createdView?.policy && (!createdView || active(createdView));
  useEffect(() => {
    if (!created || !address || !config?.sellerAddress || !(createdWindowExpired || createdView && (createdView.policy || !active(createdView)))) return;
    try { localStorage.removeItem(`nbdao-created:${config.chainId}:${config.sellerAddress.toLowerCase()}:${address.toLowerCase()}`); } catch { /* Chain discovery remains authoritative. */ }
    setCreated(null);
  }, [created, createdView, createdWindowExpired, address, config]);

  function change(key: keyof FormValues, value: string) { setForm((old) => ({ ...old, [key]: value })); setPrepared(null); setError(''); setNotice(''); }
  function storageKey() { return `nbdao-created:${config!.chainId}:${config!.sellerAddress!.toLowerCase()}:${address!.toLowerCase()}`; }
  function client() {
    if (!config || ![56, 31337].includes(config.chainId)) throw new Error('仅支持 BSC 或明确配置的本地测试链');
    return createPublicClient({ chain: config.chainId === 56 ? bsc : localChain, transport: http(config.walletRpcUrl) });
  }
  function readCurrentPending() {
    const context = pendingContext.current;
    if (!context.key) return null;
    const memory = pendingMemory.current.get(context.key);
    if (memory) return memory;
    try {
      const value = localStorage.getItem(context.key);
      if (!value) return null;
      const data = JSON.parse(value) as PendingWalletTx;
      return /^0x[0-9a-fA-F]{64}$/.test(data.hash) && ['create', 'approve', 'cancel'].includes(data.kind) && pendingKey(data) === context.key ? data : null;
    } catch { return undefined; }
  }
  async function action(label: string, callback: (identity: number) => Promise<void>, allowPending = false) {
    const identity = generation;
    if (!sessionRef.current.isCurrent(identity)) return;
    const storedPending = readCurrentPending();
    if (storedPending && !allowPending) { setPendingTx(storedPending); setError('已有交易已提交，请先核查回执，避免重复提交。'); return; }
    const token = operationGate.current.acquire();
    if (!token) { setError('已有钱包操作尚未结束，请等待回执后再操作。'); return; }
    setBusy(label); setError(''); setNotice('');
    try { await callback(identity); }
    catch (e) { if (sessionRef.current.isCurrent(identity)) setError(errorText(e)); }
    finally { try { if (sessionRef.current.isCurrent(identity)) await reload(); }
      finally { operationGate.current.release(token); const restored = readCurrentPending(); if (restored !== undefined) setPendingTx(restored); setBusy(''); }
    }
  }
  function assertSession(identity: number) { if (!sessionRef.current.isCurrent(identity)) throw new Error('钱包或网络已切换，请重新操作'); }
  function pendingKey(transaction: PendingWalletTx) { return `nbdao-pending:${transaction.chainId}:${transaction.seller.toLowerCase()}:${transaction.owner.toLowerCase()}`; }
  function rememberPending(transaction: PendingWalletTx, identity: number) {
    pendingMemory.current.set(pendingKey(transaction), transaction);
    try { localStorage.setItem(pendingKey(transaction), stringify(transaction)); } catch { /* Current operation still remains locked until receipt. */ }
    if (sessionRef.current.isCurrent(identity)) { setPendingTx(transaction); setHash(transaction.hash); setBusy('交易已提交，等待链上回执'); }
  }
  async function finishPending(transaction: PendingWalletTx, identity: number) {
    // After a wallet broadcasts, always reconcile that receipt even if the user switches accounts.
    // Reconnection only restores this read; it never resubmits the transaction.
    const receipt = await client().waitForTransactionReceipt({ hash: transaction.hash, timeout: 120000 });
    pendingMemory.current.delete(pendingKey(transaction));
    try { localStorage.removeItem(pendingKey(transaction)); } catch { /* Safe to read the confirmed receipt again on reconnect. */ }
    if (sessionRef.current.isCurrent(identity)) setPendingTx(null);
    if (receipt.status !== 'success') throw new Error('交易执行失败，已保留链上回执，请刷新余额与任务核查。');
    if (transaction.kind === 'create' && transaction.plan) {
      let id: Hex | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== transaction.seller.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: executorAbi, eventName: 'TaskCreated', topics: log.topics, data: log.data });
          if (event.args.owner.toLowerCase() === transaction.owner.toLowerCase()) id = event.args.taskId;
        } catch { /* Ignore unrelated events, including replacement transactions. */ }
      }
      if (!id) throw new Error('交易已确认，但未找到本钱包的任务创建事件，请刷新任务核查。');
      const saved = { id, plan: transaction.plan };
      try { localStorage.setItem(`nbdao-created:${transaction.chainId}:${transaction.seller.toLowerCase()}:${transaction.owner.toLowerCase()}`, stringify(saved)); } catch { /* On-chain task discovery still permits service recovery. */ }
      if (sessionRef.current.isCurrent(identity)) { setCreated(saved); setNotice('任务已在链上创建，监控窗口已开始计时。请继续签署条件，让服务接管任务。'); }
    } else if (sessionRef.current.isCurrent(identity)) {
      if (receipt.transactionHash !== transaction.hash) setNotice('钱包交易已被替换，请根据刷新后的余额与任务状态核查。');
      else setNotice(transaction.kind === 'approve' ? transaction.amount === '0' ? '授权已撤销。已有任务如需结束，请同时取消任务。' : '有限授权已确认，可以创建清仓任务。' : '任务取消交易已确认。可继续撤销剩余授权。');
      if (transaction.kind === 'cancel' && receipt.transactionHash === transaction.hash) { try { localStorage.removeItem(storageKey()); } catch {} setCreated(null); }
    }
  }
  async function recoverPending(transaction: PendingWalletTx) {
    if (!canManage || operationGate.current.busy) return;
    await action('正在核查已提交交易，请勿重复提交', (identity) => finishPending(transaction, identity), true);
  }
  useEffect(() => {
    if (!pendingTx || !canManage || operationGate.current.busy) return;
    const key = `${generation}:${pendingTx.hash}`;
    if (recoveryStarted.current === key) return;
    recoveryStarted.current = key;
    void recoverPending(pendingTx);
  }, [pendingTx, canManage, generation, busy]);
  async function approve(revoke = false) {
    if (!(revoke ? canManage : canPrepare) || !address || !config?.sellerAddress || (!revoke && !reviewedPlan)) return;
    const plan = reviewedPlan;
    const amount = revoke ? 0n : BigInt(plan!.maxTotalInput);
    await action(revoke ? '正在撤销授权' : '请确认有限授权', async (identity) => {
      assertSession(identity);
      if (!revoke && plan) setPrepared({ plan, key: formKey });
      const tx = await writeContract.mutateAsync({ address: config.addresses.token, abi: tokenAbi, functionName: 'approve', args: [config.sellerAddress!, amount], account: address, chainId: config.chainId });
      const transaction: PendingWalletTx = { hash: tx, kind: 'approve', owner: address, chainId: config.chainId, seller: config.sellerAddress!, amount: amount.toString() };
      rememberPending(transaction, identity); await finishPending(transaction, identity);
    });
  }
  async function createTask() {
    if (!canCreate || !reviewedPlan || !config?.sellerAddress || !address) return;
    const approvedPlan = reviewedPlan;
    await action('请确认创建任务', async (identity) => {
      assertSession(identity);
      const readClient = client();
      if (await readClient.getChainId() !== config.chainId) throw new Error('当前 RPC 网络不匹配，任务未提交。');
      const block = await readClient.getBlock();
      assertSession(identity);
      const plan = bindPlanStart(approvedPlan, block.timestamp);
      setPrepared({ plan, key: formKey });
      const tx = await writeContract.mutateAsync({ address: config.sellerAddress!, abi: executorAbi, functionName: 'createTask', account: address, chainId: config.chainId,
        args: [{ executor: plan.executor, notBefore: BigInt(plan.notBefore), expiresAt: BigInt(plan.expiresAt), maxChunks: plan.maxChunks,
          maxTotalInput: BigInt(plan.maxTotalInput), minUSDTPerToken: BigInt(plan.minUSDTPerToken), maxDustTokens: BigInt(plan.maxDustTokens), maxGasPrice: BigInt(plan.maxGasPrice) }] });
      const transaction: PendingWalletTx = { hash: tx, kind: 'create', owner: address, chainId: config.chainId, seller: config.sellerAddress!, plan };
      rememberPending(transaction, identity); await finishPending(transaction, identity);
    });
  }
  async function register(createdTask = created) {
    if (!createdTask || !ready || !config?.sellerAddress || !address || createdTask.plan.expiresAt <= Number(visibleWallet?.timestamp || 0)) return;
    const message = policyMessage(config.chainId, config.sellerAddress, createdTask.id, createdTask.plan.policy);
    await action('请签署监控条件', async (identity) => {
      const signature = await signMessage.mutateAsync({ message, account: address });
      assertSession(identity);
      await api('tasks/register', { taskId: createdTask.id, policy: createdTask.plan.policy, message, signature });
      assertSession(identity); setNotice('执行服务已接管任务，会在剩余监控窗口内逐笔检查实际到账和已签执行条件，满足条件才执行。');
      localStorage.removeItem(storageKey());
      setCreated(null);
    });
  }
  async function recoverRegistration() {
    if (!currentTask || !active(currentTask) || taskExpired(currentTask)) return;
    let policy;
    try { policy = buildPolicy(form); } catch (e) { setError(errorText(e)); return; }
    const recover: Created = { id: currentTask.taskId, plan: { owner: currentTask.owner, executor: currentTask.executor, policy,
      notBefore: Number(currentTask.notBefore), expiresAt: Number(currentTask.expiresAt), maxChunks: currentTask.maxChunks,
      maxTotalInput: currentTask.maxTotalInput, minUSDTPerToken: currentTask.minUSDTPerToken, maxDustTokens: currentTask.maxDustTokens, maxGasPrice: currentTask.maxGasPrice } };
    setCreated(recover);
    await register(recover);
  }
  async function cancelTask() {
    if (!canManage || !currentTask || !active(currentTask) || taskExpired(currentTask) || !config?.sellerAddress || !address) return;
    await action('请确认取消任务', async (identity) => {
      assertSession(identity);
      const tx = await writeContract.mutateAsync({ address: config.sellerAddress!, abi: executorAbi, functionName: 'cancelTask', args: [currentTask.taskId], account: address, chainId: config.chainId });
      const transaction: PendingWalletTx = { hash: tx, kind: 'cancel', owner: address, chainId: config.chainId, seller: config.sellerAddress! };
      rememberPending(transaction, identity); await finishPending(transaction, identity);
    });
  }

  const inputProps = { disabled: !!busy || !!created };
  const confirmedPlan = createdPlan || (hasActive ? currentTask : null);
  const confirmationPlan = confirmedPlan || reviewedPlan;
  const monitoringMinutes = reviewedPlan ? (reviewedPlan.expiresAt - reviewedPlan.notBefore) / 60 : form.windowMinutes;
  const remainingMinutes = currentTask && visibleWallet ? Math.max(0, Math.ceil((Number(currentTask.expiresAt) - Number(visibleWallet.timestamp)) / 60)) : null;
  const legacyTaxCeiling = confirmedPlan?.policy?.maxSellFeePercent;
  const connectionButton = <button className="button primary" onClick={() => setShowWallets(true)}>连接钱包 <Arrow /></button>;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="NBDAO 自动清仓首页"><span className="brand-icon">N</span><span>NBDAO<span className="brand-sub">EXIT</span></span></a>
      <div className="top-actions"><span className={`network-badge ${config?.chainId === 31337 ? 'test' : ''}`}><i />{config?.chainId === 31337 ? '本地测试 · 31337' : 'BNB Smart Chain'}</span>
        <WalletPanel config={config} wallet={visibleWallet} fresh={walletFresh} refreshing={refreshing} busy={!!busy || !!pendingTx} refresh={reload} open={showWallets} setOpen={setShowWallets} /></div>
    </header>
    <main>
      <div className="intro"><div><div className="eyebrow">限时监控 · 自动分批 · USDT 直达钱包</div><h1>让清仓，<br className="mobile-break" />按你的条件执行。</h1><p>创建后开始监控，扣费后实际到账达到你设置的底线才执行。</p></div><div className="intro-note"><span className="small-dot" />原钱包持币<br /><strong>资金不转入执行合约</strong></div></div>
      <p className="snapshot-caption" style={{ margin: '0 0 20px' }}><a href="/opening" data-testid="opening-link">08:00 指定日期卖出 →</a> · 设置一次性日期任务、BNB 总费用上限和最低 USDT 到账</p>
      {(configError || config && !config.ready) && <div className="banner neutral"><strong>自动执行尚未就绪 · 新任务已停用</strong><p>{configError || config?.missing.join('；') || '等待执行合约部署和服务配置'}</p></div>}
      {config?.monitor && <div className="banner neutral" data-testid="server-monitor"><strong>{config.monitor.location === 'cloud' ? '云端' : '本机'}后台监控 · {config.monitor.enabled && config.monitor.healthy && !configError ? '运行中' : '暂未就绪'}</strong><p>{config.monitor.location === 'cloud' ? '任务创建并签署服务条件后，关闭浏览器或电脑仍会在窗口内监控、达标后卖出。' : '本机执行需要电脑和 Keeper 保持运行。'}{config.monitor.lastBlockNumber && ` 最近检查区块 #${config.monitor.lastBlockNumber}。`}</p></div>}
      {config?.mode === 'read-only' && <div className="banner neutral"><strong>当前仅观察税率，自动卖出尚未开启</strong><p>当前可查看余额与已有任务，并由钱包取消有效任务或撤销授权。新授权、任务创建与服务启用已停用。</p></div>}
      {config?.chainId === 31337 && <div className="banner testing"><strong>本地测试环境</strong><p>使用测试资产与本地链，交易不影响 BSC 主网。</p></div>}
      {connection.status === 'connected' && config && !sameChain && <div className="banner warning"><strong>当前钱包网络不匹配</strong><p>切换到 {config.chainName}（Chain ID {config.chainId}）后才能查询和操作。</p><button className="button compact" data-testid="wallet-network-banner-switch" disabled={!!busy || !!pendingTx} onClick={() => { void action('请在钱包确认切换网络', async () => { try { await switchChain.mutateAsync({ chainId: config.chainId, addEthereumChainParameter: { chainName: config.chainName, rpcUrls: [config.walletRpcUrl], nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}) } }); } catch (e) { throw new Error(walletConnectionError(e, '网络切换失败，请在钱包中选择目标网络后重试。')); } }); }}>切换网络</button></div>}
      {connection.status === 'reconnecting' && <div className="banner neutral" role="status">正在恢复钱包连接，完成前暂停资产操作。</div>}
      <div className="workspace">
        <div className="main-column">
          <section className="panel balance-panel"><div className="panel-heading"><div className="eyebrow">01 / 钱包资产</div><span className="token-badge">NBDAO <span>→</span> USDT</span></div>
            <div className="balance-label">本次计划卖出全部余额</div><div className="hero-balance">{visibleWallet ? display(visibleWallet.tokenBalance, 6) : '—'}<span>NBDAO</span></div>
            <MarketReference config={config} wallet={visibleWallet} walletFresh={walletFresh} status={connection.status} chainMatched={sameChain} />
            <SellTax chainId={config?.chainId} readOnly={!config?.ready || config.mode === 'read-only'} rpcUrl={config?.walletRpcUrl} blockPollMs={config?.blockPollMs} />
            <div className="balance-bottom"><span>余额包含已累积奖励 <strong>{visibleWallet ? display(visibleWallet.pending, 6) : '—'} NBDAO</strong></span><span>钱包 USDT <strong>{visibleWallet ? display(visibleWallet.usdtBalance, 4) : '—'}</strong></span><span>钱包 BNB <strong>{visibleWallet ? display(visibleWallet.bnbBalance, 6) : '—'}</strong></span>{connection.status === 'connected' && sameChain && <button className="balance-refresh-button" data-testid="balance-refresh" disabled={refreshing} onClick={() => { void reload(); }}>{refreshing ? '刷新中…' : '刷新余额 ↻'}</button>}</div>
            {visibleWallet && <p className="snapshot-caption">钱包快照 #{visibleWallet.blockNumber} · {beijingLabel(visibleWallet.timestamp)} · 同步前税率快照 {visibleWallet.sellFee}%（不含其他扣费）</p>}
            {visibleWallet && (!walletFresh || !tasksFresh) && <p className="stale-snapshot" data-testid="wallet-stale" role="status">当前显示上次快照，数据尚未核查，新的资金操作已暂停。请刷新后重试。</p>}
            {!isConnected && <div className="empty-inline"><p>连接持币钱包，读取真实余额与奖励。</p>{connectionButton}</div>}
            {walletError && <div className="inline-error" role="alert">{walletError}</div>}
          </section>
          <section className="panel plan-panel"><div className="panel-heading"><div><div className="eyebrow">02 / 成交条件</div><h2>给自动卖出划定边界</h2></div><span className="muted">创建后开始计时</span></div>
            <div className="form-grid"><Field label="监控时长" help="创建时读取最新链上时间；过期后停止，余币仍在原钱包。"><div className="input-unit"><input aria-label="监控时长分钟" type="number" min="1" max="1440" value={form.windowMinutes} onChange={(e) => change('windowMinutes', e.target.value)} {...inputProps} /><span>分钟</span></div></Field></div>
            <Field label="卖出后最低获得" help="按当前全部余额折算每枚到账底线，每批低于底线就回滚。全部卖完才能达到总金额目标，额外奖励按同一底线计算。"><div className="input-unit minimum-input"><input aria-label="卖出后最低获得 USDT" inputMode="decimal" placeholder="输入你愿意接受的最低到账金额" value={form.minimumUSDT} onChange={(e) => change('minimumUSDT', e.target.value)} {...inputProps} /><span>USDT</span></div></Field>
            <details className="advanced"><summary>执行预算与奖励余量 <span>可调整</span></summary><div className="advanced-grid">
              <Field label="额外奖励额度 · NBDAO" help="默认 0。执行期间新增奖励超出额度时，会停止并显示余币。"><input aria-label="额外奖励额度" inputMode="decimal" value={form.extraTokens} onChange={(e) => change('extraTokens', e.target.value)} {...inputProps} /></Field>
              <Field label="余币阈值 · NBDAO" help="小于该值允许结束，并明确显示余币。"><input aria-label="余币阈值" inputMode="decimal" value={form.dustTokens} onChange={(e) => change('dustTokens', e.target.value)} {...inputProps} /></Field>
              <Field label="Gas 总预算 · BNB"><input aria-label="Gas 总预算" inputMode="decimal" value={form.gasBudgetBNB} onChange={(e) => change('gasBudgetBNB', e.target.value)} {...inputProps} /></Field>
              <Field label="单笔 Gas 上限 · BNB"><input aria-label="单笔 Gas 上限" inputMode="decimal" value={form.maxTxGasBNB} onChange={(e) => change('maxTxGasBNB', e.target.value)} {...inputProps} /></Field>
              <Field label="Gas 单价上限 · Gwei"><input aria-label="Gas 单价上限" inputMode="decimal" value={form.maxGasGwei} onChange={(e) => change('maxGasGwei', e.target.value)} {...inputProps} /></Field>
              <Field label="报价滑点 · %"><input aria-label="报价滑点" inputMode="decimal" value={form.slippagePercent} onChange={(e) => change('slippagePercent', e.target.value)} {...inputProps} /></Field>
              <Field label="最多卖出批数"><input aria-label="最多卖出批数" type="number" min="1" max="256" value={form.maxChunks} onChange={(e) => change('maxChunks', e.target.value)} {...inputProps} /></Field>
              <Field label="单笔经济阈值 · USDT" help="预估收益不足以覆盖 Gas 和该阈值时停止。"><input aria-label="单笔经济阈值" inputMode="decimal" value={form.minEconomicUSDT} onChange={(e) => change('minEconomicUSDT', e.target.value)} {...inputProps} /></Field>
            </div></details>
            {planResult.error && wallet && !hasActive && <p className="validation-message">{planResult.error}</p>}
          </section>
        </div>
        <aside className="side-column">
          <section className="panel confirm-panel"><div className="eyebrow">执行确认</div><h2>一次设置，<br />按条件执行卖出。</h2><p className="muted">每笔检查扣费后实际到账，达到底线才卖出。USDT 直接进入当前持币钱包。</p>
            <dl className="confirm-list">
              {confirmedPlan ? <><div><dt>开始 · 北京时间</dt><dd>{beijingLabel(confirmedPlan.notBefore)}</dd></div><div><dt>截止 · 北京时间</dt><dd>{beijingLabel(confirmedPlan.expiresAt)}</dd></div></> : <div><dt>监控窗口</dt><dd>创建后持续监控 {monitoringMinutes} 分钟</dd></div>}
              <div><dt>授权与卖出总上限</dt><dd>{confirmationPlan ? display(confirmationPlan.maxTotalInput, 6) : '—'} NBDAO</dd></div><div><dt>卖出后最低获得 · 按总额度</dt><dd>{confirmationPlan ? display(minimumOutput(BigInt(confirmationPlan.maxTotalInput), BigInt(confirmationPlan.minUSDTPerToken)), 4) : '—'} USDT</dd></div>
              <div><dt>Gas 总预算 / 单笔</dt><dd>{confirmationPlan?.policy ? `${display(confirmationPlan.policy.gasBudgetWei, 6)} / ${display(confirmationPlan.policy.maxTxGasWei, 6)}` : `${form.gasBudgetBNB} / ${form.maxTxGasBNB}`} BNB</dd></div>
              <div><dt>尝试 / 最多批数</dt><dd>{confirmationPlan?.policy?.maxAttempts ?? 20} 次 / {confirmationPlan?.maxChunks ?? form.maxChunks} 批</dd></div><div><dt>收款钱包</dt><dd>{address ? shortAddress(address) : '连接后显示'}</dd></div>
            </dl>
            <div className="steps"><span className={reviewedPlan ? 'done' : ''}>1 条件</span><i /><span className={wallet && reviewedPlan && BigInt(wallet.allowance) >= BigInt(reviewedPlan.maxTotalInput) ? 'done' : ''}>2 授权</span><i /><span className={created || hasActive ? 'done' : ''}>3 创建并签名</span></div>
            {!isConnected ? connectionButton : needsRegistration ? <button className="button primary full" disabled={!ready || !!busy} onClick={() => { void register(); }}>签署条件并启用服务 <Arrow /></button> : hasActive ? <div className="active-notice">当前钱包已有监控任务，请在下方查看进度。</div> : wallet && reviewedPlan && BigInt(wallet.allowance) < BigInt(reviewedPlan.maxTotalInput) ? <button className="button primary full" disabled={!canPrepare} onClick={() => { void approve(); }}>授权 {display(reviewedPlan.maxTotalInput, 3)} NBDAO <Arrow /></button> : <button className="button primary full" disabled={!canCreate} onClick={() => { void createTask(); }}>创建并开始监控 <Arrow /></button>}
            {legacyTaxCeiling !== undefined && <p className="stale-snapshot" data-testid="legacy-tax-notice">当前任务保留原已签条件：基础税不高于 {legacyTaxCeiling}% 且实际到账达标。若要只按最低到账执行，请取消后重新创建。</p>}
            <p className="action-caption">先完成有限授权，再创建链上任务并签署服务条件。<br />窗口从创建请求时的最新链上时间计时，创建后的等待不延长截止时间。</p>
            {busy && <div className="operation-state" role="status"><span className="spinner" />{busy}</div>}
            {pendingTx && !busy && <div className="inline-notice" role="status">已有交易待确认，暂不提交新交易。<button className="wallet-retry" data-testid="wallet-recover-transaction" onClick={() => { void recoverPending(pendingTx); }}>核查交易回执</button></div>}
            {error && <div className="inline-error" role="alert">{error}</div>}{notice && <div className="inline-notice" role="status">{notice}</div>}
            {hash && <a className="transaction-link" target="_blank" rel="noreferrer" href={config?.explorerUrl ? `${config.explorerUrl.replace(/\/$/, '')}/tx/${hash}` : undefined}>最近交易 {shortAddress(hash)} {config?.explorerUrl ? '↗' : '· 本地回执'}</a>}
          </section>
          <section className="protection-note"><span className="protection-icon">✓</span><div><strong>到账底线写入合约</strong><p>低于底线整笔回滚；窗口到期、预算不足或依赖发生变化时停止。已卖出部分不会因后续停止而撤回。</p></div></section>
        </aside>
      </div>
      {currentTask && <section className="panel task-panel"><div className="panel-heading"><div><div className="eyebrow">任务进度 · {shortAddress(currentTask.taskId)}</div><h2 data-testid="task-state-title">{taskExpired(currentTask) && active(currentTask) ? '监控窗口已结束' : active(currentTask) ? serviceLabels[currentTask.serviceStatus] || '任务已就绪' : STATUS_ZH[currentTask.status] || '状态待核查'}</h2></div><span className={`status-pill ${active(currentTask) && !taskExpired(currentTask) ? 'running' : ''}`}>{serviceLabels[currentTask.serviceStatus] || currentTask.serviceStatus}</span></div>
        <div className="task-metrics"><Metric label="已卖出" value={display(currentTask.soldInput, 6)} unit="NBDAO" /><Metric label="实际到账" value={display(currentTask.receivedUSDT, 4)} unit="USDT" /><Metric label="当前剩余" value={display(currentTask.residual, 6)} unit="NBDAO" /><Metric label="已花费 Gas" value={display(currentTask.gasSpentWei, 6)} unit="BNB" /></div>
        <div className="progress-track"><div style={{ width: `${Math.min(100, Number(BigInt(currentTask.soldInput) * 10000n / (BigInt(currentTask.maxTotalInput) || 1n)) / 100)}%` }} /></div>
        <p className="task-reason">{currentTask.reason || `已完成 ${currentTask.nextChunkIndex} 批，已尝试 ${currentTask.attempts} 次。`}</p>
        <p className="snapshot-caption">{beijingLabel(currentTask.notBefore)} 至 {beijingLabel(currentTask.expiresAt)} · 每枚最低 {display(currentTask.minUSDTPerToken, 10)} USDT · 总卖出上限 {display(currentTask.maxTotalInput, 6)} NBDAO</p>
        <p className="snapshot-caption">链上快照剩余 {remainingMinutes === null ? '待核查' : `${remainingMinutes} 分钟`}；上方税率仅供参考，成交须满足最低到账和该任务已签执行条件。</p>
        {currentTask.fills.length > 0 && <div className="fill-table"><div className="fill-header"><span>批次 / 交易</span><span>卖出 NBDAO</span><span>到账 USDT</span><span>确认</span></div>{currentTask.fills.map((fill) => <div className="fill-row" key={fill.hash}><span>#{fill.index + 1} · {config?.explorerUrl ? <a href={`${config.explorerUrl.replace(/\/$/, '')}/tx/${fill.hash}`} target="_blank" rel="noreferrer">{shortAddress(fill.hash)} ↗</a> : shortAddress(fill.hash)}</span><span>{display(fill.input, 4)}</span><span>{display(fill.output, 4)}</span><span>{fill.confirmed ? '已对账' : '确认中'}</span></div>)}</div>}
        <div className="task-actions">{active(currentTask) && !currentTask.policy && <button className="button secondary compact" disabled={!ready || !!busy || taskExpired(currentTask)} onClick={() => { void recoverRegistration(); }}>恢复服务参数签名</button>}{active(currentTask) && !taskExpired(currentTask) && <button className="button danger compact" disabled={!canManage || !!busy || !!pendingTx} onClick={() => { void cancelTask(); }}>取消任务</button>}<button className="button compact" disabled={!canManage || !!busy || !!pendingTx || !visibleWallet || BigInt(visibleWallet.allowance) === 0n} onClick={() => { void approve(true); }}>撤销剩余授权</button><span className="muted">{taskExpired(currentTask) ? '已到期任务无需取消；撤销剩余授权需要钱包确认。' : '取消任务与撤销授权分别需要钱包确认。'}</span></div>
      </section>}
      <footer><span>NBDAO / USDT · 一次性清仓任务</span><span>成交条件随链上状态变化，不能保证最高收益或首个区块成交。</span></footer>
    </main>
  </div>;
}
