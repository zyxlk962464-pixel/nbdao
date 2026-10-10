'use client';

import { useEffect, useRef, useState } from 'react';
import { useConnection, useWalletClient } from 'wagmi';
import { bsc } from 'viem/chains';
import { keccak256, formatUnits, type Address, type Hex } from 'viem';
import { BSC, display, stringify, type AppConfig } from '@nbdao/shared';
import WalletPanel from '../wallet-panel';
import { LatestRead, OperationGate, WalletSession } from '@/lib/wallet-session';
import { DEPLOY_BYTECODE_HASH, DEPLOY_FEE_CAP, deploymentKey, validDeploymentRecord, type DeploymentInfo, type DeploymentPlan, type DeploymentRecord, type DeploymentReceipt } from '@/lib/deployment';
import { walletError } from '@/lib/wallet-errors';
import styles from './page.module.css';

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '只读核查失败，未发送交易');
  return result as T;
}
function rejected(error: unknown) {
  let value = error as { code?: number; cause?: unknown } | undefined;
  for (let i = 0; value && i < 8; i++) { if (value.code === 4001) return true; value = value.cause as typeof value; }
  return false;
}
export default function DeployPage() {
  const connection = useConnection();
  const { address, chainId, status } = connection;
  const walletClient = useWalletClient({ chainId: 56 });
  const [info, setInfo] = useState<DeploymentInfo | null>(null);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [record, setRecord] = useState<DeploymentRecord | null>(null);
  const [receipt, setReceipt] = useState<DeploymentReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [open, setOpen] = useState(false);
  const [hashInput, setHashInput] = useState('');
  const session = useRef(new WalletSession());
  const generation = session.current.update(`${address || ''}:${chainId || ''}:${connection.connector?.uid || ''}:${status}`);
  const gate = useRef(new OperationGate());
  const reads = useRef(new LatestRead());
  const memory = useRef(new Map<string, DeploymentRecord>());
  const connected = status === 'connected' && chainId === 56 && !!address;
  const currentPlan = plan?.owner.toLowerCase() === address?.toLowerCase() && connected ? plan : null;
  const currentRecord = record?.owner.toLowerCase() === address?.toLowerCase() ? record : null;
  const config: AppConfig = { mode: 'read-only', chainId: 56, chainName: 'BNB Smart Chain', addresses: BSC, sellerAddress: null, executor: null,
    walletRpcUrl: info?.walletRpcUrl || 'https://bsc-dataseed.bnbchain.org', explorerUrl: 'https://bscscan.com', ready: false, missing: [] };

  useEffect(() => { void read<DeploymentInfo>('/api/deploy').then((value) => {
    if (value.chainId !== 56 || value.bytecodeHash !== DEPLOY_BYTECODE_HASH || keccak256(value.bytecode) !== DEPLOY_BYTECODE_HASH) throw new Error('服务提供的部署版本不匹配');
    setInfo(value);
  }).catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => {
    setPlan(null); setReceipt(null); setRecord(null); setError(''); setStorageError(false); setHashInput('');
    if (gate.current.busy) setBusy('上一钱包请求尚未结束，暂不发起新的部署');
    if (!address) return;
    const key = deploymentKey(address), cached = memory.current.get(key);
    if (cached) { setRecord(cached); return; }
    try {
      const value = localStorage.getItem(key);
      if (!value) return;
      const parsed = JSON.parse(value);
      if (!validDeploymentRecord(parsed, address)) throw new Error('恢复记录无效，请先在 MetaMask 核查历史交易，暂不允许新部署');
      memory.current.set(key, parsed); setRecord(parsed);
    } catch (e) { setStorageError(true); setError((e as Error).message || '浏览器无法恢复部署记录，暂不允许新部署'); }
  }, [generation, address]);

  function getStored(owner: Address) {
    const key = deploymentKey(owner), cached = memory.current.get(key);
    if (cached) return cached;
    const value = localStorage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value);
    if (!validDeploymentRecord(parsed, owner)) throw new Error('部署恢复记录无效，请先核查 MetaMask，不再提交交易');
    memory.current.set(key, parsed); return parsed;
  }
  function persist(value: DeploymentRecord, identity: number, required = false) {
    const key = deploymentKey(value.owner), serialized = stringify(value);
    if (required) {
      try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error('无法校验恢复记录'); }
      catch { if (session.current.isCurrent(identity)) setStorageError(true); throw new Error('浏览器无法持久保存部署记录，已停止，不会发送钱包交易'); }
    } else {
      try { localStorage.setItem(key, serialized); } catch { /* The pre-request nonce record still blocks resubmission; memory retains the returned hash. */ }
    }
    memory.current.set(key, value);
    if (session.current.isCurrent(identity)) setRecord(value);
  }
  async function run(label: string, callback: (identity: number) => Promise<void>) {
    const identity = generation;
    if (!session.current.isCurrent(identity)) return;
    const token = gate.current.acquire();
    if (!token) return;
    setBusy(label); setError('');
    try { await callback(identity); }
    catch (e) { if (session.current.isCurrent(identity)) setError((e as Error).message || '核查失败，请重试只读查询'); }
    finally { gate.current.release(token); setBusy(''); }
  }
  function assertSession(identity: number) { if (!session.current.isCurrent(identity)) throw new Error('钱包或网络已变化，已停止当前操作'); }
  async function prepare() {
    if (!connected || !address || !info || gate.current.busy) return;
    await run('正在免费预检部署与费用', async (identity) => {
      const next = await read<DeploymentPlan>(`/api/deploy?owner=${address}`);
      assertSession(identity); setPlan(next);
    });
  }
  async function verify(value = currentRecord) {
    if (!value?.hash || !connected || value.owner.toLowerCase() !== address?.toLowerCase()) return;
    const identity = generation, sequence = reads.current.start();
    const result = await read<DeploymentReceipt>(`/api/deploy/receipt?owner=${value.owner}&hash=${value.hash}&nonce=${value.nonce}&runtimeHash=${value.runtimeHash}`);
    if (!session.current.isCurrent(identity) || !reads.current.isCurrent(sequence)) return;
    setReceipt(result);
    if (result.state === 'confirmed' || result.state === 'reverted') persist({ ...value, stage: result.state }, identity);
    return result;
  }
  useEffect(() => {
    if (!connected || !currentRecord?.hash) return;
    let stopped = false, count = 0;
    const tick = () => { if (stopped || count++ >= 20) return; void verify(currentRecord).catch((e) => { if (!stopped) setError((e as Error).message || '回执核查暂不可用，不会重新发送'); }); };
    tick();
    const timer = setInterval(() => { if (receipt?.state === 'confirmed' || receipt?.state === 'reverted') return; tick(); }, 8000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connected, currentRecord?.hash, currentRecord?.stage, generation]);

  async function deploy() {
    if (!connected || !address || !currentPlan || !walletClient.data || currentRecord || storageError || gate.current.busy) return;
    await run('重新核查费用，然后等待你在 MetaMask 确认', async (identity) => {
      const old = getStored(address);
      if (old) { setRecord(old); throw new Error('已有部署记录，请只核查回执，禁止重复提交'); }
      const fresh = await read<DeploymentPlan>(`/api/deploy?owner=${address}`);
      assertSession(identity);
      if (fresh.bytecodeHash !== DEPLOY_BYTECODE_HASH || keccak256(fresh.bytecode) !== DEPLOY_BYTECODE_HASH || BigInt(fresh.maxFeeWei) > DEPLOY_FEE_CAP || BigInt(fresh.gasLimit) * BigInt(fresh.gasPriceWei) !== BigInt(fresh.maxFeeWei)) throw new Error('固定部署版本或费用上限核查失败，未发送交易');
      setPlan(fresh);
      if (fresh.nonce !== currentPlan.nonce) throw new Error('钱包 nonce 已变化，请查看更新后的免费预检再决定，不自动发送');
      if (walletClient.data!.account.address.toLowerCase() !== address.toLowerCase() || await walletClient.data!.getChainId() !== 56) throw new Error('实际钱包账户或链不匹配，未发送交易');
      assertSession(identity);
      const pending: DeploymentRecord = { owner: address, chainId: 56, bytecodeHash: DEPLOY_BYTECODE_HASH, nonce: fresh.nonce, createdAt: Date.now(), stage: 'wallet-request', hash: null,
        runtimeHash: fresh.runtimeHash, gasLimit: fresh.gasLimit, gasPriceWei: fresh.gasPriceWei };
      persist(pending, identity, true);
      try {
        // This call can only be reached by the user's button click. MetaMask signs it; the server never broadcasts.
        const hash = await walletClient.data!.deployContract({ account: address, chain: bsc, abi: fresh.abi, bytecode: fresh.bytecode, value: 0n,
          type: 'legacy', gas: BigInt(fresh.gasLimit), gasPrice: BigInt(fresh.gasPriceWei), nonce: fresh.nonce });
        const submitted = { ...pending, stage: 'submitted' as const, hash };
        persist(submitted, identity);
        if (session.current.isCurrent(identity)) { setHashInput(hash); await verify(submitted); }
      } catch (e) {
        if (rejected(e)) {
          memory.current.delete(deploymentKey(address));
          try { localStorage.removeItem(deploymentKey(address)); } catch { /* Keep the saved request if removal is denied; never bypass it automatically. */ }
          if (session.current.isCurrent(identity)) { setRecord(null); setError(walletError(e)); }
          return;
        }
        if (session.current.isCurrent(identity)) setError('钱包请求或回执状态尚未明确，禁止再次部署。请在 MetaMask 活动记录找到交易哈希，再做只读核查。');
      }
    });
  }
  async function useHash() {
    if (!currentRecord || !/^0x[0-9a-fA-F]{64}$/.test(hashInput.trim())) { setError('请输入 MetaMask 活动记录中的完整交易哈希'); return; }
    await run('只读核查钱包中的交易哈希', async (identity) => {
      const next = { ...currentRecord, stage: 'submitted' as const, hash: hashInput.trim() as Hex };
      const result = await verify(next);
      assertSession(identity);
      if (!result) throw new Error('回执核查尚未完成，请保持现有请求记录');
      persist({ ...next, stage: result.state === 'confirmed' || result.state === 'reverted' ? result.state : 'submitted' }, identity);
    });
  }

  const valid = !!info && !!currentPlan && connected && !!walletClient.data && !currentRecord && !storageError && !busy;
  return <div className="app-shell"><header className="topbar"><a className="brand" href="/"><span className="brand-icon">N</span><span>NBDAO<span className="brand-sub">DEPLOY</span></span></a><div className="top-actions"><span className="network-badge"><i />BSC 主网 · 56</span><WalletPanel config={config} wallet={currentPlan ? { owner: currentPlan.owner, bnbBalance: currentPlan.balanceWei } : null} fresh={!!currentPlan} refreshing={!!busy && !currentRecord} busy={!!busy} refresh={prepare} open={open} setOpen={setOpen} /></div></header>
    <main className={styles.main}><div className="eyebrow">一次性部署 · MetaMask 签名 · 固定合约</div><h1>先看清费用，再由你确认。</h1><p className={styles.lead}>这里只部署真实 NBDAOSeller 合约。不会授权代币、创建卖出任务或启用 Keeper。</p>
      <section className={`panel ${styles.panel}`}><div className="panel-heading"><div><div className="eyebrow">固定版本 / solc 0.8.30</div><h2>NBDAOSeller · 无构造参数</h2></div><span className={styles.cap}>部署请求上限 0.00015 BNB</span></div>
        <dl className={styles.details}><div><dt>部署钱包</dt><dd>{address || '请先连接 MetaMask'}</dd></div><div><dt>转入合约的 BNB</dt><dd>0 BNB · value = 0</dd></div><div><dt>固定创建代码哈希</dt><dd>{DEPLOY_BYTECODE_HASH}</dd></div>
          {currentPlan && <><div><dt>当前 BNB 余额</dt><dd>{display(currentPlan.balanceWei, 8)} BNB</dd></div><div><dt>Nonce / 预检区块</dt><dd>{currentPlan.nonce} / #{currentPlan.blockNumber}</dd></div><div><dt>估算 Gas / 请求 Gas Limit</dt><dd>{currentPlan.estimatedGas} / {currentPlan.gasLimit}（含 20% 余量）</dd></div><div><dt>最新请求 Gas Price</dt><dd>{formatUnits(BigInt(currentPlan.gasPriceWei), 9)} Gwei</dd></div><div><dt>本次请求最高 Gas 费</dt><dd className={styles.fee}>{display(currentPlan.maxFeeWei, 10)} BNB</dd></div></>}
        </dl>
        {!connected && <p className={styles.note}>请连接 MetaMask 并选择 BSC（56）。连接不会发送交易。</p>}
        {connected && !currentRecord && <div className={styles.actions}><button className="button secondary" disabled={!info || !!busy || storageError} onClick={() => { void prepare(); }}>免费预检 / 刷新费用</button><button data-testid="deploy-submit" className="button primary" disabled={!valid} onClick={() => { void deploy(); }}>由我在 MetaMask 确认部署</button></div>}
        <p className={styles.note}>部署前会重新模拟与估费，超出上限即停止。钱包签名时请保持显示的 Gas 参数；自行在 MetaMask 改高费用会超出本页请求预算。无人确认时不会部署。</p>
        {busy && <div className="operation-state" role="status"><span className="spinner" />{busy}</div>}{error && <div className="inline-error" role="alert">{error}</div>}
      </section>
      {currentRecord && <section className={`panel ${styles.panel}`}><div className="eyebrow">已保存请求 · nonce {currentRecord.nonce}</div><h2>{receipt?.state === 'confirmed' ? '部署完成，运行代码已核验' : receipt?.state === 'reverted' ? '部署回滚，不会自动重试' : '只核查已有请求，不重复部署'}</h2>
        <p className={styles.note}>{receipt?.reason || (currentRecord.hash ? '交易已提交，正在只读核查回执。' : '钱包请求状态尚未明确。请查看 MetaMask 活动记录，勿重复部署。')}</p>
        {currentRecord.hash && <a className="transaction-link" href={`https://bscscan.com/tx/${currentRecord.hash}`} target="_blank" rel="noreferrer">查看交易 {currentRecord.hash} ↗</a>}
        {receipt?.contractAddress && <div className={styles.success}><span>已核验的 BSC 合约地址</span><strong data-testid="deployed-address">{receipt.contractAddress}</strong><p>区块 #{receipt.blockNumber} · {receipt.confirmations} 个区块确认 · 实际 Gas {display(receipt.feeWei, 10)} BNB</p><a href={`https://bscscan.com/address/${receipt.contractAddress}`} target="_blank" rel="noreferrer">在 BscScan 查看 ↗</a></div>}
        {receipt?.feeWei && BigInt(receipt.feeWei) > DEPLOY_FEE_CAP && <p className="inline-error">实际签名费用超过本页请求上限，请核查是否在 MetaMask 中修改了 Gas 参数。</p>}
        {!receipt?.contractAddress && receipt?.state !== 'reverted' && <div className={styles.hashRecovery}><label htmlFor="deployment-hash">从 MetaMask 活动记录复制交易哈希，只读核查</label><input id="deployment-hash" placeholder="0x…（不是私钥）" value={hashInput} onChange={(event) => setHashInput(event.target.value)} /><button className="button compact" disabled={!!busy || !connected} onClick={() => { void useHash(); }}>核查此哈希</button>{currentRecord.hash && <button className="button compact" disabled={!!busy || !connected} onClick={() => { void run('刷新回执，不发送交易', async () => { await verify(); }); }}>刷新现有回执</button>}</div>}
        <p className={styles.note}>部署地址只在此展示，尚未配置自动卖出。后续真实小额卖出需要独立额度与模拟；当前全余额卖出页不用于本次小额测试。</p>
      </section>}
      <footer><a href="/">返回自动清仓页面</a><span>无私钥导出 · 服务器只读预检 · 所有签名由你确认</span></footer>
    </main>
  </div>;
}
