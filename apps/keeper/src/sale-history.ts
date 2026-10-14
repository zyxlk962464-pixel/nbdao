import { createPublicClient, fallback, http, parseAbiItem, type Hex } from 'viem';
import type { LatestSale, SaleRecord } from '../../../packages/shared/src/index.js';
import type { Runtime } from './config.js';
import type { Chain } from './chain.js';
import type { Store } from './store.js';
import { parseMarketSale } from './market-sale.js';

const SWAP=parseAbiItem('event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)');
export const MARKET_READ_RPCS=['https://bsc-rpc.publicnode.com','https://rpc-bnb.blockmachine.io'] as const;
type Client=Pick<Chain['client'],'getChainId'|'getBlock'|'getLogs'|'getTransaction'|'getTransactionReceipt'>;
type Saved={scope:string;recordJSON:string|null;scanBlock:string|null;scanHash:Hex|null;searchBlock:string|null;searchHead:string|null;searchFloor:string|null;updatedAt:number};
type Work={deadline:number;pages:number};
class ScanPause extends Error {}
class ScanBudget extends Error {}
const boundedReason='本轮查询达到时间或批次数上限，后台会继续核对；当前结果尚不能视为全池最新。';

/** One persistent latest-sale cache. Public API reads never start an RPC scan. */
export class SaleHistory {
  private readonly client:Client;private saved:Saved;private record:SaleRecord|null;
  private state:LatestSale['status']='loading';private reason='正在查找全池最近一笔已确认的外部卖出。';
  private running=false;private stopping=false;private timer:ReturnType<typeof setInterval>|undefined;private work:Promise<void>|undefined;
  constructor(public config:Runtime,public chain:Chain,public store:Store,client?:Client){
    this.client=client??(config.app.mode==='local'?chain.client:createPublicClient({transport:fallback(MARKET_READ_RPCS.map(url=>http(url,{timeout:2500,retryCount:0})),{rank:false,retryCount:0})}));
    const scope=`${config.app.chainId}:${config.app.addresses.token.toLowerCase()}:${config.app.addresses.pair.toLowerCase()}`;
    this.saved=this.store.db.prepare('SELECT scope,recordJSON,scanBlock,scanHash,searchBlock,searchHead,searchFloor,updatedAt FROM market_sale WHERE scope=?').get(scope) as Saved??{scope,recordJSON:null,scanBlock:null,scanHash:null,searchBlock:null,searchHead:null,searchFloor:null,updatedAt:0};
    try{
      this.record=this.saved.recordJSON?JSON.parse(this.saved.recordJSON) as SaleRecord:null;
      if(this.record&&(this.record.source!=='market'||this.record.chainId!==config.app.chainId||!/^\d+$/.test(this.record.blockNumber)||!/^0x[0-9a-f]{64}$/i.test(this.record.blockHash)))throw new Error('cache');
    }catch{this.record=null;this.saved={...this.saved,recordJSON:null,scanBlock:null,scanHash:null,searchBlock:null,searchHead:null,searchFloor:null};this.state='stale';this.reason='成交缓存格式无效，后台将重新查找；钱包任务和费用记录不受影响。';}
    if(this.record){this.state='stale';this.reason='已恢复上一笔缓存，正在重新核对规范链和最新成交。';}
  }
  latest():LatestSale{
    const aged=this.record&&Date.now()-this.saved.updatedAt>45000;
    return {sale:this.record?{...this.record}:null,checkedAt:this.saved.updatedAt,status:aged?'stale':this.state,reason:aged?'成交缓存尚未完成近期链上核对，显示的上一笔可能已过时。':this.reason,scanBlockNumber:this.saved.scanBlock};
  }
  status(){return {running:this.running,busy:Boolean(this.work),...this.latest()};}
  start(){if(this.running)return;this.running=true;this.stopping=false;this.timer=setInterval(()=>{void this.tick();},15000);void this.tick();}
  async stop(){this.stopping=true;this.running=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.work;}
  tick():Promise<void>{
    if(this.work)return this.work;if(this.stopping)return Promise.resolve();
    this.work=this.scan().catch(e=>{this.state=this.record?'stale':'loading';this.reason=e instanceof ScanPause?e.message:e instanceof ScanBudget?boundedReason:'链上成交查询暂时失败，保留旧缓存且不推进扫描位置；后台将重试。';}).finally(()=>{this.work=undefined;});
    return this.work;
  }
  private trading(){const recent=Date.now()-120000;return Boolean(this.store.db.prepare("SELECT 1 FROM attempts WHERE state IN ('signed','pending','mined') AND sentAt>=? UNION ALL SELECT 1 FROM opening_attempts WHERE state IN ('signed','pending','mined','unknown') AND sentAt>=? LIMIT 1").get(recent,recent));}
  private guard(work:Work){if(this.stopping)throw new ScanPause('成交查询已停止。');if(this.trading())throw new ScanPause('优先处理钱包卖出交易，成交查询暂时让出读取资源。');if(Date.now()>=work.deadline)throw new ScanBudget();}
  private save(changes:Partial<Saved>,work:Work){
    this.guard(work);const next={...this.saved,...changes,updatedAt:Date.now()};
    this.store.db.prepare('INSERT INTO market_sale(scope,recordJSON,scanBlock,scanHash,searchBlock,searchHead,searchFloor,updatedAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET recordJSON=excluded.recordJSON,scanBlock=excluded.scanBlock,scanHash=excluded.scanHash,searchBlock=excluded.searchBlock,searchHead=excluded.searchHead,searchFloor=excluded.searchFloor,updatedAt=excluded.updatedAt').run(next.scope,next.recordJSON,next.scanBlock,next.scanHash,next.searchBlock,next.searchHead,next.searchFloor,next.updatedAt);
    this.saved=next;this.record=next.recordJSON?JSON.parse(next.recordJSON) as SaleRecord:null;
  }
  private async header(number:bigint,work:Work){this.guard(work);const block=await this.client.getBlock({blockNumber:number});this.guard(work);if(block.number!==number||!block.hash)throw new Error('成交查询区块无效');return block;}
  private async rewind(confirmed:bigint,work:Work,recordInvalid=false){
    const cursor=this.saved.scanBlock?BigInt(this.saved.scanBlock):confirmed;
    const sold=recordInvalid&&this.record?BigInt(this.record.blockNumber):cursor;
    const base=(cursor<sold?cursor:sold)<confirmed?(cursor<sold?cursor:sold):confirmed;
    const rewind=base>50n?base-50n:0n,block=await this.header(rewind,work);
    this.save({recordJSON:recordInvalid?null:this.saved.recordJSON,scanBlock:rewind.toString(),scanHash:block.hash,searchBlock:null,searchHead:null,searchFloor:null},work);
    this.state=this.record?'stale':'loading';this.reason='原成交或扫描区块已发生重组，已回退扫描位置并重新查找。';
  }
  private async range(from:bigint,to:bigint,work:Work):Promise<{sale:SaleRecord|null;hash:Hex}>{
    this.guard(work);if(++work.pages>4)throw new ScanBudget();
    const before=await this.header(to,work);
    const logs=await this.client.getLogs({address:this.config.app.addresses.pair,event:SWAP,fromBlock:from,toBlock:to,strict:true});this.guard(work);
    const sells=logs.filter(log=>log.args.amount1In>0n&&log.args.amount0Out>0n).sort((a,b)=>{
      if(a.blockNumber===null||b.blockNumber===null||a.transactionIndex===null||b.transactionIndex===null||a.logIndex===null||b.logIndex===null)throw new Error('成交日志位置不完整');
      return a.blockNumber===b.blockNumber?b.transactionIndex-a.transactionIndex||b.logIndex-a.logIndex:a.blockNumber>b.blockNumber?-1:1;
    });
    let sale:SaleRecord|null=null;const seen=new Set<string>();
    for(const log of sells){
      this.guard(work);if(!log.transactionHash||log.blockNumber===null||!log.blockHash)throw new Error('成交日志缺少区块或交易');
      if(seen.has(log.transactionHash))continue;seen.add(log.transactionHash);
      const [receipt,tx]=await Promise.all([this.client.getTransactionReceipt({hash:log.transactionHash}),this.client.getTransaction({hash:log.transactionHash})]);this.guard(work);
      if(receipt.transactionHash.toLowerCase()!==log.transactionHash.toLowerCase()||tx.hash.toLowerCase()!==log.transactionHash.toLowerCase()||receipt.blockNumber!==log.blockNumber||receipt.blockHash!==log.blockHash||receipt.blockNumber<from||receipt.blockNumber>to)throw new Error('成交日志与实际回执不一致');
      const block=await this.header(receipt.blockNumber,work);
      const parsed=parseMarketSale({chainId:this.config.app.chainId,...this.config.app.addresses},tx,receipt,block);
      if(parsed){sale=parsed;break;}
    }
    const after=await this.header(to,work);if(after.hash!==before.hash)throw new Error('查询范围已重组');
    return {sale,hash:after.hash!};
  }
  private async scan(){
    const work={deadline:Date.now()+10000,pages:0};this.guard(work);
    const [chainId,head]=await Promise.all([this.client.getChainId(),this.client.getBlock()]);this.guard(work);
    if(chainId!==this.config.app.chainId||head.number===null||!head.hash)throw new Error('成交查询网络错误');
    if(head.number<2n){this.reason='尚无足够的确认区块，继续等待。';return;}
    const confirmed=head.number-2n,confirmedBlock=await this.header(confirmed,work);
    if(this.record){
      const canonical=await this.header(BigInt(this.record.blockNumber),work);
      if(canonical.hash!==this.record.blockHash){await this.rewind(confirmed,work,true);return;}
      if(BigInt(this.record.blockNumber)>confirmed)throw new Error('缓存成交暂不足 3 确认');
    }
    if(this.saved.scanBlock){
      const cursor=BigInt(this.saved.scanBlock);
      if(cursor>confirmed||(await this.header(cursor,work)).hash!==this.saved.scanHash){await this.rewind(confirmed,work);return;}
    }
    if(this.saved.scanBlock===null){
      if(this.saved.searchHead!==null){
        const anchor=await this.header(BigInt(this.saved.searchHead),work);
        if(anchor.hash!==this.saved.scanHash){this.save({recordJSON:null,searchHead:null,searchBlock:null,searchFloor:null,scanHash:null},work);return;}
      }else this.save({searchHead:confirmed.toString(),searchBlock:confirmed.toString(),searchFloor:(confirmed>=499999n?confirmed-499999n:0n).toString(),scanHash:confirmedBlock.hash},work);
      while(this.saved.searchBlock!==null&&work.pages<4){
        const end=BigInt(this.saved.searchBlock),floor=BigInt(this.saved.searchFloor!),from=end-4999n>floor?end-4999n:floor;
        const {sale:found}=await this.range(from,end,work);
        const anchor=await this.header(BigInt(this.saved.searchHead!),work);
        if(anchor.hash!==this.saved.scanHash)throw new Error('回查锚点已重组');
        if(found||from===floor){this.save({recordJSON:found?JSON.stringify(found):null,scanBlock:this.saved.searchHead,scanHash:anchor.hash,searchHead:null,searchBlock:null,searchFloor:null},work);break;}
        this.save({searchBlock:(from-1n).toString()},work);
      }
      if(this.saved.scanBlock===null){this.state='loading';this.reason='正在分批回查最近的真实外部卖出，尚不能判断全池上一笔成交。';return;}
    }
    while(BigInt(this.saved.scanBlock!)<confirmed&&work.pages<4){
      const from=BigInt(this.saved.scanBlock!)+1n,to=from+4999n<confirmed?from+4999n:confirmed;
      const {sale:found,hash}=await this.range(from,to,work);
      this.save({recordJSON:found?JSON.stringify(found):this.saved.recordJSON,scanBlock:to.toString(),scanHash:hash},work);
    }
    const freshAnchor=await this.header(confirmed,work);if(freshAnchor.hash!==confirmedBlock.hash)throw new Error('确认头区块已重组');
    if(BigInt(this.saved.scanBlock!)<confirmed){this.state=this.record?'stale':'loading';this.reason=boundedReason;return;}
    this.save({},work);this.state=this.record?'ready':'loading';this.reason=this.record?'已核对全池至最近的 3 确认区块。':'已检查最近最多 500000 个区块，暂未找到可确认的外部卖出；持续监控新成交，不代表全池没有更早的成交。';
  }
}
