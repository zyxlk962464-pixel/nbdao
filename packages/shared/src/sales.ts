import type {Address,Hex} from 'viem';

/** Last confirmed external sell in the NBDAO pool; token amounts use raw 18-decimal units. */
export type SaleRecord={
  owner:Address;txHash:Hex;chainId:number;timestamp:string;blockNumber:string;blockHash:Hex;
  source:'market';txSender:Address;recipient:Address;holderCount:number;logIndex:number;
  soldInput:string|null;receivedUSDT:string|null;swapUSDT:string;gasWei:string;gasUsed:string;
  builderFeeWei:string|null;taxPercent:string|null;taxReason:string;settlementReason:string;
};
export type LatestSale={sale:SaleRecord|null;checkedAt:number;status:'loading'|'ready'|'stale';reason:string;scanBlockNumber:string|null};
