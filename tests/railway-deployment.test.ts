import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtime,type Runtime } from '../apps/keeper/src/config.ts';
import { assertOwnerAllowed,assertTaskAllowed } from '../apps/keeper/src/access.ts';

const owner='0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const other='0x0000000000000000000000000000000000000099' as const;
const directories:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function live(){
  const values={SELLER_MODE:'live',KEEPER_PRIVATE_KEY:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',SELLER_ADDRESS:other,RPC_URLS:'https://example.com/a,https://example.com/b',DEPLOYMENT_BLOCK:'1',LIVE_EXECUTION:'I_UNDERSTAND',BNB_USDT_ORACLE:other,KEEPER_POLL_MS:'500'};
  for(const [key,value]of Object.entries(values))vi.stubEnv(key,value);
  for(const key of ['ALLOWED_OWNER_ADDRESS','RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_VOLUME_MOUNT_PATH','EXECUTION_HANDOFF'])vi.stubEnv(key,undefined);
}
describe('cloud execution and owner restrictions: no network or funded key',()=>{
  it('defaults live execution to the executor wallet and denies a different owner',()=>{
    live();const config=runtime();expect(config.allowedOwner?.toLowerCase()).toBe(owner.toLowerCase());expect(()=>assertOwnerAllowed(config,owner)).not.toThrow();expect(()=>assertOwnerAllowed(config,other)).toThrow('持币钱包');
  });
  it('permits an explicitly configured owner but never a different executor',()=>{
    live();vi.stubEnv('ALLOWED_OWNER_ADDRESS',other);const config=runtime();expect(()=>assertTaskAllowed(config,{owner:other,params:{executor:owner}})).not.toThrow();expect(()=>assertTaskAllowed(config,{owner:other,params:{executor:other}})).toThrow('执行者');
  });
  it('fails closed if a live caller bypasses runtime without an owner restriction',()=>{
    expect(()=>assertOwnerAllowed({app:{mode:'live'}} as Runtime,owner)).toThrow('持币钱包');
  });
  it('requires a volume, final import and local-stop acknowledgment before Railway can execute',()=>{
    live();const directory=mkdtempSync(join(tmpdir(),'railway-gates-'));directories.push(directory);
    vi.stubEnv('RAILWAY_ENVIRONMENT_ID','test');vi.stubEnv('KEEPER_DATABASE',join(directory,'keeper.sqlite'));
    let config=runtime();expect(config.app.ready).toBe(false);expect(config.app.missing.join(' ')).toContain('持久卷');
    vi.stubEnv('RAILWAY_VOLUME_MOUNT_PATH',directory);vi.stubEnv('EXECUTION_HANDOFF','LOCAL_KEEPER_STOPPED');
    writeFileSync(join(directory,'keeper.sqlite.import.json'),JSON.stringify({cutoverReady:false}));expect(runtime().app.ready).toBe(false);
    writeFileSync(join(directory,'keeper.sqlite.import.json'),JSON.stringify({cutoverReady:true}));expect(runtime().app.ready).toBe(true);
    vi.stubEnv('KEEPER_DATABASE',join(directory,'../outside.sqlite'));expect(runtime().app.ready).toBe(false);
  });
});
