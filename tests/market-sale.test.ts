import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { BSC, pairAbi, tokenAbi } from '../packages/shared/src/index.js';
import { parseMarketSale, type MarketSaleReceipt } from '../apps/keeper/src/market-sale.js';

const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const owner=address(1),other=address(2),helper=address(3),sender=address(4),autoSwap=address(5);
const config={chainId:56,token:BSC.token,pair:BSC.pair,usdt:BSC.usdt};
const block={number:100n,hash:hash(100),timestamp:1791849600n};
type Log=MarketSaleReceipt['logs'][number];
function log(index:number,address:Address,topics:ReturnType<typeof encodeEventTopics>,data:Hex):Log{return {address,topics:topics as Hex[],data,blockNumber:block.number,blockHash:block.hash,transactionHash:hash(1),transactionIndex:0,logIndex:index,removed:false} as Log;}
function transfer(index:number,from:Address,to:Address,value:bigint,token:Address=BSC.token){return log(index,token,encodeEventTopics({abi:tokenAbi,eventName:'Transfer',args:{from,to}}),encodeAbiParameters([{type:'uint256'}],[value]));}
function swap(index:number,to:Address,amountIn=75n,amountOut=70n,pair:Address=BSC.pair){return log(index,pair,encodeEventTopics({abi:pairAbi,eventName:'Swap',args:{sender:helper,to}}),encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'} as const)),[0n,amountIn,amountOut,0n]));}
function receipt(logs:Log[]):MarketSaleReceipt{return {status:'success',transactionHash:hash(1),blockNumber:block.number,blockHash:block.hash,gasUsed:21000n,effectiveGasPrice:2n,logs};}
function parse(logs:Log[]){return parseMarketSale(config,{from:sender},receipt(logs),block);}
const direct=()=>[transfer(1,owner,BSC.token,25n),transfer(2,owner,BSC.pair,75n),transfer(3,BSC.pair,owner,70n,BSC.usdt),swap(4,owner)];
describe('market sale receipt parser',()=>{
  it('uses the holder, receipt Gas, gross wallet outflow and direct USDT receipt',()=>{
    expect(parse(direct())).toMatchObject({source:'market',owner,txSender:sender,recipient:owner,soldInput:'100',swapUSDT:'70',receivedUSDT:'70',taxPercent:'25.0000',holderCount:1,logIndex:4,gasWei:'42000',gasUsed:'21000',builderFeeWei:null,timestamp:'1791849600',blockNumber:'100'});
  });
  it('excludes internal fee swaps and does not use their pool input as user gross',()=>{
    const logs=[transfer(1,owner,BSC.token,25n),transfer(2,BSC.token,BSC.pair,24n),transfer(3,BSC.pair,autoSwap,22n,BSC.usdt),swap(4,autoSwap,24n,22n),transfer(5,owner,BSC.pair,75n),transfer(6,BSC.pair,owner,70n,BSC.usdt),swap(7,owner,90n,70n)];
    expect(parse(logs)).toMatchObject({soldInput:'100',taxPercent:'25.0000',receivedUSDT:'70',holderCount:1,logIndex:7});
    expect(parse(logs.slice(0,4))).toBeNull();
  });
  it('returns no sale for a donation with no Swap, a buy or a Swap from another pair',()=>{
    expect(parse([transfer(1,owner,BSC.pair,100n)])).toBeNull();
    const buy=log(2,BSC.pair,encodeEventTopics({abi:pairAbi,eventName:'Swap',args:{sender:helper,to:owner}}),encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'} as const)),[70n,0n,0n,100n]));
    expect(parse([transfer(1,BSC.pair,owner,100n),buy])).toBeNull();expect(parse([transfer(1,owner,BSC.pair,100n),swap(2,owner,100n,70n,other)])).toBeNull();
  });
  it('allows a fee-free direct transfer and separates reward inflows from gross',()=>{
    expect(parse([transfer(0,BSC.token,owner,50n),transfer(1,owner,BSC.pair,100n),transfer(2,BSC.pair,owner,70n,BSC.usdt),swap(3,owner,100n)])).toMatchObject({soldInput:'100',taxPercent:'0.0000'});
    expect(parse([transfer(0,BSC.token,owner,50n),...direct()])).toMatchObject({soldInput:'100',taxPercent:'25.0000'});
  });
  it('keeps a visible trade with unknown gross/tax for multiple fees or abnormal outflows',()=>{
    const base=direct();
    for(const extra of [transfer(0,owner,BSC.token,5n),transfer(0,owner,other,5n)])expect(parse([extra,...base])).toMatchObject({owner,soldInput:null,taxPercent:null,receivedUSDT:'70'});
  });
  it('throws on multiple external inputs instead of calling an older sale the latest',()=>{
    expect(()=>parse([...direct(),transfer(5,owner,BSC.pair,10n),transfer(6,other,BSC.pair,20n),transfer(7,BSC.pair,helper,15n,BSC.usdt),swap(8,helper,30n,15n)])).toThrow('无法唯一');
  });
  it('uses the last actual sale leg and resets fee matching after this holder previous net transfer',()=>{
    const logs=[...direct(),transfer(5,owner,BSC.token,40n),transfer(6,owner,BSC.pair,60n),transfer(7,BSC.pair,owner,50n,BSC.usdt),swap(8,owner,60n,50n),transfer(9,BSC.token,BSC.pair,1n),swap(10,autoSwap,1n,1n)];
    expect(parse(logs)).toMatchObject({owner,soldInput:'100',taxPercent:'40.0000',receivedUSDT:'50',holderCount:1,logIndex:8});
  });
  it('counts unique holders and does not assign multi-leg helper settlements to the last holder',()=>{
    const logs=[transfer(1,owner,BSC.token,10n),transfer(2,owner,BSC.pair,90n),transfer(3,BSC.pair,helper,80n,BSC.usdt),swap(4,helper,90n,80n),transfer(5,other,BSC.token,40n),transfer(6,other,BSC.pair,60n),transfer(7,BSC.pair,helper,50n,BSC.usdt),swap(8,helper,60n,50n),transfer(9,helper,other,50n,BSC.usdt)];
    expect(parse(logs)).toMatchObject({owner:other,recipient:helper,soldInput:'100',taxPercent:'40.0000',receivedUSDT:null,swapUSDT:'50',holderCount:2,logIndex:8});
  });
  it('accepts actual helper credits for one leg without counting token-team credits or subsequent spending',()=>{
    const logs=[transfer(0,BSC.token,owner,5n,BSC.usdt),transfer(1,owner,BSC.token,40n),transfer(2,owner,BSC.pair,60n),transfer(3,BSC.pair,helper,50n,BSC.usdt),swap(4,helper,60n,50n),transfer(5,helper,owner,20n,BSC.usdt),transfer(6,helper,owner,10n,BSC.usdt),transfer(7,owner,sender,25n,BSC.usdt)];
    expect(parse(logs)).toMatchObject({receivedUSDT:'30',swapUSDT:'50'});
    expect(parse(logs.slice(0,5))).toMatchObject({receivedUSDT:null,swapUSDT:'50'});
    expect(parse([...logs,transfer(8,helper,owner,25n,BSC.usdt)])).toMatchObject({receivedUSDT:null});
  });
  it('requires matching pair output credits even when the Swap recipient is the holder',()=>{
    expect(parse(direct().filter(e=>e.logIndex!==3))).toMatchObject({receivedUSDT:null,swapUSDT:'70'});
    expect(parse([transfer(1,owner,BSC.pair,100n),transfer(2,BSC.pair,owner,69n,BSC.usdt),swap(3,owner,100n,70n)])).toMatchObject({receivedUSDT:null});
  });
  it('rejects reverted/orphaned receipts and missing log positions',()=>{
    expect(parseMarketSale(config,{from:sender},{...receipt(direct()),status:'reverted'},block)).toBeNull();
    expect(()=>parseMarketSale(config,{from:sender},receipt(direct()),{...block,hash:hash(999)})).toThrow('规范区块');
    expect(()=>parseMarketSale(config,{from:sender},receipt(direct()),{...block,number:101n})).toThrow('规范区块');
    expect(()=>parse([...direct().slice(0,3),{...swap(4,owner),logIndex:null} as unknown as Log])).toThrow('位置');
  });
  it('rounds receipt-derived tax without turning one-wei base-fee truncation into a different displayed rate',()=>{
    const gross=16654339666422868129822n,fee=13323471733138294503857n;
    const logs=[transfer(1,owner,BSC.token,fee),transfer(2,owner,BSC.pair,gross-fee),transfer(3,BSC.pair,owner,729432697308780956940n,BSC.usdt),swap(4,owner,gross-fee,729432697308780956940n)];
    expect(parse(logs)).toMatchObject({soldInput:gross.toString(),taxPercent:'80.0000'});
  });
  it('preserves the observed combined deduction from the verified opening-block final holder',()=>{
    const gross=15721990116923849220247n,fee=6628133287448509760910n,net=9093856829475339459337n;
    const logs=[transfer(1,owner,BSC.token,fee),transfer(2,BSC.token,BSC.pair,6403045938143477254146n),swap(3,autoSwap,6403045938143477254146n,1432000396415970292555n),transfer(4,owner,BSC.pair,net),transfer(5,BSC.pair,helper,2022748056547102693112n,BSC.usdt),swap(6,helper,net,2022748056547102693112n)];
    expect(parse(logs)).toMatchObject({soldInput:gross.toString(),taxPercent:'42.1584',swapUSDT:'2022748056547102693112',receivedUSDT:null});
  });
});
