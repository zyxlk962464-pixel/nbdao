import type { Address } from 'viem';
const PRICE_UNIT=10n**18n;
/** Pool reserve spot reference only. It contains no transfer fees, price impact or Gas. */
export function poolSpotPrice(input:{token:Address;usdt:Address;token0:Address;token1:Address;reserve0:bigint;reserve1:bigint;tokenDecimals:number;usdtDecimals:number}){
  const token=input.token.toLowerCase(),usdt=input.usdt.toLowerCase();
  const first=input.token0.toLowerCase(),second=input.token1.toLowerCase();
  if(token===usdt||!((first===token&&second===usdt)||(first===usdt&&second===token)))throw new Error('价格池的资产与 NBDAO/USDT 配置不匹配');
  if(!Number.isInteger(input.tokenDecimals)||!Number.isInteger(input.usdtDecimals)||input.tokenDecimals<0||input.usdtDecimals<0||input.tokenDecimals>36||input.usdtDecimals>36)throw new Error('价格资产精度不受支持');
  const reserveToken=first===token?input.reserve0:input.reserve1;
  const reserveUSDT=first===usdt?input.reserve0:input.reserve1;
  if(reserveToken<=0n||reserveUSDT<=0n)throw new Error('交易池储备为零，参考价格暂不可用');
  const spotPriceUSDTPerTokenWei=reserveUSDT*(10n**BigInt(input.tokenDecimals))*PRICE_UNIT/(reserveToken*(10n**BigInt(input.usdtDecimals)));
  if(spotPriceUSDTPerTokenWei===0n)throw new Error('参考价格低于 18 位显示精度，暂不可用');
  return {reserveToken:reserveToken.toString(),reserveUSDT:reserveUSDT.toString(),spotPriceUSDTPerTokenWei:spotPriceUSDTPerTokenWei.toString()};
}
