// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {INBDAO, IV2Pair, IV2Router, IV2Factory} from "./SellerCore.sol";

interface IOpeningNBDAO is INBDAO {
    function sync(bool isMining) external;
}

/// @notice One dated, atomic sale. Assets stay in the owner's wallet until execution.
/// @dev The existing SellerCore and its deployed tasks are independent of this contract.
abstract contract OpeningSellerCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Armed, Completed, Cancelled, Expired }
    struct OpeningTaskParams {
        address executor;
        uint64 notBefore;
        uint64 expiresAt;
        uint256 maxTotalInput;
        uint256 minTotalUSDT;
        uint256 maxBuilderFeeWei;
        uint256 maxExecutionCostWei;
        uint256 maxGasPrice;
    }
    struct Task {
        address owner;
        OpeningTaskParams params;
        Status status;
        uint256 soldInput;
        uint256 receivedUSDT;
        uint256 builderFeePaid;
    }

    // The published 48 Club builder collection address. Neither caller nor owner
    // can substitute a recipient, forwarding target, or refund address.
    address payable public constant BUILDER = payable(address(bytes20(hex"4848489f0b2bedd788c696e2d79b6b69d7484848")));
    uint256 public constant EXECUTION_GAS_CEILING = 1_500_000;
    uint64 public constant MAX_WINDOW_SECONDS = 12;
    // Covers intrinsic calldata gas (<=23,112) and function dispatch/entry guard.
    // Fixed calldata length and an EOA caller bound the full transaction's gas,
    // not just the gas consumed inside the swap body.
    uint256 private constant ENTRY_GAS_RESERVE = 40_000;

    IOpeningNBDAO public immutable token;
    IERC20 public immutable usdt;
    IV2Pair public immutable pair;
    IV2Router public immutable router;
    address public immutable factory;
    uint256 public immutable deploymentChainId;
    mapping(bytes32 => Task) private tasks;
    mapping(address => bytes32) public activeTaskId;
    mapping(address => uint256) public nonces;

    error InvalidConfiguration();
    error InvalidTask();
    error TaskAlreadyActive();
    error Unauthorized();
    error OutsideWindow();
    error GasPriceTooHigh();
    error TransactionGasTooHigh();
    error DirectTransactionRequired();
    error BuilderFeeTooHigh();
    error ExecutionBudgetExceeded();
    error BelowFloor();
    error InvalidPoolInput();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error BuilderPaymentFailed();

    event TaskCreated(bytes32 indexed taskId, address indexed owner, address indexed executor);
    event OpeningExecuted(bytes32 indexed taskId, address indexed owner, uint256 grossInput, uint256 poolInput, uint256 usdtReceived, uint256 builderFeePaid, uint256 residual);
    event TaskClosed(bytes32 indexed taskId, Status status, uint256 residual);

    constructor(address token_, address usdt_, address pair_, address router_, address factory_, uint256 chainId_) {
        if (block.chainid != chainId_ || token_.code.length == 0 || usdt_.code.length == 0 ||
            pair_.code.length == 0 || router_.code.length == 0 || factory_.code.length == 0) revert InvalidConfiguration();
        token = IOpeningNBDAO(token_); usdt = IERC20(usdt_); pair = IV2Pair(pair_); router = IV2Router(router_); factory = factory_;
        if (pair.token0() != usdt_ || pair.token1() != token_ || pair.factory() != factory_ ||
            router.factory() != factory_ || IV2Factory(factory_).getPair(token_, usdt_) != pair_ || token.basePair() != pair_ ||
            token.decimals() != 18 || IERC20Metadata(usdt_).decimals() != 18) revert InvalidConfiguration();
        deploymentChainId = chainId_;
    }

    /// @dev notBefore is an exact UTC day boundary, i.e. Beijing 08:00.
    /// maxExecutionCostWei must be the remaining budget after setup transactions.
    function createTask(OpeningTaskParams calldata p) external nonReentrant returns (bytes32 id) {
        if (p.executor == address(0) || p.notBefore <= block.timestamp || p.notBefore % 1 days != 0 ||
            p.expiresAt <= p.notBefore || p.expiresAt - p.notBefore > MAX_WINDOW_SECONDS ||
            p.maxTotalInput == 0 || p.minTotalUSDT == 0 || p.maxGasPrice == 0 || p.maxExecutionCostWei == 0 ||
            p.maxBuilderFeeWei > p.maxExecutionCostWei || block.chainid != deploymentChainId) revert InvalidConfiguration();
        bytes32 oldId = activeTaskId[msg.sender];
        if (oldId != bytes32(0)) {
            Task storage old = tasks[oldId];
            if (block.timestamp < old.params.expiresAt) revert TaskAlreadyActive();
            _close(oldId, old, Status.Expired, token.balanceOf(msg.sender));
        }
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, ++nonces[msg.sender]));
        Task storage t = tasks[id];
        t.owner = msg.sender; t.params = p; t.status = Status.Armed;
        activeTaskId[msg.sender] = id;
        emit TaskCreated(id, msg.sender, p.executor);
    }

    function getTask(bytes32 id) external view returns (Task memory) { return tasks[id]; }

    /// @notice Sync the token twice, sell the exact approved scope, then pay the builder.
    /// @dev A failure, including a rejected builder payment, reverts the whole sale.
    /// Gas is still payable on a reverted transaction; the off-chain sender must
    /// also count any previous attempts/setup gas against the user's total budget.
    function executeOpening(address owner, bytes32 id, uint256 requestedMinOut, uint64 validUntil)
        external payable nonReentrant returns (uint256 output, uint256 residual)
    {
        if (msg.sender != tx.origin || msg.data.length != 132) revert DirectTransactionRequired();
        if (gasleft() > EXECUTION_GAS_CEILING - ENTRY_GAS_RESERVE) revert TransactionGasTooHigh();
        Task storage t = _active(id);
        if (t.owner != owner || (msg.sender != owner && msg.sender != t.params.executor)) revert Unauthorized();
        if (block.timestamp < t.params.notBefore || block.timestamp >= t.params.expiresAt ||
            block.timestamp >= validUntil || validUntil > t.params.expiresAt || block.chainid != deploymentChainId) revert OutsideWindow();
        if (tx.gasprice > t.params.maxGasPrice) revert GasPriceTooHigh();
        if (msg.value > t.params.maxBuilderFeeWei) revert BuilderFeeTooHigh();
        if (msg.value + tx.gasprice * EXECUTION_GAS_CEILING > t.params.maxExecutionCostWei) revert ExecutionBudgetExceeded();
        if (requestedMinOut < t.params.minTotalUSDT) revert BelowFloor();

        // Mark single use before token, pair, and builder callbacks. Reverts restore it.
        t.status = Status.Completed;
        token.sync(true);
        token.sync(false);
        if (token.pending(address(pair)) != 0) revert InvalidPoolInput();
        uint256 amountIn = t.params.maxTotalInput;
        IERC20(address(token)).safeTransferFrom(owner, address(pair), amountIn);
        (uint112 reserveU, uint112 reserveT,) = pair.getReserves();
        uint256 balance = token.balanceOf(address(pair));
        if (token.pending(address(pair)) != 0 || balance <= reserveT) revert InvalidPoolInput();
        uint256 actualInput = balance - reserveT;
        if (actualInput > amountIn) revert InvalidPoolInput();
        uint256 amountOut = router.getAmountOut(actualInput, reserveT, reserveU);
        uint256 beforeUSDT = usdt.balanceOf(owner);
        pair.swap(amountOut, 0, owner, new bytes(0));
        output = usdt.balanceOf(owner) - beforeUSDT;
        if (output < requestedMinOut) revert InsufficientOutput(output, requestedMinOut);
        t.soldInput = amountIn;
        t.receivedUSDT = output;
        t.builderFeePaid = msg.value;
        residual = token.balanceOf(owner);
        delete activeTaskId[owner];
        if (msg.value != 0) {
            (bool paid,) = BUILDER.call{value: msg.value}("");
            if (!paid) revert BuilderPaymentFailed();
        }
        emit OpeningExecuted(id, owner, amountIn, actualInput, output, msg.value, residual);
        emit TaskClosed(id, Status.Completed, residual);
    }

    function cancelTask(bytes32 id) external nonReentrant {
        Task storage t = _active(id);
        if (msg.sender != t.owner) revert Unauthorized();
        _close(id, t, Status.Cancelled, token.balanceOf(t.owner));
    }

    function finalizeTask(bytes32 id) external nonReentrant {
        Task storage t = _active(id);
        if (msg.sender != t.owner && msg.sender != t.params.executor) revert Unauthorized();
        if (block.timestamp < t.params.expiresAt) revert OutsideWindow();
        _close(id, t, Status.Expired, token.balanceOf(t.owner));
    }

    function _active(bytes32 id) private view returns (Task storage t) {
        t = tasks[id];
        if (t.status != Status.Armed || activeTaskId[t.owner] != id) revert InvalidTask();
    }

    function _close(bytes32 id, Task storage t, Status status, uint256 residual) private {
        t.status = status;
        delete activeTaskId[t.owner];
        emit TaskClosed(id, status, residual);
    }
}
