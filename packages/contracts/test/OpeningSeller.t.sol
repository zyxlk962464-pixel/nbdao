// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {OpeningSellerCore} from "../src/OpeningSellerCore.sol";
import {MockNBDAO, MockUSDT, MockPair, MockFactory, MockRouter} from "./Fixtures.sol";

interface OpeningVm {
    function prank(address) external;
    function prank(address, address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function txGasPrice(uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert(bytes4) external;
}

contract OpeningToken is MockNBDAO {
    uint256 public syncCalls;
    bool public failSync;
    function setFailSync(bool value) external { failSync = value; }
    function sync(bool isMining) external override {
        require(!failSync, "SYNC_FAILED");
        require(isMining == (syncCalls % 2 == 0), "SYNC_ORDER");
        syncCalls++;
        // Model a day rollover where only the second call unlocks lower tax.
        if (!isMining) feeBps = 1000;
        MockPair(basePair).sync();
    }
}

contract LocalOpeningSeller is OpeningSellerCore {
    constructor(address t, address u, address p, address r, address f)
        OpeningSellerCore(t, u, p, r, f, block.chainid) {}
}

contract RejectBuilder {
    fallback() external payable { revert("BUILDER_REJECTED"); }
}

contract ReenterOpeningBuilder {
    LocalOpeningSeller public seller;
    bytes32 public id;
    address public owner;
    function configure(LocalOpeningSeller seller_, address owner_, bytes32 id_) external {
        seller = seller_; owner = owner_; id = id_;
    }
    fallback() external payable {
        (bool cancelled,) = address(seller).call(abi.encodeCall(seller.cancelTask, (id)));
        (bool executed,) = address(seller).call(abi.encodeCall(seller.executeOpening, (owner, id, 100 ether, uint64(86412))));
        require(!cancelled && !executed, "CALLBACK_MUTATION_SUCCEEDED");
    }
}

contract OpeningSellerTest {
    OpeningVm constant vm = OpeningVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant owner = address(0x1001);
    address constant keeper = address(0x2002);
    uint64 constant OPEN = 86400;
    uint64 constant CLOSE = 86412;
    uint256 constant TX_GAS = 1_450_000;
    OpeningToken token;
    MockUSDT usdt;
    MockPair pair;
    LocalOpeningSeller seller;
    bytes32 id;

    function setUp() public {
        vm.warp(1000);
        vm.txGasPrice(1 gwei);
        vm.deal(keeper, 1 ether);
        token = new OpeningToken();
        usdt = new MockUSDT();
        MockFactory factory = new MockFactory();
        pair = new MockPair(address(usdt), address(token), address(factory));
        factory.setPair(address(pair));
        token.setup(address(pair));
        MockRouter router = new MockRouter(address(factory));
        seller = new LocalOpeningSeller(address(token), address(usdt), address(pair), address(router), address(factory));
        token.mint(address(pair), 1_000_000 ether);
        usdt.mint(address(pair), 1_000_000 ether);
        pair.sync();
        token.mint(owner, 1000 ether);
        token.setFee(10000);
        vm.prank(owner);
        token.approve(address(seller), 1000 ether);
        id = create(defaultParams());
    }

    function defaultParams() private pure returns (OpeningSellerCore.OpeningTaskParams memory) {
        return OpeningSellerCore.OpeningTaskParams(keeper, OPEN, CLOSE, 1000 ether, 100 ether, 0.003 ether, 0.01 ether, 2 gwei);
    }

    function create(OpeningSellerCore.OpeningTaskParams memory p) private returns (bytes32) {
        vm.prank(owner);
        return seller.createTask(p);
    }

    function replace(OpeningSellerCore.OpeningTaskParams memory p) private {
        vm.prank(owner);
        seller.cancelTask(id);
        id = create(p);
    }

    function execute(uint256 minOut, uint256 bid) private returns (uint256 output, uint256 residual) {
        vm.prank(keeper, keeper);
        return seller.executeOpening{gas: TX_GAS, value: bid}(owner, id, minOut, CLOSE);
    }

    function expectFailure(address caller, uint256 minOut, uint64 deadline, uint256 bid) private {
        vm.prank(caller, caller);
        (bool ok,) = address(seller).call{gas: TX_GAS, value: bid}(abi.encodeCall(seller.executeOpening, (owner, id, minOut, deadline)));
        require(!ok, "EXPECTED_REVERT");
    }

    function testSyncOrderAtomicSaleAndFixedRecipients() public {
        vm.warp(OPEN);
        uint256 beforeBid = seller.BUILDER().balance;
        (uint256 output, uint256 residual) = execute(100 ether, 0.001 ether);
        require(token.syncCalls() == 2 && token.feeBps() == 1000);
        require(output > 890 ether && residual == 0);
        require(usdt.balanceOf(owner) == output && usdt.balanceOf(keeper) == 0);
        require(seller.BUILDER().balance == beforeBid + 0.001 ether);
        require(address(seller).balance == 0 && token.balanceOf(address(seller)) == 0 && usdt.balanceOf(address(seller)) == 0);
        OpeningSellerCore.Task memory task = seller.getTask(id);
        require(task.status == OpeningSellerCore.Status.Completed && task.soldInput == 1000 ether);
        require(task.receivedUSDT == output && task.builderFeePaid == 0.001 ether && seller.activeTaskId(owner) == bytes32(0));
    }

    function testOutputFailureRevertsSyncWalletAllowanceAndBuilderBid() public {
        vm.warp(OPEN);
        uint256 balanceBefore = keeper.balance;
        uint256 builderBefore = seller.BUILDER().balance;
        expectFailure(keeper, 1000 ether, CLOSE, 0.001 ether);
        require(token.syncCalls() == 0 && token.feeBps() == 10000);
        require(token.balanceOf(owner) == 1000 ether && token.allowance(owner, address(seller)) == 1000 ether);
        require(usdt.balanceOf(owner) == 0 && keeper.balance == balanceBefore && seller.BUILDER().balance == builderBefore);
        require(seller.getTask(id).status == OpeningSellerCore.Status.Armed && seller.getTask(id).soldInput == 0);
    }

    function testBuilderPaymentFailureRollsBackSuccessfulSwap() public {
        RejectBuilder rejected = new RejectBuilder();
        vm.etch(seller.BUILDER(), address(rejected).code);
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether, CLOSE, 0.001 ether);
        require(token.balanceOf(owner) == 1000 ether && usdt.balanceOf(owner) == 0 && token.syncCalls() == 0);
        require(seller.activeTaskId(owner) == id && seller.getTask(id).status == OpeningSellerCore.Status.Armed);
    }

    function testBuilderCannotMutateTaskOrExecuteAgain() public {
        ReenterOpeningBuilder template = new ReenterOpeningBuilder();
        vm.etch(seller.BUILDER(), address(template).code);
        ReenterOpeningBuilder(payable(seller.BUILDER())).configure(seller, owner, id);
        vm.warp(OPEN);
        execute(100 ether, 0.001 ether);
        require(seller.getTask(id).soldInput == 1000 ether && token.balanceOf(owner) == 0);
    }

    function testNoBuilderPaymentWhenBidZero() public {
        RejectBuilder rejected = new RejectBuilder();
        vm.etch(seller.BUILDER(), address(rejected).code);
        vm.warp(OPEN);
        execute(100 ether, 0);
        require(seller.getTask(id).status == OpeningSellerCore.Status.Completed);
    }

    function testInsufficientAllowanceCannotPartiallySell() public {
        vm.prank(owner); token.approve(address(seller), 999 ether);
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether, CLOSE, 0.001 ether);
        require(token.balanceOf(owner) == 1000 ether && token.syncCalls() == 0 && usdt.balanceOf(owner) == 0);
    }

    function testInsufficientBalanceCannotPartiallySell() public {
        vm.prank(owner); token.transfer(address(0x999), 1 ether);
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether, CLOSE, 0.001 ether);
        require(token.balanceOf(owner) == 999 ether && usdt.balanceOf(owner) == 0 && token.syncCalls() == 0);
    }

    function testExtraRewardsAreOutsideTheSignedScope() public {
        token.setRewards(1 ether);
        vm.warp(OPEN);
        (uint256 output, uint256 residual) = execute(100 ether, 0);
        require(output > 0 && residual == 1 ether && token.balanceOf(owner) == 1 ether);
        require(seller.getTask(id).status == OpeningSellerCore.Status.Completed && seller.getTask(id).soldInput == 1000 ether);
    }

    function testMinimumCannotBeLoweredByExecutor() public {
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether - 1, CLOSE, 0);
        require(token.syncCalls() == 0 && token.balanceOf(owner) == 1000 ether);
    }

    function testEarlyExactExpiryAndInvalidDeadline() public {
        vm.warp(OPEN - 1); expectFailure(keeper, 100 ether, CLOSE, 0);
        vm.warp(CLOSE); expectFailure(keeper, 100 ether, CLOSE, 0);
        vm.warp(OPEN); expectFailure(keeper, 100 ether, OPEN, 0);
        expectFailure(keeper, 100 ether, CLOSE + 1, 0);
    }

    function testUnauthorizedCannotExecuteOrRedirectOwner() public {
        vm.warp(OPEN);
        expectFailure(address(0x999), 100 ether, CLOSE, 0);
        vm.prank(keeper, keeper);
        (bool ok,) = address(seller).call{gas: TX_GAS}(abi.encodeCall(seller.executeOpening, (keeper, id, 100 ether, CLOSE)));
        require(!ok && token.balanceOf(owner) == 1000 ether);
    }

    function testOwnerCanExecuteDirectly() public {
        vm.warp(OPEN);
        vm.prank(owner, owner);
        seller.executeOpening{gas: TX_GAS}(owner, id, 100 ether, CLOSE);
        require(seller.getTask(id).status == OpeningSellerCore.Status.Completed);
    }

    function testCancellationAndReplayDisableExecution() public {
        vm.prank(owner); seller.cancelTask(id);
        vm.warp(OPEN); expectFailure(keeper, 100 ether, CLOSE, 0);
        vm.warp(1000); id = create(defaultParams());
        vm.warp(OPEN); execute(100 ether, 0);
        expectFailure(keeper, 100 ether, CLOSE, 0);
    }

    function testGasPriceBidAndTotalBudgetCaps() public {
        vm.warp(OPEN);
        vm.txGasPrice(3 gwei); expectFailure(keeper, 100 ether, CLOSE, 0);
        vm.txGasPrice(1 gwei); expectFailure(keeper, 100 ether, CLOSE, 0.003 ether + 1);
        vm.warp(1000);
        OpeningSellerCore.OpeningTaskParams memory p = defaultParams();
        p.maxExecutionCostWei = 0.003 ether;
        replace(p);
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether, CLOSE, 0.002 ether);
        execute(100 ether, 0.0015 ether);
        require(seller.getTask(id).builderFeePaid == 0.0015 ether);
    }

    function testUnboundedGasAndNestedCallsRejected() public {
        vm.warp(OPEN);
        vm.prank(keeper, keeper);
        (bool tooMuch,) = address(seller).call{gas: 1_600_000}(abi.encodeCall(seller.executeOpening, (owner, id, 100 ether, CLOSE)));
        require(!tooMuch);
        vm.prank(keeper, address(0x999));
        (bool nested,) = address(seller).call{gas: TX_GAS}(abi.encodeCall(seller.executeOpening, (owner, id, 100 ether, CLOSE)));
        require(!nested && token.balanceOf(owner) == 1000 ether);
    }

    function testTrailingCalldataCannotEvadeIntrinsicGasBudget() public {
        vm.warp(OPEN);
        vm.prank(keeper, keeper);
        bytes memory withSuffix = bytes.concat(abi.encodeCall(seller.executeOpening, (owner, id, 100 ether, CLOSE)), hex"00");
        (bool ok,) = address(seller).call{gas: TX_GAS}(withSuffix);
        require(!ok && token.syncCalls() == 0);
    }

    function testSyncFailureRollsBackBeforeWalletDebit() public {
        token.setFailSync(true);
        vm.warp(OPEN);
        expectFailure(keeper, 100 ether, CLOSE, 0.001 ether);
        require(token.balanceOf(owner) == 1000 ether && seller.getTask(id).status == OpeningSellerCore.Status.Armed);
    }

    function testWindowMustBeFutureDayBoundaryAndAtMostTwelveSeconds() public {
        vm.prank(owner); seller.cancelTask(id);
        OpeningSellerCore.OpeningTaskParams memory p = defaultParams();
        p.notBefore = OPEN + 1;
        vm.expectRevert(OpeningSellerCore.InvalidConfiguration.selector); create(p);
        p = defaultParams(); p.expiresAt = CLOSE + 1;
        vm.expectRevert(OpeningSellerCore.InvalidConfiguration.selector); create(p);
        p = defaultParams(); vm.warp(OPEN);
        vm.expectRevert(OpeningSellerCore.InvalidConfiguration.selector); create(p);
    }

    function testOneActiveTaskAndNonceChangesAfterCancel() public {
        vm.expectRevert(OpeningSellerCore.TaskAlreadyActive.selector); create(defaultParams());
        bytes32 old = id;
        replace(defaultParams());
        require(id != old && seller.nonces(owner) == 2);
    }

    function testExpiryCanBeFinalizedAndOldTaskCannotTouchNextTask() public {
        vm.warp(CLOSE);
        vm.prank(keeper); seller.finalizeTask(id);
        require(seller.getTask(id).status == OpeningSellerCore.Status.Expired);
        OpeningSellerCore.OpeningTaskParams memory p = defaultParams();
        p.notBefore = OPEN + 1 days; p.expiresAt = CLOSE + 1 days;
        bytes32 old = id; id = create(p);
        vm.warp(OPEN + 1 days);
        bytes32 current = id; id = old;
        expectFailure(keeper, 100 ether, CLOSE + 1 days, 0);
        require(seller.activeTaskId(owner) == current && token.balanceOf(owner) == 1000 ether);
    }

    function testFinalizeAndCancelAuthorization() public {
        vm.prank(keeper);
        vm.expectRevert(OpeningSellerCore.Unauthorized.selector);
        seller.cancelTask(id);
        vm.prank(keeper);
        vm.expectRevert(OpeningSellerCore.OutsideWindow.selector);
        seller.finalizeTask(id);
        vm.warp(CLOSE);
        vm.prank(address(0x999));
        vm.expectRevert(OpeningSellerCore.Unauthorized.selector);
        seller.finalizeTask(id);
    }
}
