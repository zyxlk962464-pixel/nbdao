import { spawn } from 'node:child_process';
import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWalletClient,http,parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from '../apps/keeper/src/chain.js';
import { artifact,waitRPC,rpc } from '../apps/keeper/src/optimizer.js';
import { LOCAL_OWNER_KEY,LOCAL_EXECUTOR_KEY,ROOT } from '../apps/keeper/src/config.js';
import { stringify,UNIT } from '../packages/shared/src/index.js';
const url='http://127.0.0.1:8545';const account=privateKeyToAccount(LOCAL_OWNER_KEY),executor=privateKeyToAccount(LOCAL_EXECUTOR_KEY);const c=publicClient(url),w=createWalletClient({account,transport:http(url)});
let processAnvil;
try{const id=await c.getChainId();if(id!==31337)throw new Error('8545 已被非测试网络占用；停止，未写入任何交易。');}catch(e){if(e instanceof Error&&e.message.includes('非测试'))throw e;const bin=resolve(ROOT,'.tools/anvil');if(!existsSync(bin))throw new Error('缺少 .tools/anvil，请运行 node scripts/install-tools.mjs');processAnvil=spawn(bin,['--host','127.0.0.1','--port','8545','--chain-id','31337'],{stdio:'ignore',detached:true});processAnvil.unref();await waitRPC(url,processAnvil);}
if(await c.getChainId()!==31337)throw new Error('仅允许在本地 31337 演练');
async function deploy(name:string,args:unknown[]=[]){const a=artifact('Fixtures.sol',name);const hash=await w.deployContract({chain:null,abi:a.abi,bytecode:a.bytecode.object,args});const receipt=await c.waitForTransactionReceipt({hash});if(!receipt.contractAddress)throw new Error(`${name} 部署失败`);return receipt.contractAddress;}
async function write(address:`0x${string}`,signature:string,args:unknown[]){const hash=await w.writeContract({chain:null,address,abi:parseAbi([signature]),functionName:signature.match(/function (\w+)/)![1]!,args});const receipt=await c.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw new Error('演练准备交易回滚');}
const usdt=await deploy('MockUSDT'),token=await deploy('MockNBDAO'),factory=await deploy('MockFactory'),pair=await deploy('MockPair',[usdt,token,factory]),router=await deploy('MockRouter',[factory]);await write(factory,'function setPair(address)',[pair]);await write(token,'function setup(address)',[pair]);await write(usdt,'function mint(address,uint256)',[pair,100000n*UNIT]);await write(token,'function mint(address,uint256)',[pair,1000000n*UNIT]);await write(pair,'function sync()',[]);await write(token,'function mint(address,uint256)',[account.address,50000n*UNIT]);const sellerAddress=await deploy('LocalSeller',[token,usdt,pair,router,factory]);const b=await c.getBlock();
const data={mode:'local',chainId:31337,rpcUrl:url,owner:account.address,executor:executor.address,sellerAddress,deploymentBlock:b.number,addresses:{token,usdt,pair,router,factory,fund:factory,autoSwap:router,wbnb:usdt},bnbPrice:(600n*UNIT).toString(),testOnly:true};mkdirSync(resolve(ROOT,'data'),{recursive:true});writeFileSync(resolve(ROOT,'data/local.json'),stringify(data));console.log(stringify(data));console.log('本地 Mock 演练已准备。运行 SELLER_MODE=local RPC_URLS=http://127.0.0.1:8545 pnpm dev，再将公开 Anvil 测试账户导入测试钱包；这些私钥绝不能用于真实资产。');
