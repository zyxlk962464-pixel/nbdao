import type { Hex } from 'viem';

/** The private transaction is sent only to this verified builder, never to public RPCs. */
export const BUILDER_URL = 'https://puissant-builder.48.club';
export type BundleRequest = { raw:Hex; maxBlockNumber:number; maxTimestamp:number };
export class BuilderClient {
  constructor(private request:typeof fetch=fetch){}
  async send({raw,maxBlockNumber,maxTimestamp}:BundleRequest):Promise<string>{
    if(!/^0x[0-9a-f]+$/i.test(raw)||!Number.isSafeInteger(maxBlockNumber)||maxBlockNumber<=0||!Number.isSafeInteger(maxTimestamp)||maxTimestamp<=0)throw new Error('私有交易包参数无效');
    try{
      const response=await this.request(BUILDER_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(1800),
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendBundle',params:[{txs:[raw],maxBlockNumber,maxTimestamp,noMerge:true,positionFirst:true}]})});
      if(!response.ok)throw new Error('http');
      const data=await response.json() as {result?:unknown;error?:unknown};
      // Builder responses can contain the signed transaction: do not expose arbitrary messages.
      if(data.error||typeof data.result!=='string'||!/^0x[0-9a-f]{64}$/i.test(data.result))throw new Error('response');
      return data.result.toLowerCase();
    }catch{throw new Error('私有构建者暂未接收交易包；不会转为公开广播');}
  }
}
