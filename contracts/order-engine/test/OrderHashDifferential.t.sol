// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] Server-vs-contract order-hash differential.
//
// POST /api/orders now stores computeOrderHash() (src/lib/order-engine/order-hash.ts) instead of the
// caller's text. This suite proves that value equals what the executors themselves compute:
//   - getOrderHash(order): TeraSwapOrderExecutorV3.sol:1149 / TeraSwapOrderExecutor.sol:964, called on
//     the real contract bytecode (no copy of the function), for every seeded order;
//   - keccak256(0x1901 | domainSeparator() | getOrderHash(order)): the digest ECDSA.recover checks
//     (V3 :360/:449), with the code placed at the production executor address of each chain and
//     block.chainid set to that chain, so the domain is the one the route recovers under.
// Orders are rebuilt here from (seed, i) exactly as scripts/orders/order-hash-vectors.ts builds them;
// the expected hashes are the server function's output, generated into OrderHashVectors.sol.
// No RPC, no fork, no ffi.

import "forge-std/Test.sol";
import {TeraSwapOrderExecutorV3} from "../TeraSwapOrderExecutorV3.sol";
import {TeraSwapOrderExecutor} from "../TeraSwapOrderExecutor.sol";
import {OrderHashVectors as V} from "./OrderHashVectors.sol";

contract OrderHashDifferentialTest is Test {
    // ── seeded derivation: MUST match orderMessage() in scripts/orders/order-hash-vectors.ts ──

    function _w(uint256 seed, uint256 i, uint256 k) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i, k)));
    }

    function _mag(uint256 x) private pure returns (uint256) {
        return x >> (x % 256);
    }

    function _a(uint256 x) private pure returns (address) {
        return address(uint160(x));
    }

    struct Fields {
        address owner;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint16 maxSlippageBps;
        uint8 orderType;
        uint8 condition;
        uint256 targetPrice;
        address priceFeed;
        uint256 expiry;
        uint256 nonce;
        address router;
        bytes32 routerDataHash;
        uint256 dcaInterval;
        uint256 dcaTotal;
    }

    function _fields(uint256 seed, uint256 i) private pure returns (Fields memory f) {
        uint8 ot = uint8(i % 3); // 0 LIMIT, 1 STOP_LOSS, 2 DCA
        bool isDca = ot == 2;
        f.owner = _a(_w(seed, i, 0));
        f.tokenIn = _a(_w(seed, i, 1));
        f.tokenOut = _a(_w(seed, i, 2));
        f.amountIn = _mag(_w(seed, i, 3));
        f.minAmountOut = _mag(_w(seed, i, 4));
        f.maxSlippageBps = uint16(_w(seed, i, 5));
        f.orderType = ot;
        f.condition = uint8(_w(seed, i, 6) % 2);
        f.targetPrice = _mag(_w(seed, i, 7));
        uint256 w8 = _w(seed, i, 8);
        f.priceFeed = isDca && w8 % 2 == 0 ? address(0) : _a(w8);
        f.expiry = _mag(_w(seed, i, 9));
        f.nonce = _mag(_w(seed, i, 10));
        f.router = _a(_w(seed, i, 11));
        f.routerDataHash = _w(seed, i, 12) % 4 == 0 ? bytes32(0) : bytes32(_w(seed, i, 13));
        uint256 w14 = _w(seed, i, 14);
        f.dcaInterval = isDca ? _mag(w14) : (w14 % 2 == 0 ? 0 : _mag(w14));
        uint256 w15 = _w(seed, i, 15);
        if (isDca) {
            uint256 j = (i / 3) % 3;
            f.dcaTotal = j == 0 ? 1 : (j == 1 ? 365 : 2 + (w15 % 363));
        } else {
            f.dcaTotal = w15 % 2 == 0 ? 1 : _mag(w15);
        }
    }

    function _v3Order(Fields memory f) private pure returns (TeraSwapOrderExecutorV3.Order memory o) {
        o.owner = f.owner;
        o.tokenIn = f.tokenIn;
        o.tokenOut = f.tokenOut;
        o.amountIn = f.amountIn;
        o.minAmountOut = f.minAmountOut;
        o.maxSlippageBps = f.maxSlippageBps;
        o.orderType = TeraSwapOrderExecutorV3.OrderType(f.orderType);
        o.condition = TeraSwapOrderExecutorV3.PriceCondition(f.condition);
        o.targetPrice = f.targetPrice;
        o.priceFeed = f.priceFeed;
        o.expiry = f.expiry;
        o.nonce = f.nonce;
        o.router = f.router;
        o.routerDataHash = f.routerDataHash;
        o.dcaInterval = f.dcaInterval;
        o.dcaTotal = f.dcaTotal;
    }

    function _v2Order(Fields memory f) private pure returns (TeraSwapOrderExecutor.Order memory o) {
        o.owner = f.owner;
        o.tokenIn = f.tokenIn;
        o.tokenOut = f.tokenOut;
        o.amountIn = f.amountIn;
        o.minAmountOut = f.minAmountOut;
        o.orderType = TeraSwapOrderExecutor.OrderType(f.orderType);
        o.condition = TeraSwapOrderExecutor.PriceCondition(f.condition);
        o.targetPrice = f.targetPrice;
        o.priceFeed = f.priceFeed;
        o.expiry = f.expiry;
        o.nonce = f.nonce;
        o.router = f.router;
        o.routerDataHash = f.routerDataHash;
        o.dcaInterval = f.dcaInterval;
        o.dcaTotal = f.dcaTotal;
    }

    function _at(bytes memory blob, uint256 i) private pure returns (bytes32 r) {
        assembly {
            r := mload(add(add(blob, 32), mul(i, 32)))
        }
    }

    // ── deployment at the production address, on the production chain id ──

    function _v3At(uint256 chainId, address at) private returns (TeraSwapOrderExecutorV3 exec) {
        vm.chainId(chainId);
        TeraSwapOrderExecutorV3 impl = new TeraSwapOrderExecutorV3(address(0xFEE), address(0xAD), address(0xE7), address(0));
        vm.etch(at, address(impl).code);
        exec = TeraSwapOrderExecutorV3(payable(at));
    }

    function _v2At(uint256 chainId, address at) private returns (TeraSwapOrderExecutor exec) {
        vm.chainId(chainId);
        TeraSwapOrderExecutor impl = new TeraSwapOrderExecutor(address(0xFEE), address(0xAD), address(0xE7));
        vm.etch(at, address(impl).code);
        exec = TeraSwapOrderExecutor(payable(at));
    }

    function _runV3(uint256 chainId, address at, uint256 seed, uint256 n, bytes memory structs, bytes memory digests) private {
        assertEq(structs.length, n * 32, "struct vector length");
        assertEq(digests.length, n * 32, "digest vector length");
        TeraSwapOrderExecutorV3 exec = _v3At(chainId, at);
        bytes32 sep = exec.domainSeparator();
        uint256[3] memory byType;
        for (uint256 i = 0; i < n; ++i) {
            Fields memory f = _fields(seed, i);
            bytes32 h = exec.getOrderHash(_v3Order(f));
            assertEq(h, _at(structs, i), string.concat("v3 getOrderHash != server computeOrderHash, order ", vm.toString(i)));
            assertEq(
                keccak256(abi.encodePacked(hex"1901", sep, h)),
                _at(digests, i),
                string.concat("v3 digest != server computeOrderDigest, order ", vm.toString(i))
            );
            byType[f.orderType]++;
        }
        assertGt(byType[0], 0, "no LIMIT order");
        assertGt(byType[1], 0, "no STOP_LOSS order");
        assertGt(byType[2], 0, "no DCA order");
    }

    function _runV2(uint256 chainId, address at, uint256 seed, uint256 n, bytes memory structs, bytes memory digests) private {
        assertEq(structs.length, n * 32, "struct vector length");
        assertEq(digests.length, n * 32, "digest vector length");
        TeraSwapOrderExecutor exec = _v2At(chainId, at);
        bytes32 sep = exec.domainSeparator();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = exec.getOrderHash(_v2Order(_fields(seed, i)));
            assertEq(h, _at(structs, i), string.concat("v2 getOrderHash != server computeOrderHash, order ", vm.toString(i)));
            assertEq(
                keccak256(abi.encodePacked(hex"1901", sep, h)),
                _at(digests, i),
                string.concat("v2 digest != server computeOrderDigest, order ", vm.toString(i))
            );
        }
    }

    function test_v3_base_serverHashEqualsGetOrderHash() public {
        _runV3(V.V3_BASE_CHAIN_ID, V.V3_BASE_EXECUTOR, V.V3_BASE_SEED, V.V3_BASE_COUNT, V.V3_BASE_STRUCT, V.V3_BASE_DIGEST);
    }

    function test_v3_arbitrum_serverHashEqualsGetOrderHash() public {
        _runV3(V.V3_ARB_CHAIN_ID, V.V3_ARB_EXECUTOR, V.V3_ARB_SEED, V.V3_ARB_COUNT, V.V3_ARB_STRUCT, V.V3_ARB_DIGEST);
    }

    function test_v2_mainnet_serverHashEqualsGetOrderHash() public {
        _runV2(V.V2_MAINNET_CHAIN_ID, V.V2_MAINNET_EXECUTOR, V.V2_MAINNET_SEED, V.V2_MAINNET_COUNT, V.V2_MAINNET_STRUCT, V.V2_MAINNET_DIGEST);
    }

    function test_v2_base_serverHashEqualsGetOrderHash() public {
        _runV2(V.V2_BASE_CHAIN_ID, V.V2_BASE_EXECUTOR, V.V2_BASE_SEED, V.V2_BASE_COUNT, V.V2_BASE_STRUCT, V.V2_BASE_DIGEST);
    }

    /// DCA coverage the goal names: dcaTotal 1 and 365 both occur on Base and on Arbitrum.
    function test_v3_dcaTotal_1_and_365_on_both_chains() public pure {
        uint256[2] memory seeds = [V.V3_BASE_SEED, V.V3_ARB_SEED];
        uint256[2] memory counts = [V.V3_BASE_COUNT, V.V3_ARB_COUNT];
        for (uint256 s = 0; s < 2; ++s) {
            bool one;
            bool max;
            for (uint256 i = 0; i < counts[s]; ++i) {
                Fields memory f = _fields(seeds[s], i);
                if (f.orderType != 2) continue;
                if (f.dcaTotal == 1) one = true;
                if (f.dcaTotal == 365) max = true;
            }
            assertTrue(one && max, "dcaTotal 1 and 365 must both occur");
        }
    }
}
