import { createWalletClient,http,keccak256,formatEther,type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtime,ROOT } from '../apps/keeper/src/config.js';
import { Chain } from '../apps/keeper/src/chain.js';
import { artifact } from '../apps/keeper/src/optimizer.js';
import { BSC,stringify } from '../packages/shared/src/index.js';
import { deploymentCost,requireDeploymentBudget,requireNoDeploymentRecord,reserveDeploymentIntent } from './deploy-guard.js';

const config=runtime();
const chain=new Chain({...config,app:{...config.app,mode:'read-only',chainId:56,addresses:BSC}});
const artifactData=artifact('NBDAOSeller.sol','NBDAOSeller');
const bytecode=artifactData.bytecode.object,bytecodeHash=keccak256(bytecode);
const broadcast=process.argv.includes('--broadcast');
const intentPath=resolve(ROOT,'data/deployment-intent.json');
const recordPath=resolve(ROOT,'data/deployment.json');
const receiptPath=resolve(ROOT,'data/deployment-receipt.json');
const recordPaths=[intentPath,recordPath,receiptPath];
if(broadcast)requireNoDeploymentRecord(recordPaths);

async function preflight(account?:Address){
  const block=await chain.client.getBlock();
  if(await chain.client.getChainId()!==56)throw new Error('生产合约仅部署 BSC chainId 56');
  const fingerprint=await chain.fingerprint(block.number!);
  const gasPrice=await chain.client.getGasPrice();
  // Constructor has no arguments, sender-dependent rules or payable value.
  // With no account, omit Gas price in RPC simulation so no funded account is required.
  await chain.client.call({account,data:bytecode,value:0n,blockNumber:block.number!,...(account?{gasPrice}:{})});
  const estimatedGas=await chain.client.estimateGas({account,data:bytecode,value:0n,...(account?{gasPrice}:{})});
  const cost=deploymentCost(estimatedGas,gasPrice);
  return {blockNumber:block.number!,blockHash:block.hash!,fingerprint,cost};
}
const initial=await preflight();
console.log(stringify({broadcast,chainId:56,constructor:'NBDAOSeller()',bytecodeHash,assets:BSC,
  blockNumber:initial.blockNumber,blockHash:initial.blockHash,dependencyFingerprint:initial.fingerprint,
  ...initial.cost,maxFeeBNB:formatEther(initial.cost.maxFeeWei),feeCapBNB:formatEther(initial.cost.capWei),
  assumptions:['默认预检不签名、不广播、不需要真实部署账户。','最高费用按当前 gasPrice 和向上取整的 20% Gas 余量计算；广播前重新核验。']}));
if(!broadcast){console.log(initial.cost.withinCap?'Dry run：constructor call 和 Gas 估算通过；未发送部署交易。':'Dry run：当前最高费用超过固定 0.00015 BNB 上限；广播会被阻止。');process.exit(0);}

const key=process.env.DEPLOYER_PRIVATE_KEY;
if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw new Error('广播需独立部署账户的 DEPLOYER_PRIVATE_KEY；不要使用持币主钱包密钥');
const account=privateKeyToAccount(key as `0x${string}`);
const fresh=await preflight(account.address);
if(fresh.fingerprint!==initial.fingerprint)throw new Error('预检期间依赖变化；停止部署，先重新核验');
const [balance,pendingNonce,latestNonce]=await Promise.all([
  chain.client.getBalance({address:account.address}),
  chain.client.getTransactionCount({address:account.address,blockTag:'pending'}),
  chain.client.getTransactionCount({address:account.address,blockTag:'latest'}),
]);
requireDeploymentBudget(fresh.cost,balance,pendingNonce,latestNonce);
requireNoDeploymentRecord(recordPaths);
const intent={chainId:56,account:account.address,nonce:latestNonce,bytecodeHash,value:'0',
  gas:fresh.cost.gas.toString(),gasPrice:fresh.cost.gasPrice.toString(),maxFeeWei:fresh.cost.maxFeeWei.toString(),feeCapWei:fresh.cost.capWei.toString(),
  blockNumber:fresh.blockNumber.toString(),blockHash:fresh.blockHash,dependencyFingerprint:fresh.fingerprint,createdAt:new Date().toISOString(),stage:'intent',
  note:'签名前已锁定意图。发送状态未知时必须按 hash/账户 nonce 人工核验；不自动清理或重试。'};
// Atomic exclusive file reservation also blocks concurrent processes before either signs.
reserveDeploymentIntent(intentPath,stringify(intent));
const wallet=createWalletClient({account,transport:http(config.rpcUrls[0]!)});
const raw=await wallet.signTransaction({chain:null,chainId:56,data:bytecode,nonce:latestNonce,
  gas:fresh.cost.gas,gasPrice:fresh.cost.gasPrice,value:0n,type:'legacy'});
const hash=keccak256(raw);
writeFileSync(intentPath,stringify({...intent,stage:'signed',hash}),{mode:0o600});
console.log(stringify({account:account.address,nonce:latestNonce,hash,maxFeeBNB:formatEther(fresh.cost.maxFeeWei),intentFile:intentPath}));
try{
  const sentHash=await chain.client.sendRawTransaction({serializedTransaction:raw});
  if(sentHash.toLowerCase()!==hash.toLowerCase())throw new Error('RPC 返回的 hash 与签名交易不一致');
  const receipt=await chain.client.waitForTransactionReceipt({hash,confirmations:3,timeout:180000});
  const actualFeeWei=receipt.gasUsed*receipt.effectiveGasPrice;
  const result={chainId:56,account:account.address,nonce:latestNonce,sellerAddress:receipt.contractAddress,
    deploymentBlock:receipt.blockNumber,hash,blockHash:receipt.blockHash,status:receipt.status,
    gasUsed:receipt.gasUsed,effectiveGasPrice:receipt.effectiveGasPrice,actualFeeWei,actualFeeBNB:formatEther(actualFeeWei),
    maxFeeWei:fresh.cost.maxFeeWei,dependencyFingerprint:fresh.fingerprint,bytecodeHash};
  writeFileSync(receiptPath,stringify(result),{flag:'wx',mode:0o600});
  writeFileSync(intentPath,stringify({...intent,stage:receipt.status==='success'?'confirmed':'reverted',hash}),{mode:0o600});
  if(receipt.status!=='success'||!receipt.contractAddress)throw new Error('部署回滚，已保留实际费用和回执；停止，不自动重新部署');
  writeFileSync(recordPath,stringify(result),{flag:'wx',mode:0o600});
  console.log(stringify(result));
}catch(error){
  console.error(`部署意图保留在 ${intentPath}。不要重跑 --broadcast；先按交易 ${hash} 和账户 nonce 人工核验回执。`);
  throw error;
}
