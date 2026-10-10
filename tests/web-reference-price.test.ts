import { describe, expect, it } from 'vitest';
import { holdingReference, referenceNumber } from '../apps/web/src/lib/reference-price.ts';

describe('pool reference values', () => {
  it('uses the reward-inclusive raw balance exactly once without first rounding the price', () => {
    expect(holdingReference('3', '2', '3')).toBe(2n);
    expect(holdingReference('216088122000000000000', '688963231009680673153742', '3153781333736124979040080')).toBe(47205799946684094342n);
  });
  it('never renders a positive tiny price as zero', () => {
    expect(referenceNumber(1n, 18, 8)).toBe('< 0.00000001');
    expect(referenceNumber(0n, 18, 8, true)).toBe('< 0.00000001');
    expect(referenceNumber(215123456789000000n, 18, 8)).toBe('0.21512345');
  });
  it('formats real zero holdings and different USDT decimals correctly', () => {
    expect(referenceNumber(0n, 6, 4, false)).toBe('0');
    expect(referenceNumber(123456789n, 6, 4)).toBe('123.4567');
    expect(referenceNumber(1234500000000000000000n, 18, 4)).toBe('1,234.5');
  });
  it('rejects unreadable or empty reserves instead of producing a fake price', () => {
    expect(() => holdingReference('10', '0', '100')).toThrow('不可用');
    expect(() => holdingReference('10', '100', 'bad')).toThrow('无效');
  });
});
