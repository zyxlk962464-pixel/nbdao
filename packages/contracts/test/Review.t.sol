// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SellerCore} from "../src/SellerCore.sol";
import {MockNBDAO, MockUSDT, MockPair, MockFactory, MockRouter, LocalSeller} from "./Fixtures.sol";

interface ReviewVm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

/// The callback is an authorized keeper, rather than the unauthorised token itself.
/// It disables recursive callbacks before attempting the second sale, so an
/// out-of-gas recursion cannot masquerade as a successful reentrancy defence.
contract ReenteringKeeper {
    MockNBDAO private immutable token;
    LocalSeller private immutable seller;
    address private immutable owner;
    bytes32 private taskId;

    constructor(MockNBDAO token_, LocalSeller seller_, address owner_) {
        token = token_;
        seller = seller_;
        owner = owner_;
    }
    function configure(bytes32 id) external { taskId = id; }
    function execute() external {
        seller.executeChunk(owner, taskId, 0, 100 ether, 1 ether, 1999);
    }
    function callback() external {
        require(msg.sender == address(token));
        token.setReentry(address(0), "");
        (bool ok,) = address(seller).call(abi.encodeCall(
            seller.executeChunk, (owner, taskId, 0, 100 ether, 1 ether, uint64(1999))
        ));
        // MockNBDAO expects its callback to fail. Removing the sale guard makes
        // this succeed, so the mock rejects the outer sale and the test fails.
        require(ok, "INNER_EXECUTION_BLOCKED");
    }
}

contract SellerReviewTest {
    ReviewVm constant vm = ReviewVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant user = address(0x1001);
    address private constant keeper = address(0x2002);
    MockNBDAO private token;
    MockUSDT private usdt;
    MockPair private pair;
    MockRouter private router;
    LocalSeller private seller;
    bytes32 private id;

    function setUp() public {
        vm.warp(1000);
        token = new MockNBDAO();
        usdt = new MockUSDT();
        MockFactory factory = new MockFactory();
        pair = new MockPair(address(usdt), address(token), address(factory));
        factory.setPair(address(pair));
        token.setup(address(pair));
        router = new MockRouter(address(factory));
        seller = new LocalSeller(address(token), address(usdt), address(pair), address(router), address(factory));
        token.mint(address(pair), 1_000_000 ether);
        usdt.mint(address(pair), 1_000_000 ether);
        pair.sync();
        token.mint(user, 1000 ether);
        vm.prank(user);
        token.approve(address(seller), 2000 ether);
        id = create(keeper);
    }

    function create(address executor) private returns (bytes32) {
        SellerCore.TaskParams memory params = SellerCore.TaskParams(executor, 1000, 2000, 20, 2000 ether, 1e16, 0, 100 gwei);
        vm.prank(user);
        return seller.createTask(params);
    }

    function testAuthorizedKeeperCannotReenterDuringTokenTransfer() public {
        vm.prank(user);
        seller.cancelTask(id);
        ReenteringKeeper attacker = new ReenteringKeeper(token, seller, user);
        id = create(address(attacker));
        attacker.configure(id);
        token.setReentry(address(attacker), abi.encodeCall(attacker.callback, ()));
        attacker.execute();
        SellerCore.Task memory task = seller.getTask(id);
        require(task.soldInput == 100 ether && task.nextChunkIndex == 1, "REENTRANT_SECOND_SALE");
        require(token.balanceOf(user) == 900 ether);
        require(task.status == SellerCore.Status.Running && seller.activeTaskId(user) == id);
    }

    function testAlreadyAccruedPendingRewardsCanBeSoldInTailChunk() public {
        token.setRewards(3 ether);
        vm.prank(keeper);
        seller.executeChunk(user, id, 0, 100 ether, 1 ether, 1999);
        require(token.pending(user) == 3 ether && token.balanceOf(user) == 903 ether);
        token.setRewards(0);
        vm.prank(keeper);
        seller.executeChunk(user, id, 1, 903 ether, 10 ether, 1999);
        SellerCore.Task memory task = seller.getTask(id);
        require(token.balanceOf(user) == 0 && token.pending(user) == 0);
        require(task.soldInput == 1003 ether && task.status == SellerCore.Status.Completed);
    }

    function testRewardBearingPoolIsRejectedBeforeAnyWalletDebit() public {
        token.setRewards(1 ether);
        vm.prank(address(pair));
        token.transfer(address(pair), 1 ether);
        require(token.pending(address(pair)) == 1 ether);
        vm.expectRevert(SellerCore.InvalidPoolInput.selector);
        vm.prank(keeper);
        seller.executeChunk(user, id, 0, 100 ether, 1 ether, 1999);
        require(token.balanceOf(user) == 1000 ether && token.allowance(user, address(seller)) == 2000 ether);
        require(seller.getTask(id).soldInput == 0 && usdt.balanceOf(user) == 0);
    }

    function testCancelledTaskCannotTouchNewTaskWithSameKeeperAndChunkIndex() public {
        bytes32 oldId = id;
        vm.prank(user);
        seller.cancelTask(oldId);
        id = create(keeper);
        vm.expectRevert(SellerCore.InvalidTask.selector);
        vm.prank(keeper);
        seller.executeChunk(user, oldId, 0, 100 ether, 1 ether, 1999);
        require(seller.activeTaskId(user) == id && seller.getTask(id).soldInput == 0);
        require(token.balanceOf(user) == 1000 ether);
    }

    /// poolInput is the AMM balance delta, not a proof of the seller's exclusive
    /// contribution. A small existing surplus can be consumed by a V2 swap.
    /// Gross accounting must still reflect only the amount debited from owner.
    function testSmallPoolSurplusIncreasesOutputWithoutIncreasingGrossDebit() public {
        uint256 noSurplusOutput = router.getAmountOut(95 ether, 1_000_000 ether, 1_000_000 ether);
        token.mint(address(pair), 4 ether);
        vm.prank(keeper);
        (uint256 output,) = seller.executeChunk(user, id, 0, 100 ether, 1 ether, 1999);
        require(output == router.getAmountOut(99 ether, 1_000_000 ether, 1_000_000 ether));
        require(output > noSurplusOutput && usdt.balanceOf(user) == output);
        require(seller.getTask(id).soldInput == 100 ether && token.balanceOf(user) == 900 ether);
        require(usdt.balanceOf(keeper) == 0 && usdt.balanceOf(address(seller)) == 0);
    }
}
