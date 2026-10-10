// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SellerCore} from "./SellerCore.sol";

/// @notice BSC-only production deployment. All asset destinations are fixed.
contract NBDAOSeller is SellerCore {
    constructor() SellerCore(
        address(bytes20(hex"63d1eacebb70bbbf0641e7c88e9099301bba3688")),
        address(bytes20(hex"55d398326f99059ff775485246999027b3197955")),
        address(bytes20(hex"17662cadea9e98a5a660ca1fe993f136d3cb0ae1")),
        address(bytes20(hex"10ed43c718714eb63d5aa57b78b54704e256024e")),
        address(bytes20(hex"ca143ce32fe78f1f7019d7d551a6402fc5350c73")),
        56
    ) {}
}
