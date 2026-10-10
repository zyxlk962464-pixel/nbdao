import { describe,it,expect,vi } from 'vitest';
import { poolSpotPrice } from '../apps/keeper/src/price.ts';
import { Chain } from '../apps/keeper/src/chain.ts';
import type { Runtime } from '../apps/keeper/src/config.ts';
import { BSC,UNIT } from '../packages/shared/src/index.ts';
const hash=`0x${'ab'.repeat(32)}` as const;
const base={token:BSC.token,usdt:BSC.usdt,token0:BSC.usdt,token1:BSC.token,tokenDecimals:18,usdtDecimals:18,reserve0:200n*UNIT,reserve1:1000n*UNIT};
describe('read-only NBDAO pool reference',()=>{
  it('maps USDT-first and token-first reserves into the same 18-decimal reference',()=>{
    const forward=poolSpotPrice(base),reverse=poolSpotPrice({...base,token0:BSC.token,token1:BSC.usdt,reserve0:base.reserve1,reserve1:base.reserve0});
    expect(forward).toEqual(reverse);expect(forward.spotPriceUSDTPerTokenWei).toBe((UNIT/5n).toString());
    // balanceOf already includes pending: the value formula uses the balance exactly once.
    expect(15n*UNIT*BigInt(forward.reserveUSDT)/BigInt(forward.reserveToken)).toBe(3n*UNIT);
  });
  it('normalizes quote precision without floating asset amounts',()=>{
    expect(poolSpotPrice({...base,reserve0:200n*10n**6n,usdtDecimals:6}).spotPriceUSDTPerTokenWei).toBe((UNIT/5n).toString());
  });
  it('rejects zero reserves, unrelated assets and positive prices below display precision',()=>{
    expect(()=>poolSpotPrice({...base,reserve0:0n})).toThrow('储备为零');expect(()=>poolSpotPrice({...base,reserve1:0n})).toThrow('储备为零');
    expect(()=>poolSpotPrice({...base,token1:BSC.wbnb})).toThrow('不匹配');
    expect(()=>poolSpotPrice({...base,reserve0:1n,reserve1:2n*UNIT})).toThrow('低于');
  });
  it('pins every contract read to the same sampled block and reports its time',async()=>{
    const chain=new Chain({rpcUrls:['http://127.0.0.1:1'],app:{chainId:56,addresses:BSC}} as unknown as Runtime);
    const readContract=vi.fn(async({functionName}:{functionName:string})=>({token0:BSC.usdt,token1:BSC.token,getReserves:[200n*UNIT,1000n*UNIT,1791549370],decimals:18}[functionName]));
    chain.client={getChainId:async()=>56,getBlock:async()=>({number:123n,hash,timestamp:1791549380n}),readContract} as unknown as Chain['client'];
    const result=await chain.price();expect(result.blockNumber).toBe('123');expect(result.blockHash).toBe(hash);expect(result.timestamp).toBe('1791549380');expect(result.poolTimestamp).toBe('1791549370');
    expect(readContract).toHaveBeenCalledTimes(5);for(const [request]of readContract.mock.calls)expect(request).toHaveProperty('blockNumber',123n);
    expect(result.spotPriceUSDTPerTokenWei).toBe((UNIT/5n).toString());
  });
  it('propagates wrong-network and RPC errors instead of returning fake zero price',async()=>{
    const chain=new Chain({rpcUrls:['http://127.0.0.1:1'],app:{chainId:56,addresses:BSC}} as unknown as Runtime);
    chain.client={getChainId:async()=>1,getBlock:async()=>({number:1n,hash,timestamp:1n})} as unknown as Chain['client'];
    await expect(chain.price()).rejects.toThrow('网络');
    chain.client={getChainId:async()=>56,getBlock:async()=>{throw new Error('RPC offline');}} as unknown as Chain['client'];
    await expect(chain.price()).rejects.toThrow('RPC offline');
  });
});
