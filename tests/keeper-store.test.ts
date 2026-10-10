import { describe,it,expect,afterEach } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,type Attempt } from '../apps/keeper/src/store.js';
import { plan,policy } from '../apps/keeper/src/validation.js';
import { chooseBest,netOutput } from '../apps/keeper/src/optimizer.js';
import { UNIT,type Candidate } from '../packages/shared/src/index.js';
const id=`0x${'1'.repeat(64)}` as const,hash=`0x${'2'.repeat(64)}` as const;
const p={slippageBps:100,maxAttempts:10,gasBudgetWei:UNIT.toString(),maxTxGasWei:(UNIT/10n).toString(),minEconomicUSDT:'0',confirmations:3,maxQuoteAgeBlocks:10};
const dirs:string[]=[];const stores:Store[]=[];
function store(){const dir=mkdtempSync(join(tmpdir(),'keeper-test-'));dirs.push(dir);const s=new Store(join(dir,'db.sqlite'));stores.push(s);return s;}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('Keeper persistence and protections',()=>{
  it('freezes the first authenticated policy and recovers after restart',()=>{const s=store();s.register(id,'0xOwner',p);expect(()=>s.register(id,'0xOwner',{...p,slippageBps:200})).toThrow('冻结');const path=dirs[0]!;s.close();stores.splice(stores.indexOf(s),1);const s2=new Store(join(path,'db.sqlite'));stores.push(s2);expect(s2.task(id)?.policy).toEqual(p);});
  it('persists and freezes the signed tax ceiling',()=>{const s=store();s.register(id,'0xOwner',{...p,maxSellFeePercent:5});expect(s.task(id)?.policy.maxSellFeePercent).toBe(5);expect(()=>s.register(id,'0xOwner',{...p,maxSellFeePercent:10})).toThrow('冻结');});
  it('validates tax ceilings without silently modifying legacy policies',()=>{expect(policy(p)).toEqual(p);expect(policy({...p,maxSellFeePercent:0}).maxSellFeePercent).toBe(0);expect(policy({...p,maxSellFeePercent:100}).maxSellFeePercent).toBe(100);for(const value of [-1,101,5.5,'5',null,NaN])expect(()=>policy({...p,maxSellFeePercent:value})).toThrow('税率');});
  it('includes failed receipt gas exactly once and rolls accounting back on reorg',()=>{const s=store();s.register(id,'owner',p);const a:Attempt={hash,taskId:id,nonce:0,raw:'0x01',input:'1',minOut:'1',index:0,sentAt:1,state:'signed',gasWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false};s.insert(a);s.update(hash,{state:'failed',gasWei:'21000',confirmed:true});s.update(hash,{state:'failed',gasWei:'21000',confirmed:true});expect(s.spent(id)).toBe(21000n);s.update(hash,{state:'pending',gasWei:'0',confirmed:false});expect(s.spent(id)).toBe(0n);expect(s.pending()).toHaveLength(1);});
  it('prevents two pending chunks per task and competing account leases',()=>{const s=store();expect(s.acquire('worker','a',1000,100)).toBe(true);expect(s.acquire('worker','b',1000,200)).toBe(false);expect(s.acquire('worker','b',1000,1200)).toBe(true);s.register(id,'owner',p);const a:Attempt={hash,taskId:id,nonce:0,raw:'0x01',input:'1',minOut:'1',index:0,sentAt:1,state:'pending',gasWei:'0',blockNumber:null,blockHash:null,output:'0',confirmed:false};s.insert(a);expect(()=>s.insert({...a,hash:`0x${'3'.repeat(64)}`})).toThrow();});
  it('prices gas in USDT, rejects absent price and prefers complete comparable plans',()=>{expect(netOutput(100n*UNIT,UNIT/100n,600n*UNIT)).toBe(94n*UNIT);expect(()=>netOutput(UNIT,1n,0n)).toThrow();const candidate=(name:string,net:string,complete:boolean):Candidate=>({name,complete,netUSDT:net,chunks:[{input:'1',output:'1',gas:'1',gasWei:'1',minOut:'1',residual:'0'}],output:'1',gasWei:'1',residual:'0'});expect(chooseBest([candidate('partial','200',false),candidate('complete','100',true)])?.name).toBe('complete');});
  it('rejects weak or malformed budgets, windows and asset integers',()=>{expect(()=>policy({...p,slippageBps:3001})).toThrow();expect(()=>policy({...p,gasBudgetWei:'0'})).toThrow();expect(()=>plan({owner:'0x'+ '1'.repeat(40),executor:'0x'+'2'.repeat(40),notBefore:100,expiresAt:90,maxChunks:1,maxTotalInput:'100',minUSDTPerToken:'1',maxDustTokens:'0',maxGasPrice:'1',policy:p})).toThrow();expect(()=>policy({...p,maxTxGasWei:'0.1'})).toThrow();});
  it('rejects a signed per-transaction Gas limit greater than its total budget',()=>{expect(()=>policy({...p,maxTxGasWei:(UNIT+1n).toString()})).toThrow('不得超过');expect(policy({...p,maxTxGasWei:UNIT.toString()}).maxTxGasWei).toBe(UNIT.toString());});
});
