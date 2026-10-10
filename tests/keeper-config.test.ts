import { describe,it,expect } from 'vitest';
import { runtime } from '../apps/keeper/src/config.js';
function configured(values:Record<string,string>,action:()=>void){const original={...process.env};Object.assign(process.env,values);try{action();}finally{process.env=original;}}
describe('MVP local configuration isolation',()=>{
  it('uses local RPC for forks even when copied env retains BSC fork URL',()=>configured({SELLER_MODE:'local',RPC_URLS:'http://127.0.0.1:8545',FORK_RPC_URL:'https://bsc-dataseed.bnbchain.org'},()=>{const c=runtime();expect(c.forkRpc).toBe('http://127.0.0.1:8545');expect(c.app.chainId).toBe(31337);}));
  it('rejects remote URLs in local mode',()=>configured({SELLER_MODE:'local',RPC_URLS:'https://bsc-dataseed.bnbchain.org'},()=>expect(()=>runtime()).toThrow('loopback')));
  it('publishes the block-head polling interval without changing trade gates',()=>configured({KEEPER_POLL_MS:'500'},()=>{const c=runtime();expect(c.pollMs).toBe(500);expect(c.app.blockPollMs).toBe(500);}));
  it.each(['0','99','60001','NaN','500.5'])('rejects invalid block-head intervals: %s',value=>configured({KEEPER_POLL_MS:value},()=>expect(()=>runtime()).toThrow('KEEPER_POLL_MS')));
});
