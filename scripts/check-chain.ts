import { createPublicClient, http, keccak256 } from 'viem';
import { BSC, tokenAbi, pairAbi, routerAbi, factoryAbi, IMPLEMENTATION_SLOT, stringify, UNIT } from '../packages/shared/src/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const rpc=process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org';
const c=createPublicClient({transport:http(rpc,{timeout:20000,retryCount:1})});
const block=await c.getBlock();
const blockNumber=block.number;
const [chain,token0,token1,factory,pair,decimals,uDecimals,sellFee,launched,impl,quotation,codes]=await Promise.all([
  c.getChainId(), c.readContract({address:BSC.pair,abi:pairAbi,functionName:'token0',blockNumber}),
  c.readContract({address:BSC.pair,abi:pairAbi,functionName:'token1',blockNumber}),
  c.readContract({address:BSC.router,abi:routerAbi,functionName:'factory',blockNumber}),
  c.readContract({address:BSC.factory,abi:factoryAbi,functionName:'getPair',args:[BSC.token,BSC.usdt],blockNumber}),
  c.readContract({address:BSC.token,abi:tokenAbi,functionName:'decimals',blockNumber}),
  c.readContract({address:BSC.usdt,abi:tokenAbi,functionName:'decimals',blockNumber}),
  c.readContract({address:BSC.token,abi:tokenAbi,functionName:'getSellFee',blockNumber}),
  c.readContract({address:BSC.token,abi:tokenAbi,functionName:'launched',blockNumber}),
  c.getStorageAt({address:BSC.fund,slot:IMPLEMENTATION_SLOT,blockNumber}),
  Promise.all([1n,10n,100n].map(n=>c.readContract({address:BSC.router,abi:routerAbi,functionName:'getAmountOut',args:[n*UNIT,1000n*UNIT,1000n*UNIT],blockNumber}))),
  Promise.all(Object.entries(BSC).map(async([key,address])=>({key,address,hash:keccak256(await c.getCode({address,blockNumber})??'0x')}))),
]);
const valid=chain===56&&token0.toLowerCase()===BSC.usdt&&token1.toLowerCase()===BSC.token&&factory.toLowerCase()===BSC.factory&&pair.toLowerCase()===BSC.pair&&decimals===18&&uDecimals===18;
const out={valid,blockNumber,blockHash:block.hash,timestamp:block.timestamp,chain,token0,token1,factory,pair,decimals,uDecimals,sellFee,launched,implementation:impl,quotation,codes};
mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/chain-check.json',stringify(out));
console.log(stringify(out));if(!valid)process.exitCode=1;
