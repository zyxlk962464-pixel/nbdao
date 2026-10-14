'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useSignMessage, useWalletClient } from 'wagmi';
import { createPublicClient, encodeFunctionData, http, parseEventLogs, type Address, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { beijingLabel, display, openingExecutorAbi, openingPolicyMessage, serviceLabels, shortAddress, stringify, tokenAbi,
  type AppConfig, type OpeningTaskView, type WalletSnapshot } from '@nbdao/shared';
import WalletPanel from '../wallet-panel';
import LastSale from '../last-sale';
import { localChain } from '../providers';
import { LatestRead, OperationGate, WalletSession } from '@/lib/wallet-session';
import { walletError } from '@/lib/wallet-errors';
import { buildOpeningPlan, nextOpeningDate, openingAvailable, OPENING_CREATE_GAS, splitOpeningBudget, type OpeningForm, type OpeningPlan } from '@/lib/opening-plan';

type Draft = { owner: Address; chainId: number; seller: Address; form: OpeningForm; setupTxHashes: Hex[]; setupGasWei: string; plan?: OpeningPlan; taskId?: Hex; failed?: boolean };
type Pending = { owner: Address; chainId: number; seller: Address; kind: 'approve'|'create'|'cancel'; to: Address; data: Hex; nonce: number; hash?: Hex; plan?: OpeningPlan };
const taskLabels = ['无任务', '已就绪 · 等待 08:00', '卖出完成', '已取消', '已到期'];
const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const keyOf = (owner: Address, chainId: number, seller: Address) => `nbdao-opening:${chainId}:${seller.toLowerCase()}:${owner.toLowerCase()}`;
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `服务暂不可用（${response.status}）`);
  return result as T;
}
function isRejection(error: unknown) {
  let current = error as { code?: number; cause?: unknown } | undefined;
  for (let i = 0; current && i < 8; i++, current = current.cause as typeof current) if (current.code === 4001) return true;
  return false;
}

export default function OpeningPage() {
  const connection = useConnection(), { address, chainId } = connection;
  const walletClient = useWalletClient({ chainId });
  const signMessage = useSignMessage();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [tasks, setTasks] = useState<OpeningTaskView[]>([]);
  const [gasPrice, setGasPrice] = useState(0n);
  const [fresh, setFresh] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<OpeningForm>({ date: '', totalBNB: '', minimumUSDT: '' });
  const [draft, setDraft] = useState<Draft | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [openWallet, setOpenWallet] = useState(false), [hashInput, setHashInput] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const session = useRef(new WalletSession()), gate = useRef(new OperationGate()), reads = useRef(new LatestRead());
  const memory = useRef(new Map<string, { draft: Draft|null; pending: Pending|null }>());
  const generation = session.current.update(`${address?.toLowerCase() || ''}:${chainId || ''}:${connection.connector?.uid || ''}:${connection.status}:${config?.openingSellerAddress?.toLowerCase() || ''}`);
  const chainMatched = !!config && chainId === config.chainId;
  const connected = connection.status === 'connected' && !!address && chainMatched;
  const visibleWallet = connected && wallet?.owner.toLowerCase() === address?.toLowerCase() ? wallet : null;
  const storageKey = connected && config?.openingSellerAddress && address ? keyOf(address, config.chainId, config.openingSellerAddress) : null;
  const currentDraft = storageKey && draft && keyOf(draft.owner, draft.chainId, draft.seller) === storageKey ? draft : null;
  const currentTask = tasks.find((task) => task.status === 1 && Number(task.expiresAt) > Number(visibleWallet?.timestamp || 0)) || tasks[0];
  const armed = currentTask?.status === 1 && Number(currentTask.expiresAt) > Number(visibleWallet?.timestamp || 0);
  const configured = openingAvailable(config) && !configError;
  const canManage = connected && !!config?.openingSellerAddress && [56, 31337].includes(config.chainId);
  const canPrepare = configured && canManage && fresh && !!visibleWallet && !!walletClient.data && !busy && !pending && !armed && !currentDraft?.taskId && !currentDraft?.failed && !storageBlocked;
  const planResult = useMemo(() => {
    try { return { plan: visibleWallet && config ? buildOpeningPlan(form, visibleWallet, config, gasPrice, BigInt(currentDraft?.setupGasWei || '0'), currentDraft?.setupTxHashes || []) : null, error: '' }; }
    catch (e) { return { plan: null, error: (e as Error).message }; }
  }, [visibleWallet, config, form, gasPrice, currentDraft]);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void api<AppConfig>('config', undefined, controller.signal).then((next) => { if (!controller.signal.aborted) { setConfig((old) => stringify(old) === stringify(next) ? old : next); setConfigError(''); } }).catch((e) => { if (!controller.signal.aborted) setConfigError(walletError(e)); }); };
    load(); const timer = setInterval(load, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  function client() {
    if (!config || ![56, 31337].includes(config.chainId)) throw new Error('目标链未配置');
    return createPublicClient({ chain: config.chainId === 56 ? bsc : localChain, transport: http(config.walletRpcUrl) });
  }
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!connected || !address || !config) return;
    const identity = generation, sequence = reads.current.start(); setRefreshing(true);
    try {
      const readClient = createPublicClient({ chain: config.chainId === 56 ? bsc : localChain, transport: http(config.walletRpcUrl) });
      const [nextWallet, nextTasks, allowance, price] = await Promise.all([
        api<WalletSnapshot>(`wallet/${address}`, undefined, signal),
        config.openingSellerAddress ? api<{ tasks: OpeningTaskView[] }>(`opening/tasks/${address}`, undefined, signal) : Promise.resolve({ tasks: [] }),
        config.openingSellerAddress ? readClient.readContract({ address: config.addresses.token, abi: tokenAbi, functionName: 'allowance', args: [address, config.openingSellerAddress] }) : Promise.resolve(0n),
        readClient.getGasPrice(),
      ]);
      if (!session.current.isCurrent(identity) || !reads.current.isCurrent(sequence) || signal?.aborted) return;
      if (nextWallet.owner.toLowerCase() !== address.toLowerCase()) throw new Error('余额钱包不匹配');
      setWallet({ ...nextWallet, allowance: allowance.toString() }); setTasks(nextTasks.tasks.filter((task) => task.owner.toLowerCase() === address.toLowerCase())); setGasPrice(price); setFresh(true);
      setForm((old) => old.date ? old : { ...old, date: nextOpeningDate(Number(nextWallet.timestamp)) });
    } catch (e) { if (session.current.isCurrent(identity) && !signal?.aborted) { setFresh(false); setError(walletError(e)); } }
    finally { if (session.current.isCurrent(identity) && reads.current.isCurrent(sequence)) setRefreshing(false); }
  }, [connected, address, config, generation]);
  useEffect(() => {
    setWallet(null); setTasks([]); setFresh(false); setDraft(null); setPending(null); setError(''); setNotice(''); setStorageBlocked(false); setHashInput('');
    setForm({ date: '', totalBNB: '', minimumUSDT: '' });
    if (gate.current.busy) setBusy('上一钱包请求尚未结束，请等待');
    if (!storageKey) return;
    try {
      const saved = memory.current.get(storageKey) || JSON.parse(localStorage.getItem(storageKey) || '{"draft":null,"pending":null}') as { draft: Draft|null; pending: Pending|null };
      const matches = (value: {owner: Address; chainId: number; seller: Address}|null) => !value || keyOf(value.owner, value.chainId, value.seller) === storageKey;
      if (!matches(saved.draft) || !matches(saved.pending) || saved.pending?.hash && !validHash(saved.pending.hash)) throw new Error('恢复记录不匹配');
      if (saved.draft && (!/^\d+$/.test(saved.draft.setupGasWei) || !Array.isArray(saved.draft.setupTxHashes) || !saved.draft.setupTxHashes.every(validHash) || !saved.draft.form || saved.draft.taskId && !validHash(saved.draft.taskId))) throw new Error('任务恢复记录无效');
      if (saved.pending && (!['approve', 'create', 'cancel'].includes(saved.pending.kind) || !Number.isSafeInteger(saved.pending.nonce) || saved.pending.nonce < 0 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(saved.pending.data))) throw new Error('交易恢复记录无效');
      memory.current.set(storageKey, saved); setDraft(saved.draft); setPending(saved.pending);
      if (saved.draft) setForm(saved.draft.form);
    } catch { setStorageBlocked(true); setError('浏览器任务恢复记录不可用，请先核查钱包活动，暂不允许提交新交易'); }
  }, [generation, storageKey]);
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal); const timer = setInterval(() => { void reload(controller.signal); }, 5000); return () => { controller.abort(); clearInterval(timer); }; }, [reload]);

  function assertSession(identity: number) { if (!session.current.isCurrent(identity)) throw new Error('钱包或网络已变化，已停止后续签名'); }
  function save(nextDraft: Draft|null, nextPending: Pending|null, owner: Address, seller: Address, targetChain: number, identity: number) {
    const key = keyOf(owner, targetChain, seller), value = { draft: nextDraft, pending: nextPending }, serialized = stringify(value);
    // Retain a returned hash in memory even when the browser stops accepting writes.
    memory.current.set(key, value);
    if (session.current.isCurrent(identity)) { setDraft(nextDraft); setPending(nextPending); }
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error('无法持久保存恢复记录，未继续发送交易');
  }
  async function action(label: string, callback: (identity: number) => Promise<void>, allowPending = false) {
    const token = gate.current.acquire(); if (!token) return;
    const identity = generation; setBusy(label); setError(''); setNotice('');
    try {
      assertSession(identity);
      const stored = storageKey ? memory.current.get(storageKey) || JSON.parse(localStorage.getItem(storageKey) || '{}') as {pending?:Pending} : null;
      if (stored?.pending && !allowPending) throw new Error('已有钱包请求，请先核查回执，避免重复提交');
      await callback(identity);
    } catch (e) { if (session.current.isCurrent(identity)) setError(walletError(e)); }
    finally { gate.current.release(token); setBusy(''); if (session.current.isCurrent(identity)) await reload(); }
  }
  async function finish(transaction: Pending, identity: number) {
    if (!transaction.hash) throw new Error('钱包请求结果未知，请从钱包活动复制交易哈希核查');
    const readClient = client();
    const receipt = await readClient.waitForTransactionReceipt({ hash: transaction.hash, confirmations: 3, timeout: 120_000 });
    const onchain = await readClient.getTransaction({ hash: receipt.transactionHash });
    if (onchain.from.toLowerCase() !== transaction.owner.toLowerCase() || onchain.to?.toLowerCase() !== transaction.to.toLowerCase() || onchain.input !== transaction.data || onchain.nonce !== transaction.nonce) throw new Error('实际交易与保存请求不匹配，请在钱包核查，不会重复发送');
    const key = keyOf(transaction.owner, transaction.chainId, transaction.seller), saved = memory.current.get(key) || JSON.parse(localStorage.getItem(key) || '{}') as {draft?: Draft};
    let nextDraft = saved.draft || null;
    if (transaction.kind !== 'cancel' && nextDraft) {
      nextDraft = { ...nextDraft, setupTxHashes: [...new Set([...nextDraft.setupTxHashes, receipt.transactionHash])], setupGasWei: (BigInt(nextDraft.setupGasWei) + receipt.gasUsed * receipt.effectiveGasPrice).toString(), failed: receipt.status !== 'success' };
      if (transaction.kind === 'create' && receipt.status === 'success' && transaction.plan) {
        const events = parseEventLogs({ abi: openingExecutorAbi, eventName: 'TaskCreated', logs: receipt.logs }).filter((event) => event.address.toLowerCase() === transaction.seller.toLowerCase() && event.args.owner.toLowerCase() === transaction.owner.toLowerCase());
        const taskId = events.length === 1 ? events[0]?.args.taskId : undefined;
        if (!validHash(taskId) || /^0x0+$/.test(taskId)) throw new Error('创建交易已确认但未找到唯一任务事件，请核查链上记录');
        const reserve = OPENING_CREATE_GAS * BigInt(transaction.plan.maxGasPrice);
        if (receipt.gasUsed * receipt.effectiveGasPrice > reserve) nextDraft.failed = true;
        nextDraft = { ...nextDraft, taskId, plan: { ...transaction.plan, policy: { ...transaction.plan.policy, setupTxHashes: nextDraft.setupTxHashes } } };
      }
    }
    save(nextDraft, null, transaction.owner, transaction.seller, transaction.chainId, identity);
    if (receipt.status !== 'success') throw new Error('交易回滚，已花 Gas 已记录，本次准备停止；不会自动重发');
    if (nextDraft?.failed) throw new Error('钱包实际 Gas 超过创建预留，已停止服务登记，请核查钱包是否改高了费用');
    if (session.current.isCurrent(identity)) setNotice(transaction.kind === 'create' ? '链上任务已创建，请继续签署服务条件。' : transaction.kind === 'approve' ? '有限授权已确认，请继续创建任务。' : '链上任务已取消。');
  }
  async function send(kind: Pending['kind'], to: Address, data: Hex, gas: bigint, price: bigint, nextDraft: Draft|null, identity: number, plan?: OpeningPlan) {
    if (!address || !config?.openingSellerAddress || !walletClient.data) throw new Error('钱包尚未就绪');
    const readClient = client();
    const [network, latestNonce, pendingNonce] = await Promise.all([readClient.getChainId(), readClient.getTransactionCount({ address, blockTag: 'latest' }), readClient.getTransactionCount({ address, blockTag: 'pending' })]);
    assertSession(identity);
    if (network !== config.chainId || latestNonce !== pendingNonce) throw new Error('RPC 网络不匹配或钱包有待确认交易，请先处理钱包活动');
    const transaction: Pending = { owner: address, chainId: config.chainId, seller: config.openingSellerAddress, to, data, nonce: pendingNonce, kind, plan };
    save(nextDraft, transaction, address, config.openingSellerAddress, config.chainId, identity);
    let hash: Hex;
    try { hash = await walletClient.data.sendTransaction({ account: address, chain: config.chainId === 56 ? bsc : localChain, to, data, gas, gasPrice: price, nonce: pendingNonce }); }
    catch (e) { if (isRejection(e)) save(nextDraft, null, transaction.owner, transaction.seller, transaction.chainId, identity); throw e; }
    transaction.hash = hash;
    save(nextDraft, transaction, transaction.owner, transaction.seller, transaction.chainId, identity);
    await finish(transaction, identity);
  }
  async function approve() {
    if (!canPrepare || !planResult.plan || !address || !config?.openingSellerAddress || !visibleWallet) return;
    await action('请在钱包确认有限授权', async (identity) => {
      const plan = planResult.plan!, readClient = client();
      if ((currentDraft?.setupTxHashes.length || 0) >= 15) throw new Error('准备交易数量已达上限，已停止追加授权，请先核查钱包活动');
      const data = encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [config.openingSellerAddress!, BigInt(plan.maxTotalInput)] });
      const estimated = await readClient.estimateGas({ account: address, to: config.addresses.token, data });
      const gas = estimated * 120n / 100n;
      if (gas > 150_000n) throw new Error('授权 Gas 超出预留范围，未提交');
      splitOpeningBudget(BigInt(plan.policy.totalCostWei), BigInt(currentDraft?.setupGasWei || '0') + gas * BigInt(plan.maxGasPrice), BigInt(plan.maxGasPrice));
      assertSession(identity);
      const nextDraft = currentDraft || { owner: address, chainId: config.chainId, seller: config.openingSellerAddress!, form: { ...form }, setupTxHashes: [], setupGasWei: '0' };
      await send('approve', config.addresses.token, data, gas, BigInt(plan.maxGasPrice), nextDraft, identity);
    });
  }
  async function createTask() {
    if (!canPrepare || !planResult.plan || !address || !config?.openingSellerAddress || !visibleWallet) return;
    await action('核查预算后，请在钱包确认创建任务', async (identity) => {
      const readClient = client();
      const [chainWallet, allowance, latest] = await Promise.all([api<WalletSnapshot>(`wallet/${address}`), readClient.readContract({ address: config.addresses.token, abi: tokenAbi, functionName: 'allowance', args: [address, config.openingSellerAddress!] }), readClient.getBlock()]);
      assertSession(identity);
      if (chainWallet.owner.toLowerCase() !== address.toLowerCase() || chainWallet.tokenBalance !== visibleWallet.tokenBalance) throw new Error('钱包余额已变化，请刷新后重新核对卖出数量');
      const plan = buildOpeningPlan(form, { ...chainWallet, timestamp: latest.timestamp.toString() }, config, await readClient.getGasPrice(), BigInt(currentDraft?.setupGasWei || '0'), currentDraft?.setupTxHashes || []);
      if (allowance < BigInt(plan.maxTotalInput)) throw new Error('有限授权不足，请先授权');
      const data = encodeFunctionData({ abi: openingExecutorAbi, functionName: 'createTask', args: [{ executor: plan.executor, notBefore: BigInt(plan.notBefore), expiresAt: BigInt(plan.expiresAt), maxTotalInput: BigInt(plan.maxTotalInput), minTotalUSDT: BigInt(plan.minTotalUSDT), maxBuilderFeeWei: BigInt(plan.maxBuilderFeeWei), maxExecutionCostWei: BigInt(plan.maxExecutionCostWei), maxGasPrice: BigInt(plan.maxGasPrice) }] });
      assertSession(identity);
      const nextDraft: Draft = { owner: address, chainId: config.chainId, seller: config.openingSellerAddress!, form: { ...form }, setupTxHashes: currentDraft?.setupTxHashes || [], setupGasWei: currentDraft?.setupGasWei || '0', plan };
      await send('create', config.openingSellerAddress!, data, OPENING_CREATE_GAS, BigInt(plan.maxGasPrice), nextDraft, identity, plan);
    });
  }
  async function register() {
    if (!configured || !fresh || !currentDraft?.taskId || !currentDraft.plan || currentDraft.failed || !address || !config?.openingSellerAddress || currentTask && currentTask.taskId === currentDraft.taskId && currentTask.status !== 1 || Number(visibleWallet?.timestamp || 0) >= (currentDraft?.plan?.notBefore || 0)) return;
    await action('请签署本次费用预算与服务条件', async (identity) => {
      const latest = await client().getBlock();
      assertSession(identity);
      if (BigInt(currentDraft.plan!.notBefore) <= latest.timestamp + 30n) throw new Error('距离 08:00 不足 30 秒，已停止服务登记；请取消任务后选择下一次日期');
      const message = openingPolicyMessage(config.chainId, config.openingSellerAddress!, currentDraft.taskId!, currentDraft.plan!.policy);
      const signature = await signMessage.mutateAsync({ message, account: address });
      assertSession(identity);
      await api('opening/register', { taskId: currentDraft.taskId, policy: currentDraft.plan!.policy, message, signature });
      assertSession(identity); setNotice('云端服务已接管本次任务，关闭电脑也会在指定日期 08:00 附近尝试卖出。');
    });
  }
  async function cancelTask() {
    if (!canManage || !currentTask || !armed || !config?.openingSellerAddress) return;
    await action('请在钱包确认取消任务', async (identity) => {
      const data = encodeFunctionData({ abi: openingExecutorAbi, functionName: 'cancelTask', args: [currentTask.taskId] });
      const readClient = client(), price = await readClient.getGasPrice();
      if (price > 3_000_000_000n) throw new Error('当前 Gas 单价高于 3 Gwei，请稍后取消');
      const gas = await readClient.estimateGas({ account: address, to: config.openingSellerAddress!, data }); assertSession(identity);
      await send('cancel', config.openingSellerAddress!, data, gas * 120n / 100n, price, currentDraft, identity);
    });
  }
  function change(field: keyof OpeningForm, value: string) { if (busy || pending || currentDraft) return; setForm((old) => ({ ...old, [field]: value })); setError(''); setNotice(''); }
  const plan = currentDraft?.plan || planResult.plan;
  const locked = !!busy || !!pending || !!currentDraft;
  const registered = !!currentTask?.policy && currentTask.taskId === currentDraft?.taskId;
  const needsRegistration = !!currentDraft?.taskId && !registered && !currentDraft.failed && (!currentTask || currentTask.taskId !== currentDraft.taskId || currentTask.status === 1) && Number(visibleWallet?.timestamp || 0) < (currentDraft.plan?.notBefore || 0);
  const canResetDraft = fresh && !!currentDraft && !armed && !pending && !busy && (currentDraft.failed || !!currentDraft.taskId && (Number(currentDraft.plan?.expiresAt || 0) <= Number(visibleWallet?.timestamp || 0) || currentTask?.taskId === currentDraft.taskId && currentTask.status !== 1));
  const needsApproval = !!planResult.plan && BigInt(visibleWallet?.allowance || '0') < BigInt(planResult.plan.maxTotalInput);
  return <div className="app-shell"><header className="topbar"><a className="brand" href="/"><span className="brand-icon">N</span>NBDAO<span className="brand-sub">08:00 卖出</span></a><div className="top-actions"><span className="network-badge"><i />{config?.chainName || 'BNB Smart Chain'}</span><WalletPanel config={config} wallet={visibleWallet} fresh={fresh} refreshing={refreshing} busy={!!busy || !!pending} refresh={reload} open={openWallet} setOpen={setOpenWallet} /></div></header>
    <main><div className="intro"><div><div className="eyebrow">指定日期 · 一次性任务</div><h1>08:00 开盘卖出</h1><p>提前准备，争取北京时间 08:00 的首个区块；不保证首块或首笔成交。</p></div></div>
      {!configured && <div className="banner neutral" data-testid="opening-not-ready"><strong>新版卖出合约尚待部署 · 资产操作已停用</strong><p>{configError || config?.openingMissing?.join('；') || '完成新版合约部署和云端配置后，才能授权与创建 08:00 任务。'}</p><a href="/opening/deploy">部署新版执行合约 →</a></div>}
      {config?.openingMonitor && <div className="banner neutral"><strong>{config.openingMonitor.location==='cloud'?'云端':'本机'}日期执行服务 · {config.openingMonitor.enabled&&config.openingMonitor.healthy?'运行中':'尚未就绪'}</strong><p>{config.openingMonitor.error || '完成授权、创建和服务签名后，服务器会独立执行本次任务。'}</p></div>}
      <div className="workspace"><div className="main-column"><section className="panel balance-panel"><div className="eyebrow">当前持币钱包</div><div className="hero-balance">{fresh && visibleWallet ? display(visibleWallet.tokenBalance, 6) : '—'}<span>NBDAO</span></div><div className="balance-bottom"><span>BNB 余额 <strong>{fresh && visibleWallet ? display(visibleWallet.bnbBalance, 6) : '—'} BNB</strong></span><span>收款钱包 <strong>{address ? shortAddress(address) : '请连接钱包'}</strong></span></div><p className="snapshot-caption">按创建时确认的整仓数量尝试一次卖出，后续新增代币留在钱包。实际 USDT 直接到该钱包。</p></section>
        <section className="panel plan-panel"><div className="panel-heading"><h2>设置本次卖出</h2><span className="muted">北京时间 · 08:00</span></div><div className="form-grid">
          <label className="field"><span className="field-label">卖出日期</span><input aria-label="卖出日期" data-testid="opening-date" type="date" value={form.date} min={visibleWallet ? nextOpeningDate(Number(visibleWallet.timestamp)) : undefined} disabled={locked} onChange={(event) => change('date', event.target.value)} /><small>只执行所选日期的一次任务，08:00 起约 12 秒内争取成交，未成交则结束。请至少提前 1 分钟设置。</small></label>
          <label className="field"><span className="field-label">BNB 总费用上限</span><div className="input-unit"><input aria-label="BNB 总费用上限" data-testid="opening-total-bnb" inputMode="decimal" placeholder="你愿意支付的总费用" value={form.totalBNB} disabled={locked} onChange={(event) => change('totalBNB', event.target.value)} /><span>BNB</span></div><small>包含本次授权、创建任务、执行 Gas 和抢排序费。先预留 Gas，剩余部分作为抢排序费上限。</small></label>
          <label className="field"><span className="field-label">卖出后最低获得</span><div className="input-unit minimum-input"><input aria-label="卖出后最低获得 USDT" data-testid="opening-minimum-usdt" inputMode="decimal" placeholder="输入你愿意接受的最低到账" value={form.minimumUSDT} disabled={locked} onChange={(event) => change('minimumUSDT', event.target.value)} /><span>USDT</span></div><small>这是钱包实际到账底线。低于该金额整笔回滚；BNB 费用另计，失败交易仍可能花费 Gas。</small></label>
        </div>{connected && fresh && configured && planResult.error && !currentDraft?.taskId && <p className="validation-message" role="status">{planResult.error}</p>}</section>
      </div><aside className="side-column"><section className="panel confirm-panel"><div className="eyebrow">本次任务</div><h2>整仓一次卖出</h2><dl className="confirm-list"><div><dt>开始时间</dt><dd>{plan ? beijingLabel(plan.notBefore) : form.date ? `${form.date} 08:00:00` : '—'}</dd></div><div><dt>最低到账</dt><dd>{plan ? display(plan.minTotalUSDT, 6) : form.minimumUSDT || '—'} USDT</dd></div><div><dt>BNB 总费用上限</dt><dd>{form.totalBNB || '—'} BNB</dd></div><div><dt>已花准备 Gas</dt><dd>{display(currentDraft?.setupGasWei || '0', 10)} BNB</dd></div><div><dt>抢排序费上限</dt><dd>{plan ? display(plan.maxBuilderFeeWei, 10) : '—'} BNB</dd></div><div><dt>卖出与授权上限</dt><dd>{plan ? display(plan.maxTotalInput, 6) : '—'} NBDAO</dd></div></dl>
        {!connected ? <button className="button primary full" onClick={() => setOpenWallet(true)}>{connection.status === 'connected' ? '切换网络' : '连接钱包'}</button> : needsRegistration ? <button className="button primary full" data-testid="opening-register" disabled={!configured || !fresh || !!busy || !!pending} onClick={() => { void register(); }}>签署条件并启用云端服务</button> : armed ? <div className="active-notice">本钱包已有本次卖出任务，请查看下方进度。</div> : needsApproval ? <button className="button primary full" data-testid="opening-approve" disabled={!canPrepare || !planResult.plan} onClick={() => { void approve(); }}>有限授权 NBDAO</button> : <button className="button primary full" data-testid="opening-create" disabled={!canPrepare || !planResult.plan} onClick={() => { void createTask(); }}>创建 08:00 卖出任务</button>}
        <p className="action-caption">授权与创建需钱包确认，最后签署服务条件。关闭电脑后由云端执行；抢排序费用不能保证优先成交。</p>
        {canResetDraft && <button className="button compact full" onClick={() => { if (!address || !config?.openingSellerAddress) return; try { save(null, null, address, config.openingSellerAddress, config.chainId, generation); setForm({ date: nextOpeningDate(Number(visibleWallet?.timestamp)), totalBNB: '', minimumUSDT: '' }); setNotice('上次任务准备已结束，已花 Gas 不会退回。请为下一次任务重新设置预算。'); } catch (e) { setError(walletError(e)); } }}>设置下一次任务</button>}
        {busy && <div className="operation-state" role="status"><span className="spinner" />{busy}</div>}{error && <div className="inline-error" role="alert">{error}</div>}{notice && <div className="inline-success" role="status">{notice}</div>}
        {pending && <div className="stale-snapshot"><p>已有钱包请求，仅核查回执，不会重复提交。</p>{pending.hash ? <button className="button compact" disabled={!!busy} onClick={() => { void action('核查已提交交易', (identity) => finish(pending, identity), true); }}>核查现有回执</button> : <><input aria-label="已提交交易哈希" placeholder="从钱包活动复制 0x… 交易哈希" value={hashInput} onChange={(event) => setHashInput(event.target.value)} /><button className="button compact" disabled={!!busy || !validHash(hashInput)} onClick={() => { void action('只读核查钱包交易', async (identity) => { const restored = { ...pending, hash: hashInput as Hex }; save(currentDraft, restored, restored.owner, restored.seller, restored.chainId, identity); await finish(restored, identity); }, true); }}>核查该交易</button></>}</div>}
      </section></aside></div>
      {currentTask && <section className="panel task-panel" data-testid="opening-task"><div className="panel-heading"><div><div className="eyebrow">任务进度 · {shortAddress(currentTask.taskId)}</div><h2>{taskLabels[currentTask.status] || '正在核查任务'}</h2></div><span className="status-pill">{currentTask.serviceStatus === 'Prepared' ? '已预签 · 等待投递' : serviceLabels[currentTask.serviceStatus] || currentTask.serviceStatus}</span></div><div className="task-metrics"><div className="metric"><span>已卖出</span><strong>{display(currentTask.soldInput, 6)}<small>NBDAO</small></strong></div><div className="metric"><span>实际到账</span><strong>{display(currentTask.receivedUSDT, 6)}<small>USDT</small></strong></div><div className="metric"><span>执行 Gas / 抢排序费</span><strong>{display(currentTask.gasSpentWei, 8)} / {display(currentTask.builderFeeSpentWei, 8)}<small>BNB</small></strong></div></div><p className="snapshot-caption">{currentTask.reason}</p><p className="snapshot-caption">{beijingLabel(currentTask.notBefore)} 至 {beijingLabel(currentTask.expiresAt)} · 最低到账 {display(currentTask.minTotalUSDT, 6)} USDT</p>{currentTask.txHash && config?.explorerUrl && <a className="transaction-link" href={`${config.explorerUrl}/tx/${currentTask.txHash}`} target="_blank" rel="noreferrer">查看卖出交易 ↗</a>}{armed && <div className="task-actions"><button className="button danger compact" disabled={!canManage || !!busy || !!pending} onClick={() => { void cancelTask(); }}>取消任务</button><span className="muted">取消需要钱包确认并另付 Gas。</span></div>}</section>}
      <LastSale explorerUrl={config?.explorerUrl}/>
      <footer><a href="/">返回窗口监控卖出</a><span>一次性日期任务 · 有限授权 · 实际到账底线</span></footer>
    </main></div>;
}
