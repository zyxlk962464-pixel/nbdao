// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface INBDAO is IERC20Metadata {
    function pending(address) external view returns (uint256);
    function basePair() external view returns (address);
}
interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}
interface IV2Router {
    function factory() external view returns (address);
    function getAmountOut(uint256, uint256, uint256) external view returns (uint256);
}
interface IV2Factory { function getPair(address, address) external view returns (address); }

/// @notice No custody, upgrades, arbitrary calls or fees. One atomic swap per chunk.
abstract contract SellerCore is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Status { None, Armed, Running, Completed, CompletedWithDust, Cancelled, Expired, StoppedWithRemaining }
    enum StopReason { None, User, Executor, InputCap, ChunkCap, Deadline }
    struct TaskParams {
        address executor;
        uint64 notBefore;
        uint64 expiresAt;
        uint32 maxChunks;
        uint256 maxTotalInput;
        uint256 minUSDTPerToken;
        uint256 maxDustTokens;
        uint256 maxGasPrice;
    }
    struct Task {
        address owner;
        TaskParams params;
        Status status;
        uint32 nextChunkIndex;
        uint256 soldInput;
        uint256 receivedUSDT;
    }
    INBDAO public immutable token;
    IERC20 public immutable usdt;
    IV2Pair public immutable pair;
    IV2Router public immutable router;
    address public immutable factory;
    uint256 public immutable tokenUnit;
    uint256 public immutable deploymentChainId;
    mapping(bytes32 => Task) private tasks;
    mapping(address => bytes32) public activeTaskId;
    mapping(address => uint256) public nonces;

    error InvalidConfiguration();
    error InvalidTask();
    error TaskAlreadyActive();
    error Unauthorized();
    error OutsideWindow();
    error StaleChunk();
    error InputLimit();
    error BelowFloor();
    error InvalidPoolInput();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error ResidualTooLarge(uint256 residual);
    error GasPriceTooHigh();
    event TaskCreated(bytes32 indexed taskId, address indexed owner, address indexed executor);
    event ChunkExecuted(bytes32 indexed taskId, address indexed owner, uint32 chunkIndex, uint256 grossInput, uint256 poolInput, uint256 usdtReceived, uint256 residual);
    event TaskClosed(bytes32 indexed taskId, Status status, StopReason reason, uint256 residual);

    constructor(address token_, address usdt_, address pair_, address router_, address factory_, uint256 chainId_) {
        if (block.chainid != chainId_ || token_.code.length == 0 || usdt_.code.length == 0 ||
            pair_.code.length == 0 || router_.code.length == 0 || factory_.code.length == 0) revert InvalidConfiguration();
        token = INBDAO(token_); usdt = IERC20(usdt_); pair = IV2Pair(pair_); router = IV2Router(router_); factory = factory_;
        if (pair.token0() != usdt_ || pair.token1() != token_ || pair.factory() != factory_ ||
            router.factory() != factory_ || IV2Factory(factory_).getPair(token_, usdt_) != pair_ || token.basePair() != pair_ ||
            token.decimals() != 18 || IERC20Metadata(usdt_).decimals() != 18) revert InvalidConfiguration();
        tokenUnit = 1e18;
        deploymentChainId = chainId_;
    }

    function createTask(TaskParams calldata p) external nonReentrant returns (bytes32 id) {
        if (p.executor == address(0) || p.expiresAt <= block.timestamp || p.expiresAt <= p.notBefore ||
            p.maxTotalInput == 0 || p.minUSDTPerToken == 0 || p.maxDustTokens >= p.maxTotalInput ||
            p.maxChunks == 0 || p.maxChunks > 256 || p.maxGasPrice == 0 || block.chainid != deploymentChainId) revert InvalidConfiguration();
        bytes32 oldId = activeTaskId[msg.sender];
        if (oldId != bytes32(0)) {
            Task storage old = tasks[oldId];
            if (block.timestamp < old.params.expiresAt) revert TaskAlreadyActive();
            _close(oldId, old, Status.Expired, StopReason.Deadline, token.balanceOf(msg.sender));
        }
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, ++nonces[msg.sender]));
        Task storage t = tasks[id];
        t.owner = msg.sender; t.params = p; t.status = Status.Armed;
        activeTaskId[msg.sender] = id;
        emit TaskCreated(id, msg.sender, p.executor);
    }

    function getTask(bytes32 id) external view returns (Task memory) { return tasks[id]; }
    function hardMinimum(bytes32 id, uint256 input) public view returns (uint256) {
        return Math.mulDiv(input, tasks[id].params.minUSDTPerToken, tokenUnit, Math.Rounding.Ceil);
    }
    function executeChunk(address owner, bytes32 id, uint32 expectedIndex, uint256 amountIn, uint256 requestedMinOut, uint64 validUntil)
        external nonReentrant returns (uint256 output, uint256 residual)
    {
        Task storage t = _active(id);
        if (t.owner != owner || (msg.sender != owner && msg.sender != t.params.executor)) revert Unauthorized();
        if (block.timestamp < t.params.notBefore || block.timestamp >= t.params.expiresAt ||
            block.timestamp >= validUntil || validUntil > t.params.expiresAt || block.chainid != deploymentChainId) revert OutsideWindow();
        if (tx.gasprice > t.params.maxGasPrice) revert GasPriceTooHigh();
        if (expectedIndex != t.nextChunkIndex) revert StaleChunk();
        if (amountIn == 0 || amountIn > t.params.maxTotalInput - t.soldInput || t.nextChunkIndex >= t.params.maxChunks) revert InputLimit();
        if (requestedMinOut == 0 || requestedMinOut < hardMinimum(id, amountIn)) revert BelowFloor();
        if (token.pending(address(pair)) != 0) revert InvalidPoolInput();
        // Reserve task allowance before any callback. A revert rolls back this accounting.
        t.status = Status.Running;
        t.soldInput += amountIn;
        IERC20(address(token)).safeTransferFrom(owner, address(pair), amountIn);
        (uint112 reserveU, uint112 reserveT,) = pair.getReserves();
        uint256 balance = token.balanceOf(address(pair));
        if (token.pending(address(pair)) != 0 || balance <= reserveT) revert InvalidPoolInput();
        uint256 actualInput = balance - reserveT;
        // Bound effective pool input (which may include a pre-existing surplus)
        // by the wallet's requested gross input. Wallet soldInput tracks only amountIn.
        if (actualInput > amountIn) revert InvalidPoolInput();
        uint256 amountOut = router.getAmountOut(actualInput, reserveT, reserveU);
        uint256 beforeUSDT = usdt.balanceOf(owner);
        pair.swap(amountOut, 0, owner, new bytes(0));
        output = usdt.balanceOf(owner) - beforeUSDT;
        if (output < requestedMinOut) revert InsufficientOutput(output, requestedMinOut);
        t.receivedUSDT += output;
        t.nextChunkIndex++;
        residual = token.balanceOf(owner);
        emit ChunkExecuted(id, owner, expectedIndex, amountIn, actualInput, output, residual);
        if (residual <= t.params.maxDustTokens) {
            _close(id, t, residual == 0 ? Status.Completed : Status.CompletedWithDust, StopReason.None, residual);
        } else if (t.soldInput == t.params.maxTotalInput || t.nextChunkIndex == t.params.maxChunks) {
            _close(id, t, Status.StoppedWithRemaining, t.soldInput == t.params.maxTotalInput ? StopReason.InputCap : StopReason.ChunkCap, residual);
        }
    }

    function cancelTask(bytes32 id) external nonReentrant {
        Task storage t = _active(id);
        if (msg.sender != t.owner) revert Unauthorized();
        _close(id, t, Status.Cancelled, StopReason.User, token.balanceOf(t.owner));
    }
    function stopTask(bytes32 id) external nonReentrant {
        Task storage t = _active(id);
        if (msg.sender != t.owner && msg.sender != t.params.executor) revert Unauthorized();
        _close(id, t, Status.StoppedWithRemaining, msg.sender == t.owner ? StopReason.User : StopReason.Executor, token.balanceOf(t.owner));
    }
    function finalizeTask(bytes32 id) external nonReentrant {
        Task storage t = _active(id);
        if (msg.sender != t.owner && msg.sender != t.params.executor) revert Unauthorized();
        uint256 residual = token.balanceOf(t.owner);
        if (block.timestamp >= t.params.expiresAt) {
            _close(id, t, Status.Expired, StopReason.Deadline, residual);
        } else {
            if (block.timestamp < t.params.notBefore) revert OutsideWindow();
            if (residual > t.params.maxDustTokens) revert ResidualTooLarge(residual);
            _close(id, t, residual == 0 ? Status.Completed : Status.CompletedWithDust, StopReason.None, residual);
        }
    }
    function _active(bytes32 id) private view returns (Task storage t) {
        t = tasks[id];
        if ((t.status != Status.Armed && t.status != Status.Running) || activeTaskId[t.owner] != id) revert InvalidTask();
    }
    function _close(bytes32 id, Task storage t, Status status, StopReason reason, uint256 residual) private {
        t.status = status;
        delete activeTaskId[t.owner];
        emit TaskClosed(id, status, reason, residual);
    }
}
