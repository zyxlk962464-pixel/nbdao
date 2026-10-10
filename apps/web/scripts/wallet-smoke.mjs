/**
 * Development-only EIP-1193/EIP-6963 fixtures for CUA CDP browser verification.
 * Prepared for isolated test environments with an explicitly supported initialization hook.
 * Current CUA Chrome does not support that hook; handshake cases were not executed.
 * This module does not open a browser or establish a wallet connection.
 * No private key, relay, signature or transaction implementation exists here.
 */
export const TEST_ACCOUNTS = {
  first: '0x0000000000000000000000000000000000000011',
  second: '0x0000000000000000000000000000000000000044',
};
export function walletFixtureSource(options = {}) {
  return `(${installWalletFixture.toString()})(${JSON.stringify({ wallets: true, ready: true, ...options })});`;
}
function installWalletFixture(options) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
  const A = '0x0000000000000000000000000000000000000011';
  const B = '0x0000000000000000000000000000000000000044';
  const records = [];
  const controllers = new Map();
  const safeCounts = () => ({
    signatures: records.filter(r => /^(personal_sign|eth_sign|eth_signTypedData)/.test(r.method)).length,
    transactions: records.filter(r => /^(eth_sendTransaction|eth_sendRawTransaction)/.test(r.method)).length,
    requests: records.filter(r => r.method === 'eth_requestAccounts').length,
    switches: records.filter(r => r.method === 'wallet_switchEthereumChain').length,
    adds: records.filter(r => r.method === 'wallet_addEthereumChain').length,
  });
  const state = { rejectOnce: false, delayConnect: false, missingChain: false, delayWalletAPI: false, delayedAPI: [] };
  const makeProvider = (name, rdns, uuid) => {
    const key = `nbdao-wallet-fixture:${uuid}`;
    let saved = {}; try { saved = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch {}
    const internal = { authorized: Boolean(saved.authorized), account: saved.account || A, chainId: saved.chainId || '0x38' };
    const listeners = new Map(); let pending;
    const persist = () => sessionStorage.setItem(key, JSON.stringify(internal));
    const emit = (name, value) => { for (const f of listeners.get(name) || []) f(value); };
    const provider = {
      isMetaMask: name === 'MetaMask', isRabby: name === 'Rabby',
      on(event, listener) { const set = listeners.get(event) || new Set(); set.add(listener); listeners.set(event, set); return provider; },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); return provider; },
      async request({ method, params = [] }) {
        records.push({ provider: name, method, params });
        if (/^(personal_sign|eth_sign|eth_signTypedData|eth_sendTransaction|eth_sendRawTransaction)/.test(method)) throw Object.assign(new Error('Test fixture refuses every signature and transaction'), { code: 4001 });
        if (method === 'eth_accounts') return internal.authorized ? [internal.account] : [];
        if (method === 'eth_chainId') return internal.chainId;
        if (method === 'net_version') return String(parseInt(internal.chainId, 16));
        if (method === 'eth_requestAccounts') {
          if (state.rejectOnce) { state.rejectOnce = false; throw Object.assign(new Error('User rejected the request'), { code: 4001 }); }
          if (state.delayConnect) await new Promise(resolve => { pending = resolve; });
          internal.authorized = true; persist(); return [internal.account];
        }
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [internal.account] }] }];
        if (method === 'wallet_revokePermissions') { internal.authorized = false; persist(); return null; }
        if (method === 'wallet_switchEthereumChain') {
          if (state.missingChain) { state.missingChain = false; throw Object.assign(new Error('Unrecognized chain'), { code: 4902 }); }
          internal.chainId = params[0].chainId; persist(); emit('chainChanged', internal.chainId); return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        throw Object.assign(new Error(`Unsupported test method ${method}`), { code: -32601 });
      },
    };
    controllers.set(name, {
      resolve() { state.delayConnect = false; pending?.(); },
      account(account) { internal.account = account; internal.authorized = true; persist(); emit('accountsChanged', [account]); },
      chain(chainId) { internal.chainId = chainId; persist(); emit('chainChanged', chainId); },
    });
    return { info: { name, rdns, uuid, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="%23546b49"/></svg>' }, provider };
  };
  const details = options.wallets ? [makeProvider('MetaMask', 'io.metamask', 'f9dd9658-0c4b-4dc7-aa0d-35d45336e400'), makeProvider('Rabby', 'io.rabby', 'fa832795-4a18-4ed8-8a52-d6194d1a5fef')] : [];
  Object.defineProperty(window, 'ethereum', { configurable: false, get: () => details[0]?.provider });
  const announce = () => { for (const detail of details) { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); } };
  window.addEventListener('eip6963:requestProvider', announce);
  const config = { mode: 'read-only', chainId: 56, chainName: 'BNB Smart Chain', addresses: {
    token:'0x63d1eacebb70bbbf0641e7c88e9099301bba3688',usdt:'0x55d398326f99059ff775485246999027b3197955',pair:'0x17662cadea9e98a5a660ca1fe993f136d3cb0ae1',router:'0x10ed43c718714eb63d5aa57b78b54704e256024e',factory:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73',fund:'0xe384b8c558513b50865de6fae8d56a27bc8be7ac',autoSwap:'0x3d0c49b3187b869a40fc88a98b2ae1b9efd2fca1',wbnb:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  }, sellerAddress: options.ready?'0x0000000000000000000000000000000000000022':null, executor:options.ready?'0x0000000000000000000000000000000000000033':null, walletRpcUrl:'https://bsc-dataseed.bnbchain.org', explorerUrl:'https://bscscan.com', ready:options.ready, missing:options.ready?[]:['UI fixture: not configured'] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const path=url.pathname.slice(5); let result;
    if (path==='config') result=config;
    else if (path.startsWith('wallet/')) {
      const owner=path.slice(7), second=owner.toLowerCase()===B.toLowerCase();
      result={owner,tokenBalance:second?'2000000000000000000000':'1000000000000000000000',pending:'20000000000000000000',usdtBalance:'100000000000000000000',bnbBalance:'100000000000000000000',allowance:'0',blockNumber:'126614659',blockHash:'0x'+'1'.repeat(64),timestamp:'1791539371',sellFee:'100',reserveToken:'3153781333736124979040080',reserveUSDT:'688963231009680673153742'};
      if(state.delayWalletAPI&&!second) await new Promise(resolve=>state.delayedAPI.push(resolve));
    }else if(path.startsWith('tasks/'))result={tasks:[]};
    else return new Response(JSON.stringify({error:'Fixture forbids API writes'}),{status:403,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  };
  window.__walletFixture={records,state,counts:safeCounts,announce,configure(options){Object.assign(state,options);},resolveConnect(name='MetaMask'){controllers.get(name)?.resolve();},switchAccount(name='MetaMask'){controllers.get(name)?.account(B);},wrongChain(name='MetaMask'){controllers.get(name)?.chain('0x1');},releaseAPI(){state.delayWalletAPI=false;for(const resolve of state.delayedAPI.splice(0))resolve();}};
}
export const WALLET_SMOKE_CASES = [
  'No provider has a clear install hint and no unusable generic connect option',
  'Repeated EIP-6963 announcements show one MetaMask and one Rabby option',
  'Rejected connection can be retried; pending connection disables every option',
  'Reload restores the previously authorized connector without a new account request',
  'AccountsChanged clears old data; stale API responses do not overwrite new account',
  'Wrong chain uses switch, and 4902 uses add with configured target then switch',
  'Disconnect clears wallet balance and gate remains disabled in read-only mode',
  'Desktop/mobile wallet dialogs stay inside viewport',
  'Signature and transaction method call counts remain zero',
];
