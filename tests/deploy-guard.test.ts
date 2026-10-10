import { afterEach,describe,it,expect } from 'vitest';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENT_FEE_CAP_WEI,deploymentCost,requireDeploymentBudget,requireNoDeploymentRecord,reserveDeploymentIntent } from '../scripts/deploy-guard.js';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe('fixed deployment cost guard: no keys or RPC',()=>{
  it('rounds 20% gas reserve up and caps highest BNB expenditure',()=>{const cost=deploymentCost(1_643_809n,50_000_000n);expect(cost.gas).toBe(1_972_571n);expect(cost.maxFeeWei).toBe(98_628_550_000_000n);expect(cost.withinCap).toBe(true);expect(DEPLOYMENT_FEE_CAP_WEI).toBe(150_000_000_000_000n);expect(()=>deploymentCost(0n,1n)).toThrow();});
  it('blocks fee excess, insufficient balance, or a pending nonce before signing',()=>{const normal=deploymentCost(100n,1n);expect(()=>requireDeploymentBudget(normal,120n,1,1)).not.toThrow();expect(()=>requireDeploymentBudget(normal,119n,1,1)).toThrow('不足');expect(()=>requireDeploymentBudget(normal,1000n,2,1)).toThrow('未确认');const costly=deploymentCost(2_000_000n,100_000_000n);expect(()=>requireDeploymentBudget(costly,10n**18n,1,1)).toThrow('0.00015');});
  it('atomically reserves intent and does not clear it on failed or unknown send',()=>{const dir=mkdtempSync(join(tmpdir(),'deploy-guard-'));dirs.push(dir);const path=join(dir,'intent.json');reserveDeploymentIntent(path,'{"stage":"intent"}');expect(()=>reserveDeploymentIntent(path,'{}')).toThrow('已有部署意图');expect(readFileSync(path,'utf8')).toBe('{"stage":"intent"}');expect(()=>requireNoDeploymentRecord([join(dir,'deployment.json'),path])).toThrow('禁止再次广播');});
});
