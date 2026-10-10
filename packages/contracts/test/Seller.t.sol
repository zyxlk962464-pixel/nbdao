// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SellerCore} from "../src/SellerCore.sol";
import {MockNBDAO,MockUSDT,MockPair,MockFactory,MockRouter,LocalSeller} from "./Fixtures.sol";
interface Vm { function prank(address) external; function warp(uint256) external; function txGasPrice(uint256) external; }
contract SellerTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockNBDAO t; MockUSDT u; MockPair p; LocalSeller seller;
    address user=address(0x1001); address keeper=address(0x2002); bytes32 id;
    function setUp() public {
        vm.warp(1000); t=new MockNBDAO(); u=new MockUSDT(); MockFactory f=new MockFactory();
        p=new MockPair(address(u),address(t),address(f)); f.setPair(address(p)); t.setup(address(p));
        MockRouter r=new MockRouter(address(f)); seller=new LocalSeller(address(t),address(u),address(p),address(r),address(f));
        t.mint(address(p),1_000_000 ether); u.mint(address(p),1_000_000 ether); p.sync(); t.mint(user,1000 ether);
        vm.prank(user); t.approve(address(seller),2000 ether);
        id=create(2000 ether,1e16,0,20);
    }
    function create(uint256 cap,uint256 floor,uint256 dust,uint32 chunks) internal returns(bytes32 result) {
        SellerCore.TaskParams memory a=SellerCore.TaskParams(keeper,1000,2000,chunks,cap,floor,dust,100 gwei);
        vm.prank(user); return seller.createTask(a);
    }
    function sell(uint256 amount,uint256 outMin) internal returns(uint256 out,uint256 rem) {
        SellerCore.Task memory task=seller.getTask(id); vm.prank(keeper);
        return seller.executeChunk(user,id,task.nextChunkIndex,amount,outMin,1999);
    }
    function failed(address caller,uint256 amount,uint256 minOut,uint32 index,uint64 until) internal {
        vm.prank(caller); (bool ok,)=address(seller).call(abi.encodeCall(seller.executeChunk,(user,id,index,amount,minOut,until))); require(!ok,"expected revert");
    }
    function testAtomicFullSaleAndFixedRecipient() public {
        (uint256 out,uint256 rem)=sell(1000 ether,10 ether);
        require(out>900 ether && rem==0); require(u.balanceOf(user)==out && u.balanceOf(keeper)==0);
        require(t.balanceOf(address(seller))==0 && u.balanceOf(address(seller))==0);
        require(seller.getTask(id).status==SellerCore.Status.Completed);
    }
    function testOrdinaryTransferBurnsButSaleDoesNot() public {
        vm.prank(user); t.transfer(address(0x999),10 ether); require(t.balanceOf(address(0x999))==0);
        (uint256 out,)=sell(990 ether,10 ether); require(out>0);
    }
    function testOutputFloorRevertsAllAccountingAndAllowance() public {
        uint256 a=t.allowance(user,address(seller)); failed(keeper,100 ether,1000 ether,0,1999);
        require(t.balanceOf(user)==1000 ether && t.allowance(user,address(seller))==a);
        SellerCore.Task memory task=seller.getTask(id); require(task.soldInput==0 && task.nextChunkIndex==0);
    }
    function testCannotLowerOwnerFloor() public { failed(keeper,100 ether,1,0,1999); }
    function testUnauthorized() public { failed(address(0x123),100 ether,1 ether,0,1999); }
    function testOwnerCanExecute() public { vm.prank(user); seller.executeChunk(user,id,0,100 ether,1 ether,1999); }
    function testStaleChunkAndReplay() public { sell(100 ether,1 ether); failed(keeper,100 ether,1 ether,0,1999); }
    function testCannotChangeOwner() public {
        vm.prank(keeper); (bool ok,)=address(seller).call(abi.encodeCall(seller.executeChunk,(address(0x123),id,0,100 ether,1 ether,1999))); require(!ok);
    }
    function testEarlyAndExactExpiry() public { vm.warp(999); failed(keeper,100 ether,1 ether,0,1999); vm.warp(2000); failed(keeper,100 ether,1 ether,0,2000); }
    function testQuoteDeadlineCannotExceedTask() public { failed(keeper,100 ether,1 ether,0,2001); }
    function testQuoteDeadlineIsExclusive() public { vm.warp(1500); failed(keeper,100 ether,1 ether,0,1500); }
    function testCancelPermanentlyDisablesExecution() public { vm.prank(user); seller.cancelTask(id); failed(keeper,100 ether,1 ether,0,1999); }
    function testStopCannotBeMisreportedAsCompletion() public { vm.prank(keeper); seller.stopTask(id); require(seller.getTask(id).status==SellerCore.Status.StoppedWithRemaining); }
    function testCannotFinalizeLargeRemainder() public { vm.prank(keeper); (bool ok,)=address(seller).call(abi.encodeCall(seller.finalizeTask,(id))); require(!ok); }
    function testExpiryCanBeFinalized() public { vm.warp(2000); vm.prank(keeper); seller.finalizeTask(id); require(seller.getTask(id).status==SellerCore.Status.Expired); }
    function testOneActiveTaskAndNewNonceAfterCancel() public {
        SellerCore.TaskParams memory a=seller.getTask(id).params; vm.prank(user); (bool ok,)=address(seller).call(abi.encodeCall(seller.createTask,(a))); require(!ok);
        bytes32 old=id; vm.prank(user); seller.cancelTask(id); id=create(2000 ether,1e16,0,20); require(old!=id);
    }
    function testNewTaskAfterExpiry() public { vm.warp(2000); SellerCore.TaskParams memory a=seller.getTask(id).params; a.expiresAt=3000; vm.prank(user); bytes32 next=seller.createTask(a); require(next!=id); }
    function testInputCapStopsWithRemainder() public { vm.prank(user); seller.cancelTask(id); id=create(100 ether,1e16,0,20); sell(100 ether,1 ether); require(seller.getTask(id).status==SellerCore.Status.StoppedWithRemaining); }
    function testMaxChunksStopsWithRemainder() public { vm.prank(user); seller.cancelTask(id); id=create(2000 ether,1e16,0,1); sell(100 ether,1 ether); require(seller.getTask(id).status==SellerCore.Status.StoppedWithRemaining); }
    function testChunkAmountCannotExceedCumulativeCap() public { failed(keeper,2001 ether,21 ether,0,1999); }
    function testAllowanceInsufficientRollsBack() public { vm.prank(user); t.approve(address(seller),1 ether); failed(keeper,100 ether,1 ether,0,1999); require(seller.getTask(id).soldInput==0); }
    function testDependencyFailureRollsBack() public { t.setFail(true); failed(keeper,100 ether,1 ether,0,1999); require(t.balanceOf(user)==1000 ether); }
    function testZeroNetInputReverts() public { t.setFee(10000); failed(keeper,100 ether,1 ether,0,1999); }
    function testNestedFeeSwapUsesUpdatedReserves() public { t.setNested(true); (uint256 out,)=sell(100 ether,1 ether); require(out>90 ether && out<95 ether); }
    function testNewRewardsDoNotFalselyComplete() public { t.setRewards(1 ether); sell(1000 ether,10 ether); require(t.balanceOf(user)==1 ether); require(seller.getTask(id).status==SellerCore.Status.Running); }
    function testApprovedDustCompletion() public { vm.prank(user); seller.cancelTask(id); id=create(2000 ether,1e16,1 ether,20); t.setRewards(1 ether); sell(1000 ether,10 ether); require(seller.getTask(id).status==SellerCore.Status.CompletedWithDust); }
    function testReentryIntoTaskMutationIsBlocked() public { t.setReentry(address(seller),abi.encodeCall(seller.stopTask,(id))); sell(100 ether,1 ether); require(seller.getTask(id).status==SellerCore.Status.Running); }
    function testUnexplainedPoolSurplusReverts() public { t.mint(address(p),1000 ether); failed(keeper,100 ether,1 ether,0,1999); }
    function testGasPriceCap() public { vm.txGasPrice(101 gwei); failed(keeper,100 ether,1 ether,0,1999); }
    function testLaterFailureKeepsEarlierSuccessfulChunk() public { (uint256 out,)=sell(100 ether,1 ether); failed(keeper,100 ether,1000 ether,1,1999); require(u.balanceOf(user)==out && seller.getTask(id).soldInput==100 ether); }
    function testHardFloorRoundsUp() public { require(seller.hardMinimum(id,1)==1); }
    function testFuzz_AccountingAndFloor(uint64 raw) public {
        uint256 amount=uint256(raw)%99 ether+1 ether; uint256 floor=seller.hardMinimum(id,amount);
        (uint256 out,)=sell(amount,floor); SellerCore.Task memory task=seller.getTask(id);
        require(out>=floor && task.soldInput==amount && task.soldInput<=task.params.maxTotalInput);
        require(task.receivedUSDT==u.balanceOf(user) && task.nextChunkIndex==1);
    }
}
