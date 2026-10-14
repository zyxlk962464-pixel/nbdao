import { createPublicClient, fallback, http, parseAbiItem, type Hex } from 'viem';
import type { PreviousDaySales, SaleRecord } from '../../../packages/shared/src/index.js';
import type { Runtime } from './config.js';
import type { Chain } from './chain.js';
import type { Store } from './store.js';
import { parseMarketSales } from './market-sale.js';
import { MARKET_READ_RPCS } from './sale-history.js';

const SWAP=parseAbiItem('event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)');
type Client=Pick<Chain['client'],'getChainId'|'getBlock'|'getLogs'|'getTransaction'|'getTransactionReceipt'>;
type Saved={scope:string;date:string;startTimestamp:string;endTimestamp:string;startBlock:string|null;endBlock:string|null;scanBlock:string|null;scanHash:Hex|null;endHash:Hex|null;boundsJSON:string|null;updatedAt:number};
type Search={low:string;high:string};
type Page={from:string;to:string;hash:Hex;done:string[]};
type Bounds={anchorBlock:string;anchorHash:Hex;start:Search;end:Search;page?:Page};
type Work={deadline:number;pages:number};
class ScanPause extends Error {}
class ScanBudget extends Error {}
class ScanReorg extends Error {}
const digits=(s:unknown):s is string=>typeof s==='string'&&/^\d+$/.test(s);
const hash=(s:unknown):s is Hex=>typeof s==='string'&&/^0x[0-9a-f]{64}$/i.test(s);

/** Confirmed, previous Beijing calendar day. Scanning and API reads never sign transactions. */
export class DailySaleHistory {
  private readonly client:Client;private readonly scope:string;
  private saved:Saved|null=null;private bounds:Bounds|null=null;private records:SaleRecord[]=[];private corrupt=false;
  private state:PreviousDaySales['status']='loading';private reason='正在根据已确认链上时间定位北京时间上一天。';
  private running=false;private stopping=false;private timer:ReturnType<typeof setInterval>|undefined;private work:Promise<void>|undefined;
  constructor(public config:Runtime,public chain:Chain,public store:Store,client?:Client){
    this.client=client??(config.app.mode==='local'?chain.client:createPublicClient({transport:fallback(MARKET_READ_RPCS.map(url=>http(url,{timeout:2500,retryCount:0})),{rank:false,retryCount:0})}));
    this.scope=`${config.app.chainId}:${config.app.addresses.token.toLowerCase()}:${config.app.addresses.pair.toLowerCase()}`;
    const row=this.store.db.prepare('SELECT * FROM market_sale_days WHERE scope=? ORDER BY date DESC LIMIT 1').get(this.scope) as Saved|undefined;
    if(row){this.load(row);this.state='stale';this.reason=`已恢复 ${row.date} 的缓存，正在核对上一天日期、规范链及扫描完整性。`;}
  }
  previousDay():PreviousDaySales{
    const aged=this.state==='ready'&&Date.now()-(this.saved?.updatedAt??0)>45000;
    return {records:this.records.map(record=>({...record})),date:this.saved?.date??'',startTimestamp:this.saved?.startTimestamp??'',endTimestamp:this.saved?.endTimestamp??'',checkedAt:this.saved?.updatedAt??0,status:aged?'stale':this.state,reason:aged?'上一天成交缓存尚未完成近期规范链复核。':this.reason,scanBlockNumber:this.saved?.scanBlock??null};
  }
  status(){return {running:this.running,busy:Boolean(this.work),...this.previousDay()};}
  start(){if(this.running)return;this.running=true;this.stopping=false;this.timer=setInterval(()=>{void this.tick();},15000);void this.tick();}
  async stop(){this.stopping=true;this.running=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.work;}
  tick():Promise<void>{
    if(this.work)return this.work;if(this.stopping)return Promise.resolve();
    this.work=this.scan().catch(error=>{
      this.state=this.complete()?'stale':'loading';
      const date=this.saved?.date?`${this.saved.date} 缓存：`:'';
      this.reason=error instanceof ScanPause?error.message:error instanceof ScanBudget?`${date}本轮达到时间或批次数上限，后台从已核验进度继续；整日记录尚未完成。`:`${date}链上查询暂时失败，保留已核验记录且不跳过扫描区间；后台重试。`;
    }).finally(()=>{this.work=undefined;});return this.work;
  }
  private complete(){return Boolean(this.saved&&digits(this.saved.endBlock)&&digits(this.saved.scanBlock)&&BigInt(this.saved.scanBlock)===BigInt(this.saved.endBlock)-1n);}
  private load(row:Saved){
    this.saved={...row};this.corrupt=false;
    try{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!digits(row.startTimestamp)||!digits(row.endTimestamp)||BigInt(row.endTimestamp)-BigInt(row.startTimestamp)!==86400n)throw new Error('date');
      if([row.startBlock,row.endBlock,row.scanBlock].some(value=>value!==null&&!digits(value))||[row.scanHash,row.endHash].some(value=>value!==null&&!hash(value)))throw new Error('cursor');
      this.bounds=row.boundsJSON?JSON.parse(row.boundsJSON) as Bounds:null;
      if(!this.bounds)throw new Error('missing bounds');
      if(this.bounds&&(!digits(this.bounds.anchorBlock)||!hash(this.bounds.anchorHash)||![this.bounds.start,this.bounds.end].every(search=>digits(search?.low)&&digits(search?.high)&&BigInt(search.low)<=BigInt(search.high))))throw new Error('bounds');
      const page=this.bounds?.page;if(page&&(!digits(page.from)||!digits(page.to)||BigInt(page.from)>BigInt(page.to)||!hash(page.hash)||!Array.isArray(page.done)||page.done.some(value=>!hash(value))))throw new Error('page');
      const data=this.store.db.prepare('SELECT recordJSON FROM market_sale_day_records WHERE scope=? AND date=? ORDER BY length(blockNumber) DESC,blockNumber DESC,logIndex DESC').all(this.scope,row.date) as {recordJSON:string}[];
      this.records=data.map(({recordJSON})=>{const record=JSON.parse(recordJSON) as SaleRecord;if(record.source!=='market'||record.chainId!==this.config.app.chainId||!digits(record.blockNumber)||!hash(record.blockHash)||!digits(record.timestamp)||BigInt(record.timestamp)<BigInt(row.startTimestamp)||BigInt(record.timestamp)>=BigInt(row.endTimestamp))throw new Error('record');return record;});
    }catch{this.corrupt=true;this.bounds=null;this.records=[];this.state='stale';this.reason='上一天公开成交缓存格式无效，后台将重新查询；钱包执行任务不受影响。';}
  }
  private trading(){const recent=Date.now()-120000;return Boolean(this.store.db.prepare("SELECT 1 FROM attempts WHERE state IN ('signed','pending','mined') AND sentAt>=? UNION ALL SELECT 1 FROM opening_attempts WHERE state IN ('signed','pending','mined','unknown') AND sentAt>=? LIMIT 1").get(recent,recent));}
  private guard(work:Work){if(this.stopping)throw new ScanPause('上一天成交查询已停止。');if(this.trading())throw new ScanPause('优先处理钱包卖出交易，上一天成交查询暂时让出读取资源。');if(Date.now()>=work.deadline)throw new ScanBudget();}
  private write(changes:Partial<Saved>,work:Work,records:SaleRecord[]=[],clear=false){
    this.guard(work);if(!this.saved)throw new Error('missing day');
    const next={...this.saved,...changes,updatedAt:Date.now()};
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      if(clear)this.store.db.prepare('DELETE FROM market_sale_day_records WHERE scope=? AND date=?').run(this.scope,next.date);
      const insert=this.store.db.prepare('INSERT INTO market_sale_day_records(scope,date,txHash,logIndex,blockNumber,recordJSON) VALUES(?,?,?,?,?,?) ON CONFLICT(scope,date,txHash,logIndex) DO UPDATE SET blockNumber=excluded.blockNumber,recordJSON=excluded.recordJSON');
      for(const record of records)insert.run(this.scope,next.date,record.txHash.toLowerCase(),record.logIndex,record.blockNumber,JSON.stringify(record));
      this.store.db.prepare('INSERT INTO market_sale_days(scope,date,startTimestamp,endTimestamp,startBlock,endBlock,scanBlock,scanHash,endHash,boundsJSON,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,date) DO UPDATE SET startTimestamp=excluded.startTimestamp,endTimestamp=excluded.endTimestamp,startBlock=excluded.startBlock,endBlock=excluded.endBlock,scanBlock=excluded.scanBlock,scanHash=excluded.scanHash,endHash=excluded.endHash,boundsJSON=excluded.boundsJSON,updatedAt=excluded.updatedAt').run(next.scope,next.date,next.startTimestamp,next.endTimestamp,next.startBlock,next.endBlock,next.scanBlock,next.scanHash,next.endHash,next.boundsJSON,next.updatedAt);
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.load(next);
  }
  private async header(number:bigint,work:Work){this.guard(work);const block=await this.client.getBlock({blockNumber:number});this.guard(work);if(block.number!==number||!block.hash)throw new Error('invalid block');return block;}
  private initialBounds(confirmed:bigint,confirmedHash:Hex):Bounds{return {anchorBlock:confirmed.toString(),anchorHash:confirmedHash,start:{low:'0',high:confirmed.toString()},end:{low:'0',high:confirmed.toString()}};}
  private reset(confirmed:bigint,confirmedHash:Hex,work:Work){
    this.bounds=this.initialBounds(confirmed,confirmedHash);this.write({startBlock:null,endBlock:null,scanBlock:null,scanHash:null,endHash:null,boundsJSON:JSON.stringify(this.bounds)},work,[],true);
    this.state='loading';this.reason='日界或扫描区块发生重组，已清除当天孤块记录并从日界重新查询。';
  }
  private select(date:string,start:bigint,end:bigint,confirmed:bigint,confirmedHash:Hex,work:Work){
    if(this.saved?.date===date){if(this.corrupt)this.reset(confirmed,confirmedHash,work);return;}
    const old=this.store.db.prepare('SELECT * FROM market_sale_days WHERE scope=? AND date=?').get(this.scope,date) as Saved|undefined;
    if(old)this.load(old);else{
      this.saved={scope:this.scope,date,startTimestamp:start.toString(),endTimestamp:end.toString(),startBlock:null,endBlock:null,scanBlock:null,scanHash:null,endHash:null,boundsJSON:null,updatedAt:0};
      this.bounds=this.initialBounds(confirmed,confirmedHash);this.records=[];this.write({boundsJSON:JSON.stringify(this.bounds)},work);
    }
    this.state=this.complete()?'stale':'loading';this.reason=`正在查询北京时间 ${date} 00:00 至次日 00:00 的全部成功卖出。`;
    if(this.corrupt)this.reset(confirmed,confirmedHash,work);
    // Three complete calendar windows, independent of host clock and transaction counts.
    const floor=(start-2n*86400n).toString();
    this.store.db.exec('BEGIN IMMEDIATE');try{this.store.db.prepare('DELETE FROM market_sale_day_records WHERE scope=? AND date IN (SELECT date FROM market_sale_days WHERE scope=? AND CAST(startTimestamp AS INTEGER)<?)').run(this.scope,this.scope,floor);this.store.db.prepare('DELETE FROM market_sale_days WHERE scope=? AND CAST(startTimestamp AS INTEGER)<?').run(this.scope,floor);this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  private async lowerBound(which:'start'|'end',timestamp:bigint,work:Work){
    while(BigInt(this.bounds![which].low)<BigInt(this.bounds![which].high)){
      const search=this.bounds![which],mid=(BigInt(search.low)+BigInt(search.high))/2n,block=await this.header(mid,work);
      const next={...this.bounds!,[which]:block.timestamp<timestamp?{low:(mid+1n).toString(),high:search.high}:{low:search.low,high:mid.toString()}};
      this.write({boundsJSON:JSON.stringify(next)},work);this.bounds=next;
    }
    return BigInt(this.bounds![which].low);
  }
  private async boundary(number:bigint,timestamp:bigint,work:Work){
    const at=await this.header(number,work);if(at.timestamp<timestamp)throw new ScanReorg('boundary moved');
    const before=number>0n?await this.header(number-1n,work):null;
    if(before&&before.timestamp>=timestamp)throw new ScanReorg('boundary moved');return {at,before};
  }
  private async dayAnchor(work:Work){
    const row=this.saved!,last=await this.header(BigInt(row.endBlock!)-1n,work);
    if(last.hash!==row.endHash||last.timestamp>=BigInt(row.endTimestamp))throw new ScanReorg('day changed');
    return last;
  }
  private async page(from:bigint,to:bigint,work:Work){
    this.guard(work);if(++work.pages>4)throw new ScanBudget();
    const before=await this.header(to,work),savedPage=this.bounds!.page;
    if(savedPage&&(BigInt(savedPage.from)!==from||BigInt(savedPage.to)!==to||savedPage.hash!==before.hash))throw new ScanReorg('page changed');
    const logs=await this.client.getLogs({address:this.config.app.addresses.pair,event:SWAP,fromBlock:from,toBlock:to,strict:true});this.guard(work);
    const sells=logs.filter(log=>log.args.amount1In>0n&&log.args.amount0Out>0n);
    const unique=new Map<Hex,typeof sells[number]>();
    for(const log of sells){if(log.removed||!log.transactionHash||!log.blockHash||log.blockNumber===null||log.blockNumber<from||log.blockNumber>to)throw new Error('invalid sale log');unique.set(log.transactionHash.toLowerCase() as Hex,log);}
    const done=new Set(savedPage?.done??[]);
    if([...done].some(txHash=>!unique.has(txHash as Hex)))throw new ScanReorg('page receipts changed');
    if(!savedPage){const next={...this.bounds!,page:{from:from.toString(),to:to.toString(),hash:before.hash!,done:[]}};this.write({boundsJSON:JSON.stringify(next)},work);this.bounds=next;}
    for(const [txHash,log] of unique){
      if(done.has(txHash))continue;this.guard(work);
      const [receipt,tx]=await Promise.all([this.client.getTransactionReceipt({hash:txHash}),this.client.getTransaction({hash:txHash})]);this.guard(work);
      if(receipt.status!=='success'||receipt.transactionHash.toLowerCase()!==txHash.toLowerCase()||tx.hash.toLowerCase()!==txHash.toLowerCase()||receipt.blockNumber!==log.blockNumber||receipt.blockHash!==log.blockHash)throw new Error('inconsistent receipt');
      const block=await this.header(receipt.blockNumber,work);
      const records=parseMarketSales({chainId:this.config.app.chainId,...this.config.app.addresses},tx,receipt,block);
      if(records.some(record=>BigInt(record.timestamp)<BigInt(this.saved!.startTimestamp)||BigInt(record.timestamp)>=BigInt(this.saved!.endTimestamp)))throw new ScanReorg('receipt outside day');
      const after=await this.header(to,work);if(after.hash!==before.hash)throw new ScanReorg('page changed');await this.dayAnchor(work);
      done.add(txHash);const next={...this.bounds!,page:{...this.bounds!.page!,done:[...done]}};
      this.write({boundsJSON:JSON.stringify(next)},work,records);this.bounds=next;
    }
    const after=await this.header(to,work);if(after.hash!==before.hash)throw new ScanReorg('page changed');await this.dayAnchor(work);
    const next={...this.bounds!};delete next.page;this.write({scanBlock:to.toString(),scanHash:after.hash,boundsJSON:JSON.stringify(next)},work);this.bounds=next;
  }
  private async scan(){
    const work={deadline:Date.now()+10000,pages:0};this.guard(work);
    const [chainId,head]=await Promise.all([this.client.getChainId(),this.client.getBlock()]);this.guard(work);
    if(chainId!==this.config.app.chainId||head.number===null||!head.hash)throw new Error('wrong network');
    if(head.number<2n){this.reason='尚无足够确认的链上时间，继续等待。';return;}
    const confirmed=head.number-2n,canonical=await this.header(head.number,work);
    if(canonical.hash!==head.hash||canonical.timestamp!==head.timestamp)throw new Error('head changed');
    const end=((canonical.timestamp+28800n)/86400n)*86400n-28800n,start=end-86400n,date=new Date(Number(start+28800n)*1000).toISOString().slice(0,10);
    this.select(date,start,end,head.number,canonical.hash!,work);
    try{
      if(this.saved!.startBlock===null||this.saved!.endBlock===null){
        if(!this.bounds||BigInt(this.bounds.anchorBlock)>head.number||(await this.header(BigInt(this.bounds.anchorBlock),work)).hash!==this.bounds.anchorHash){this.reset(head.number,canonical.hash!,work);return;}
        const startBlock=await this.lowerBound('start',start,work),endBlock=await this.lowerBound('end',end,work);
        const [startBoundary,endBoundary]=await Promise.all([this.boundary(startBlock,start,work),this.boundary(endBlock,end,work)]);
        if(!endBoundary.before||startBoundary.at.number!>endBoundary.at.number!||(await this.header(BigInt(this.bounds!.anchorBlock),work)).hash!==this.bounds!.anchorHash)throw new ScanReorg('boundary changed');
        this.write({startBlock:startBlock.toString(),endBlock:endBlock.toString(),endHash:endBoundary.before.hash},work);
      }
      await this.dayAnchor(work);
      if((await this.header(BigInt(this.saved!.endBlock!),work)).timestamp<BigInt(this.saved!.endTimestamp))throw new ScanReorg('end boundary moved');
      if(this.saved!.scanBlock!==null){const cursor=BigInt(this.saved!.scanBlock);if(cursor>=BigInt(this.saved!.endBlock!)||(await this.header(cursor,work)).hash!==this.saved!.scanHash)throw new ScanReorg('cursor changed');}
      const first=BigInt(this.saved!.startBlock!),last=BigInt(this.saved!.endBlock!)-1n;
      if(last>confirmed){this.state='loading';this.reason=`北京时间 ${date} 已结束，正在等待日尾区块满足 3 次确认；尚不能把整日记录视为完整。`;return;}
      if(first>last){this.write({scanBlock:last.toString(),scanHash:this.saved!.endHash},work);}
      while(!this.complete()&&work.pages<4){
        const from=this.saved!.scanBlock===null?first:BigInt(this.saved!.scanBlock)+1n;
        const to=this.bounds!.page?BigInt(this.bounds!.page.to):(from+4999n<last?from+4999n:last);
        await this.page(from,to,work);
      }
      if(!this.complete()){this.state='loading';this.reason=`北京时间 ${date} 的全部卖出尚在分批查询，已显示 ${this.records.length} 条已核验记录；未完成整日扫描。`;return;}
      await this.dayAnchor(work);this.write({},work);this.state='ready';this.reason=`已完整核对北京时间 ${date} 00:00 至次日 00:00，记录均为已确认的外部成功卖出；内部手续费兑换已排除。`;
    }catch(error){if(error instanceof ScanReorg){this.reset(head.number,canonical.hash!,work);return;}throw error;}
  }
}
