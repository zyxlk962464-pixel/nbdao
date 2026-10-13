import { NextRequest,NextResponse } from 'next/server';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPublicClient,http,isAddress,keccak256,type Address,type Hex} from 'viem';
import {BSC,executorAbi,openingExecutorAbi} from '@nbdao/shared';
import {beginApiRequest} from '@/lib/api-security';
import {normalizedRuntime} from '@/lib/deployment';
import {OPENING_DEPLOY_HASH,openingDeploymentCost} from '@/lib/opening-deployment';

export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
  const release=beginApiRequest(request);if(release instanceof Response)return release;
  try{
    const rawOwner=request.nextUrl.searchParams.get('owner');if(!rawOwner||!isAddress(rawOwner))throw new Error('请先连接 BSC 钱包');
    const owner=rawOwner as Address,allowed=process.env.ALLOWED_OWNER_ADDRESS;
    if(allowed&&owner.toLowerCase()!==allowed.toLowerCase())return NextResponse.json({error:'此环境只允许指定持币钱包部署'},{status:403});
    const rpc=process.env.NEXT_PUBLIC_BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org';
    const c=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0})});
    if(await c.getChainId()!==56)throw new Error('部署仅允许 BSC 主网');
    const a=JSON.parse(readFileSync(resolve(process.cwd(),'../../packages/contracts/out/NBDAOOpeningSeller.sol/NBDAOOpeningSeller.json'),'utf8'));
    const bytecode=a.bytecode.object as Hex;if(keccak256(bytecode)!==OPENING_DEPLOY_HASH)throw new Error('新版编译产物与已核对版本不符');
    const hash=request.nextUrl.searchParams.get('hash');
    if(hash){
      if(!/^0x[\da-fA-F]{64}$/.test(hash))throw new Error('交易 hash 无效');
      const tx=await c.getTransaction({hash:hash as Hex});
      if(tx.from.toLowerCase()!==owner.toLowerCase()||tx.to!==null||tx.value!==0n||tx.chainId!==56||keccak256(tx.input)!==OPENING_DEPLOY_HASH)throw new Error('交易与指定钱包和固定部署代码不匹配');
      const receipt=await c.getTransactionReceipt({hash:hash as Hex});
      const head=await c.getBlockNumber(),canonical=await c.getBlock({blockNumber:receipt.blockNumber});
      if(head-receipt.blockNumber+1n<3n||canonical.hash!==receipt.blockHash)return NextResponse.json({state:'pending',hash,reason:'等待三个区块确认'});
      const feeWei=(receipt.gasUsed*receipt.effectiveGasPrice).toString();
      if(receipt.status!=='success'||!receipt.contractAddress)return NextResponse.json({state:'reverted',hash,feeWei,reason:'部署回滚，Gas 已消耗；不会自动重试'});
      const code=await c.getCode({address:receipt.contractAddress});
      if(!code||normalizedRuntime(code,a.deployedBytecode.immutableReferences)!==normalizedRuntime(a.deployedBytecode.object,a.deployedBytecode.immutableReferences))throw new Error('部署运行代码不匹配');
      for(const [fn,expected] of Object.entries({...BSC,builder:'0x4848489f0b2bedd788c696e2d79b6b69d7484848'}).filter(([fn])=>['token','usdt','pair','router','factory','builder'].includes(fn))){
        const actual=await c.readContract({address:receipt.contractAddress,abi:openingExecutorAbi,functionName:(fn==='builder'?'BUILDER':fn) as 'token'});
        if(actual.toLowerCase()!==expected.toLowerCase())throw new Error('新版合约资产绑定不符');
      }
      return NextResponse.json({state:'confirmed',hash,contractAddress:receipt.contractAddress,blockNumber:receipt.blockNumber.toString(),feeWei,reason:'新版执行合约部署并核对成功；待配置云端地址'});
    }
    if(process.env.OPENING_SELLER_ADDRESS)return NextResponse.json({error:'新版合约已配置，无需重复部署'},{status:403});
    if(process.env.SELLER_ADDRESS&&isAddress(process.env.SELLER_ADDRESS)){
      const id=await c.readContract({address:process.env.SELLER_ADDRESS,abi:executorAbi,functionName:'activeTaskId',args:[owner]});
      if(BigInt(id)!==0n){const task=await c.readContract({address:process.env.SELLER_ADDRESS,abi:executorAbi,functionName:'getTask',args:[id]});const b=await c.getBlock();if(task.status<=2&&task.params.expiresAt>b.timestamp)throw new Error('请先取消旧监控任务，避免部署时同钱包出现并发签名');}
    }
    const [gasPrice,balance,nonce,pendingNonce]=await Promise.all([c.getGasPrice(),c.getBalance({address:owner}),c.getTransactionCount({address:owner,blockTag:'latest'}),c.getTransactionCount({address:owner,blockTag:'pending'})]);
    if(nonce!==pendingNonce)throw new Error('钱包已有未确认交易，请先核对');
    const estimated=await c.estimateGas({account:owner,data:bytecode,value:0n,gasPrice});
    const {gasLimit,maxFee}=openingDeploymentCost(estimated,gasPrice,balance);
    return NextResponse.json({owner,bytecode,bytecodeHash:OPENING_DEPLOY_HASH,nonce,gasLimit:gasLimit.toString(),gasPriceWei:gasPrice.toString(),maxFeeWei:maxFee.toString(),checkedAt:Date.now(),walletRpcUrl:rpc},{headers:{'Cache-Control':'no-store'}});
  }catch(error){const e=error as {name?:string;message?:string};
    if(e.name==='TransactionReceiptNotFoundError'||e.name==='TransactionNotFoundError')return NextResponse.json({state:'pending',hash:request.nextUrl.searchParams.get('hash'),reason:'等待交易回执；不会重新提交'});
    return NextResponse.json({error:/https?:|Request body|Details:/i.test(e.message??'')?'RPC 只读核查失败，请稍后重试':e.message||'只读部署核查失败'},{status:422});
  }finally{release();}
}
