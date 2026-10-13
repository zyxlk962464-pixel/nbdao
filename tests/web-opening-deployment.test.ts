import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {keccak256} from 'viem';
import {OPENING_DEPLOY_CAP,OPENING_DEPLOY_HASH,assertOpeningDeploymentPlan,openingDeploymentCost,type OpeningDeploymentPlan} from '../apps/web/src/lib/opening-deployment.ts';
const owner='0x0000000000000000000000000000000000000011';
const artifact=JSON.parse(readFileSync('packages/contracts/out/NBDAOOpeningSeller.sol/NBDAOOpeningSeller.json','utf8'));
describe('opening deployment wallet handoff',()=>{
  it('pins the independent mainnet artifact and fixed empty constructor',()=>{
    expect(keccak256(artifact.bytecode.object)).toBe(OPENING_DEPLOY_HASH);
    expect(artifact.abi.find((item:{type:string})=>item.type==='constructor').inputs).toEqual([]);
  });
  it('includes the gas margin and rejects fee cap or insufficient balance',()=>{
    expect(openingDeploymentCost(101n,2n,1000n)).toEqual({gasLimit:122n,maxFee:244n});
    expect(()=>openingDeploymentCost(1500000n,1000000000n,10n**18n)).toThrow('超过');
    expect(()=>openingDeploymentCost(101n,2n,243n)).toThrow('余额不足');
    expect(()=>openingDeploymentCost(0n,2n,1000n)).toThrow('无效');
  });
  it('rejects changed sender/code, invalid nonce and inconsistent wallet fee fields',()=>{
    const plan:OpeningDeploymentPlan={owner,bytecode:artifact.bytecode.object,bytecodeHash:OPENING_DEPLOY_HASH,nonce:7,gasLimit:'100',gasPriceWei:'2',maxFeeWei:'200',checkedAt:1,walletRpcUrl:'https://bsc-dataseed.bnbchain.org'};
    expect(()=>assertOpeningDeploymentPlan(plan,owner)).not.toThrow();
    for(const patch of [{owner:'0x0000000000000000000000000000000000000022'},{bytecode:'0x00'},{nonce:-1},{gasLimit:'101'},{gasPriceWei:'0'},{gasLimit:OPENING_DEPLOY_CAP.toString(),gasPriceWei:'2',maxFeeWei:(2n*OPENING_DEPLOY_CAP).toString()}])expect(()=>assertOpeningDeploymentPlan({...plan,...patch} as OpeningDeploymentPlan,owner)).toThrow('不匹配');
  });
});
