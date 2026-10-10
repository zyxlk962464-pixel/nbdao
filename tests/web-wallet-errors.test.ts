import { expect, it } from 'vitest';
import { walletError } from '../apps/web/src/lib/wallet-errors.ts';

it('distinguishes an added-but-unswitched network from a wrapped wallet rejection', () => {
  const wrapped = {
    code: 4001,
    shortMessage: 'User rejected the request.',
    cause: { message: 'User rejected switch after adding network.' },
  };
  expect(walletError(wrapped)).toBe('网络已添加但尚未切换，请再次点击切换网络，或在钱包中手动选择目标网络。');
  expect(walletError({ code: 4001 })).toBe('已取消钱包请求，可重新连接或重试。');
  expect(walletError({ code: -32002 })).toBe('钱包已有待处理请求，请先打开钱包处理后再重试。');
});
