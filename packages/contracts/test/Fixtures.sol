// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SellerCore} from "../src/SellerCore.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("LOCAL TEST USDT", "tUSDT") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract MockFactory {
    address public pool;
    function setPair(address p) external { pool = p; }
    function getPair(address, address) external view returns (address) { return pool; }
}
contract MockPair {
    address public token0; address public token1; address public factory;
    uint112 private r0; uint112 private r1; uint32 private time; bool private locked;
    constructor(address u, address t, address f) { token0=u; token1=t; factory=f; }
    function getReserves() external view returns (uint112,uint112,uint32) { return (r0,r1,time); }
    function sync() public { r0=uint112(IERC20(token0).balanceOf(address(this))); r1=uint112(IERC20(token1).balanceOf(address(this))); time=uint32(block.timestamp); }
    function swap(uint256 out0,uint256 out1,address to,bytes calldata data) external {
        require(!locked && data.length==0, "LOCKED"); locked=true;
        require(out0>0 && out1==0 && out0<r0, "OUTPUT");
        IERC20(token0).transfer(to,out0);
        uint256 b0=IERC20(token0).balanceOf(address(this)); uint256 b1=IERC20(token1).balanceOf(address(this));
        uint256 input1=b1-r1;
        require(b0*10000*(b1*10000-input1*25)>=uint256(r0)*r1*1e8,"K");
        sync(); locked=false;
    }
}
contract MockRouter {
    address public factory;
    constructor(address f) { factory=f; }
    function getAmountOut(uint256 input,uint256 rIn,uint256 rOut) external pure returns (uint256) {
        require(input>0 && rIn>0 && rOut>0,"INPUT");
        return input*9975*rOut/(rIn*10000+input*9975);
    }
}
contract MockNBDAO is ERC20 {
    address public basePair; uint256 public feeBps=500; uint256 public rewardPerSale;
    bool public launched; bool public failTransfer; bool public nestedSwap;
    address public reentry; bytes public reentryData;
    mapping(address=>uint256) private rewards;
    constructor() ERC20("LOCAL TEST NBDAO", "tNBDAO") {}
    function setup(address p) external { basePair=p; }
    function mint(address to,uint256 v) external { super._update(address(0),to,v); }
    function setFee(uint256 v) external { require(v<=10000); feeBps=v; }
    function setRewards(uint256 v) external { rewardPerSale=v; }
    function setFail(bool v) external { failTransfer=v; }
    function setNested(bool v) external { nestedSwap=v; }
    function setReentry(address target,bytes calldata data) external { reentry=target; reentryData=data; }
    function pending(address a) public view returns (uint256) { return rewards[a]; }
    function reward(address a) public { uint256 r=rewards[a]; rewards[a]=0; if(r>0) super._update(address(0),a,r); }
    function balanceOf(address a) public view override returns (uint256) { return super.balanceOf(a)+pending(a); }
    function isWL(address) external pure returns (bool) { return false; }
    function sync(bool) external { MockPair(basePair).sync(); }
    function getSellFee() external view returns (uint256,bool,uint256) { (,uint112 r,)=MockPair(basePair).getReserves(); return (feeBps/100,false,r); }
    function userInfo(address) external pure returns (address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) { return (address(0),0,0,0,0,0,0,0,0,0,0,0,0); }
    function _update(address from,address to,uint256 amount) internal override {
        if(from==address(0)) { super._update(from,to,amount); return; }
        reward(from); reward(to);
        require(!failTransfer,"DEPENDENCY_FAILURE");
        if(reentry!=address(0)) { (bool ok,)=reentry.call(reentryData); require(!ok,"REENTRY_SUCCEEDED"); }
        if(to!=basePair && from!=basePair && !launched) { super._update(from,address(0),amount); return; }
        if(to==basePair) {
            (,uint112 reserve,)=MockPair(basePair).getReserves();
            require(amount*100/reserve<=1,"amount K");
            uint256 fee=amount*feeBps/10000;
            if(nestedSwap && fee>0) {
                (uint112 rU,uint112 rT,)=MockPair(basePair).getReserves();
                super._update(from,basePair,fee);
                uint256 out=fee*9975*rU/(uint256(rT)*10000+fee*9975);
                MockPair(basePair).swap(out,0,address(this),"");
            } else if(fee>0) super._update(from,address(0),fee);
            super._update(from,to,amount-fee);
            rewards[from]+=rewardPerSale;
            return;
        }
        super._update(from,to,amount);
    }
}
contract LocalSeller is SellerCore {
    constructor(address t,address u,address p,address r,address f) SellerCore(t,u,p,r,f,block.chainid) {}
}
