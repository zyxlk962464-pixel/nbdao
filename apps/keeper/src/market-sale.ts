import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import { pairAbi, tokenAbi, type SaleRecord } from '../../../packages/shared/src/index.js';

export type MarketSaleConfig={chainId:number;token:Address;pair:Address;usdt:Address};
export type MarketSaleReceipt=Pick<TransactionReceipt,'status'|'transactionHash'|'blockNumber'|'blockHash'|'gasUsed'|'effectiveGasPrice'|'logs'>;
export type MarketSaleBlock={timestamp:bigint;hash:Hex|null;number?:bigint|null};
const normalized=(address:string)=>address.toLowerCase();
const unknownSettlement='换出 USDT 由其他地址收取，无法归属这次持币地址到账。';

/** Receipt evidence only: never substitutes pool input or a block-end tax getter for wallet outflows. */
export function parseMarketSales(config:MarketSaleConfig,tx:{from:Address},receipt:MarketSaleReceipt,block:MarketSaleBlock):SaleRecord[]{
  if(receipt.status!=='success')return [];
  if(!block.hash||normalized(block.hash)!==normalized(receipt.blockHash)||(block.number!==undefined&&block.number!==receipt.blockNumber))throw new Error('卖出回执不属于所核对的规范区块');
  const token=normalized(config.token),pair=normalized(config.pair),usdt=normalized(config.usdt);
  const transfers=parseEventLogs({abi:tokenAbi,eventName:'Transfer',logs:receipt.logs}).filter(e=>[token,usdt].includes(normalized(e.address)));
  const swaps=parseEventLogs({abi:pairAbi,eventName:'Swap',logs:receipt.logs}).filter(e=>normalized(e.address)===pair);
  const position=(event:{logIndex:number|null})=>{
    if(event.logIndex===null||!Number.isSafeInteger(event.logIndex)||event.logIndex<0)throw new Error('卖出日志缺少有效的位置，无法确认成交');
    return event.logIndex;
  };
  const tokenTransfers=transfers.filter(e=>normalized(e.address)===token).sort((a,b)=>position(a)-position(b));
  const usdtTransfers=transfers.filter(e=>normalized(e.address)===usdt).sort((a,b)=>position(a)-position(b));
  swaps.sort((a,b)=>position(a)-position(b));
  type Leg={swap:typeof swaps[number];net:typeof tokenTransfers[number];previousSwap:number};
  const legs:Leg[]=[];
  let previousSwap=-1;
  for(const swap of swaps){
    const index=position(swap);
    if(swap.args.amount1In>0n&&swap.args.amount0Out>0n){
      const inputs=tokenTransfers.filter(e=>position(e)>previousSwap&&position(e)<index&&normalized(e.args.to)===pair&&e.args.value>0n&&![token,pair].includes(normalized(e.args.from)));
      if(inputs.length>1)throw new Error('交易存在多地址或多次代币入池，无法唯一确认实际卖币钱包');
      if(inputs.length===1)legs.push({swap,net:inputs[0]!,previousSwap});
      // Token-owned transfers are its internal fee conversion, not a holder sale.
    }
    previousSwap=index;
  }
  const holderCount=new Set(legs.map(e=>normalized(e.net.args.from))).size;
  return legs.map(leg=>{
  const owner=leg.net.args.from,ownerKey=normalized(owner),netIndex=position(leg.net),swapIndex=position(leg.swap);
  const priorNet=tokenTransfers.filter(e=>position(e)<netIndex&&normalized(e.args.from)===ownerKey&&normalized(e.args.to)===pair&&e.args.value>0n).at(-1);
  const start=priorNet?position(priorNet):-1;
  const outflows=tokenTransfers.filter(e=>position(e)>start&&position(e)<=netIndex&&normalized(e.args.from)===ownerKey);
  const fees=outflows.filter(e=>normalized(e.args.to)===token);
  const other=outflows.some(e=>e.args.value>0n&&![token,pair].includes(normalized(e.args.to)))||tokenTransfers.some(e=>position(e)>netIndex&&position(e)<swapIndex&&normalized(e.args.from)===ownerKey&&e.args.value>0n);
  let soldInput:string|null=null,taxPercent:string|null=null;
  let taxReason='扣费日志存在多组或其他代币转出，无法唯一确认本次卖币数量和实际扣费率。';
  if(fees.length<=1&&!other){
    const fee=fees[0]?.args.value??0n,gross=fee+leg.net.args.value;
    soldInput=gross.toString();
    const scaled=(fee*1_000_000n+gross/2n)/gross;
    taxPercent=`${scaled/10000n}.${(scaled%10000n).toString().padStart(4,'0')}`;
    taxReason='按本次持币钱包转给代币合约的扣费 / 卖出代币计算，包含基础税及利润扣费，四舍五入保留 4 位小数；不含池手续费、滑点或 BNB 成本。';
  }
  const recipient=leg.swap.args.to,recipientKey=normalized(recipient),swapOut=leg.swap.args.amount0Out;
  const pairCredits=usdtTransfers.filter(e=>position(e)>leg.previousSwap&&position(e)<swapIndex&&normalized(e.args.from)===pair&&normalized(e.args.to)===recipientKey&&e.args.value>0n);
  const matchingOutput=pairCredits.length===1&&pairCredits[0]!.args.value===swapOut;
  let receivedUSDT:string|null=null,settlementReason=unknownSettlement;
  if(matchingOutput&&recipientKey===ownerKey){
    receivedUSDT=swapOut.toString();settlementReason='本次池子换出的 USDT 已直接转入持币钱包；不扣除此后钱包自行转出的金额。';
  }else if(matchingOutput&&legs.length===1){
    const credited=usdtTransfers.filter(e=>position(e)>swapIndex&&normalized(e.args.from)===recipientKey&&normalized(e.args.to)===ownerKey).reduce((sum,e)=>sum+e.args.value,0n);
    if(credited>0n&&credited<=swapOut){receivedUSDT=credited.toString();settlementReason='本笔仅一组外部卖出，按代收地址在 Swap 后转给持币钱包的 USDT 实收统计，不把池子输出全部视为到账。';}
  }
  return {source:'market',owner,txSender:tx.from,recipient,txHash:receipt.transactionHash,chainId:config.chainId,timestamp:block.timestamp.toString(),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,
    soldInput,receivedUSDT,swapUSDT:swapOut.toString(),holderCount,logIndex:swapIndex,
    gasWei:(receipt.gasUsed*receipt.effectiveGasPrice).toString(),gasUsed:receipt.gasUsed.toString(),builderFeeWei:null,taxPercent,taxReason,settlementReason};
  });
}

/** Existing latest-sale readers continue selecting the final external sale leg. */
export function parseMarketSale(config:MarketSaleConfig,tx:{from:Address},receipt:MarketSaleReceipt,block:MarketSaleBlock):SaleRecord|null{
  return parseMarketSales(config,tx,receipt,block).at(-1)??null;
}
