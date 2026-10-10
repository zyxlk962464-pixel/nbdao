// Browser-only fixtures. This script never signs or submits a transaction.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WEB_TEST_URL || 'http://127.0.0.1:3002';
const output = new URL('../qa/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const address = '0x0000000000000000000000000000000000000011';
let configuredReadonly = false;
await page.addInitScript(({ address }) => {
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x38';
      throw new Error(`UI smoke fixture refuses wallet operation: ${method}`);
    }, on: () => {}, removeListener: () => {},
  };
}, { address });
await page.route('**/api/config', (route) => route.fulfill({ json: {
  mode: 'read-only', chainId: 56, chainName: 'BNB Smart Chain', addresses: {
    token: '0x63d1eacebb70bbbf0641e7c88e9099301bba3688', usdt: '0x55d398326f99059ff775485246999027b3197955', pair: '0x17662cadea9e98a5a660ca1fe993f136d3cb0ae1', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', fund: '0xe384b8c558513b50865de6fae8d56a27bc8be7ac', autoSwap: '0x3d0c49b3187b869a40fc88a98b2ae1b9efd2fca1', wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  }, sellerAddress: configuredReadonly ? '0x0000000000000000000000000000000000000022' : null, executor: configuredReadonly ? '0x0000000000000000000000000000000000000033' : null,
  walletRpcUrl: 'https://bsc-dataseed.bnbchain.org', explorerUrl: 'https://bscscan.com', ready: configuredReadonly, missing: configuredReadonly ? [] : ['UI 测试：尚未配置执行合约'],
} }));
await page.route('**/api/wallet/*', (route) => route.fulfill({ json: {
  owner: address, tokenBalance: '1000000000000000000000', pending: '20000000000000000000', usdtBalance: '100000000000000000000', bnbBalance: '100000000000000000', allowance: '0', blockNumber: '126614659', blockHash: `0x${'1'.repeat(64)}`, timestamp: '1791539371', sellFee: '100', reserveToken: '3153781333736124979040080', reserveUSDT: '688963231009680673153742',
} }));
await page.route('**/api/tasks/*', (route) => route.fulfill({ json: { tasks: [] } }));
await page.goto(origin, { waitUntil: 'networkidle' });
assert.equal(await page.getByRole('heading', { name: /让清仓/ }).count(), 1);
assert.equal(await page.getByRole('button', { name: /模拟卖出/ }).isDisabled(), true);
await page.getByRole('button', { name: /连接钱包/ }).first().click();
await page.getByTestId('wallet-connector-injected').click();
await page.getByText('1,000', { exact: false }).first().waitFor();
assert.equal(await page.getByRole('button', { name: /创建清仓任务/ }).isDisabled(), true);
assert.equal(await page.getByRole('button', { name: /模拟卖出/ }).isDisabled(), true);
await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)), fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
assert.equal(overflow, false, 'mobile layout should not overflow horizontally');
await page.getByText('执行预算与奖励余量').click();
assert.equal(await page.getByRole('textbox', { name: '额外奖励额度' }).isVisible(), true);
await page.getByRole('button', { name: /0x0000/ }).click();
await page.getByRole('button', { name: '断开连接' }).click();
assert.equal(await page.getByRole('button', { name: /连接钱包/ }).first().isVisible(), true);
configuredReadonly = true;
await page.reload({ waitUntil: 'networkidle' });
await page.getByText('观察模式 · 自动执行未开启').waitFor();
await page.getByRole('button', { name: /连接钱包/ }).first().click();
await page.getByTestId('wallet-connector-injected').click();
await page.getByText('1,000', { exact: false }).first().waitFor();
await page.getByRole('textbox', { name: '最低全量 USDT' }).fill('100');
assert.equal(await page.getByRole('button', { name: /模拟卖出/ }).isDisabled(), true, 'configured read-only mode must not start new tasks');
assert.deepEqual(errors, []);
await browser.close();
console.log('UI smoke passed: real injected connector, read-only write gating, account disconnect reset, desktop/mobile layout. Fixtures never sign or submit.');
