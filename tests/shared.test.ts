import { describe,it,expect } from 'vitest';
import { formatUnits } from 'viem';
import { UNIT,beijingSeconds,decimal,floorFromTotal,legalIntegerCap,minimumOutput,slipMinimum,policyMessage } from '../packages/shared/src/index.js';
describe('financial amounts and dates',()=>{
  it('rejects float coercion and preserves smallest unit',()=>{
    expect(decimal('9007199254740993.000000000000000001')).toBe(9007199254740993n*UNIT+1n);
    for(const s of ['1e3','-1','NaN','0.0000000000000000001','01','1.'])expect(()=>decimal(s)).toThrow();
  });
  it('accepts the largest uint256 amount and rejects overflow or unbounded input',()=>{
    const max=2n**256n-1n;expect(decimal(formatUnits(max,18))).toBe(max);
    expect(()=>decimal(formatUnits(max+1n,18))).toThrow('合约');expect(()=>decimal('9'.repeat(1000))).toThrow();
  });
  it('rounds total floor upward so batches cannot weaken it',()=>{
    const p=floorFromTotal(2n,3n*UNIT); expect(minimumOutput(3n*UNIT,p)).toBeGreaterThanOrEqual(2n);
    expect(minimumOutput(1n,1n)).toBe(1n);
  });
  it('honors integer token limit across rounding boundaries',()=>{
    for(let r=1n;r<301n;r++) {
      const cap=legalIntegerCap(r); expect(cap*100n/r).toBeLessThanOrEqual(1n);
      expect((cap+1n)*100n/r).toBeGreaterThan(1n);
    }
  });
  it('cannot soften onchain floor with quote slippage',()=>{
    expect(slipMinimum(1000n,500,980n)).toBe(980n);
    expect(slipMinimum(1000n,100,0n)).toBe(990n);
    expect(()=>slipMinimum(1000n,10001,1n)).toThrow();
  });
  it('uses explicit Beijing UTC offset and rejects nonexistent days',()=>{
    expect(beijingSeconds('2026-10-10')).toBe(1791590400);
    expect(()=>beijingSeconds('2026-02-30')).toThrow();
    expect(()=>beijingSeconds('2026-10-10','25:00')).toThrow();
  });
  it('binds signed service policy to chain, contract and immutable task',()=>{
    const p={slippageBps:100,maxAttempts:3,gasBudgetWei:'1',maxTxGasWei:'1',minEconomicUSDT:'1',confirmations:2,maxQuoteAgeBlocks:2};
    const a='0x0000000000000000000000000000000000000001' as const;
    const id=`0x${'1'.repeat(64)}` as const;
    expect(policyMessage(56,a,id,p)).not.toEqual(policyMessage(31337,a,id,p));
    expect(policyMessage(56,a,id,p)).not.toEqual(policyMessage(56,a,id,{...p,slippageBps:200}));
    expect(policyMessage(56,a,id,p)).not.toEqual(policyMessage(56,a,id,{...p,maxSellFeePercent:5}));
    expect(policyMessage(56,a,id,{...p,maxSellFeePercent:5})).not.toEqual(policyMessage(56,a,id,{...p,maxSellFeePercent:10}));
    // Legacy messages remain byte-for-byte recoverable; adding a threshold needs a new signature.
    expect(policyMessage(56,a,id,p)).toBe(`NBDAO 自动清仓服务参数确认\nChain ID: 56\n执行合约: ${a}\n任务: ${id}\n服务参数: ${JSON.stringify(p)}\n该签名用于绑定本任务的执行预算和滑点，不授予额外资产权限。`);
  });
});
