import { formatUnits } from 'viem';

/** Raw balanceOf includes pending rewards. Do not add pending to this balance again. */
export function holdingReference(balance: string, reserveUSDT: string, reserveToken: string) {
  if (![balance, reserveUSDT, reserveToken].every((value) => /^\d+$/.test(value))) throw new Error('价格或余额数据无效');
  const amount = BigInt(balance), usdt = BigInt(reserveUSDT), token = BigInt(reserveToken);
  if (usdt <= 0n || token <= 0n) throw new Error('池子储备不可用');
  return amount * usdt / token;
}
export function referenceNumber(value: bigint, decimals: number, digits: number, positive = value > 0n) {
  if (value < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !Number.isInteger(digits) || digits < 1 || digits > 12) throw new Error('参考金额格式无效');
  const [whole = '0', fraction = ''] = formatUnits(value, decimals).split('.');
  const trimmed = fraction.slice(0, digits).replace(/0+$/, '');
  if (positive && whole === '0' && !trimmed) return `< 0.${'0'.repeat(digits - 1)}1`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}
