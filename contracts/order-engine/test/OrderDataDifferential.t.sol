// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// [fix/server-builds-order-data, A86 S-4/S-5] Stored order_data → keeper struct → the executors' own getOrderHash.
//
// src/app/api/orders/orders-order-data-differential.test.ts POSTs 300 seeded valid orders to the real route and runs the
// keeper's own code on each stored row (routing call and struct literal sliced from executor.js). It wrote
// OrderDataVectors.sol: per set, the stored order_hash of every order and a hash chain over abi.encode(the keeper's struct).
// This suite rebuilds every order from (seed, i) with the derivation of scripts/orders/order-data-vectors.ts orderFields(),
// and on the real executor bytecode, at the production address with the production chain id:
//   - getOrderHash(order i) == the stored order_hash i;
//   - the chain over abi.encode(order i) == the keeper's chain, so the structs hashed here are the keeper's, byte for byte.
// No RPC, no fork, no ffi.

import "forge-std/Test.sol";
import {TeraSwapOrderExecutorV3} from "../TeraSwapOrderExecutorV3.sol";
import {TeraSwapOrderExecutor} from "../TeraSwapOrderExecutor.sol";
import {OrderDataVectors as V} from "./OrderDataVectors.sol";

contract OrderDataDifferentialTest is Test {
    uint256 private constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    // ── seeded derivation: MUST match orderFields() in scripts/orders/order-data-vectors.ts ──

    function _w(uint256 seed, uint256 i, uint256 k) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i, k)));
    }

    struct Fields {
        uint8 kind; // 0 Limit, 1 Take-Profit, 2 DCA
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

    function _routerAt(bytes memory packed, uint256 j) private pure returns (address a) {
        assembly {
            a := shr(96, mload(add(add(packed, 32), mul(j, 20))))
        }
    }

    function _fields(uint256 seed, uint256 i, bool v3, bytes memory kinds, bytes memory routers)
        private
        pure
        returns (Fields memory f)
    {
        f.kind = uint8(kinds[i % kinds.length]);
        bool isDca = f.kind == 2;
        bool pinned = !isDca && (v3 || _w(seed, i, 12) % 3 != 0);
        f.owner = vm.addr((_w(seed, i, 0) % (SECP256K1_N - 1)) + 1);
        f.tokenIn = address(uint160(_w(seed, i, 1)));
        f.tokenOut = address(uint160(_w(seed, i, 2)));
        f.amountIn = 1e7 + (_w(seed, i, 3) % 1e27);
        f.minAmountOut = 1e20 + (_w(seed, i, 4) % 1e27);
        if (v3) f.maxSlippageBps = uint16(1 + (_w(seed, i, 5) % 500));
        f.orderType = f.kind;
        f.condition = f.kind == 1 ? 0 : uint8(_w(seed, i, 6) % 2);
        f.targetPrice = isDca ? _w(seed, i, 7) % 1e14 : 1 + (_w(seed, i, 7) % 1e14);
        uint256 w8 = _w(seed, i, 8);
        f.priceFeed = isDca && w8 % 2 == 0 ? address(0) : address(uint160(w8));
        f.expiry = V.NOW + 3600 + (_w(seed, i, 9) % (89 * 86400));
        f.nonce = _w(seed, i, 10) % 2 ** 31;
        f.router = _routerAt(routers, _w(seed, i, 11) % (routers.length / 20));
        f.routerDataHash = pinned
            ? keccak256(abi.encodePacked(bytes4(0x12345678), _w(seed, i, 13), _w(seed, i, 14)))
            : bytes32(0);
        f.dcaInterval = isDca ? 60 + (_w(seed, i, 15) % (30 * 86400)) : 0;
        f.dcaTotal = isDca ? 2 + (_w(seed, i, 16) % 364) : 1;
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

    // ── the executor's real bytecode at its production address, on its production chain id ──

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

    struct SetVectors {
        uint256 chainId;
        address executor;
        uint256 seed;
        uint256 count;
        bytes kinds;
        bytes routers;
        bytes stored;
        bytes32 keeperDigest;
    }

    function _run(bool v3, SetVectors memory s) private {
        assertEq(s.stored.length, s.count * 32, "stored vector length");
        TeraSwapOrderExecutorV3 e3;
        TeraSwapOrderExecutor e2;
        if (v3) e3 = _v3At(s.chainId, s.executor);
        else e2 = _v2At(s.chainId, s.executor);
        bytes32 chain;
        uint256[3] memory byKind;
        for (uint256 i = 0; i < s.count; ++i) {
            Fields memory f = _fields(s.seed, i, v3, s.kinds, s.routers);
            bytes32 h;
            if (v3) {
                TeraSwapOrderExecutorV3.Order memory o = _v3Order(f);
                h = e3.getOrderHash(o);
                chain = keccak256(abi.encodePacked(chain, abi.encode(o)));
            } else {
                TeraSwapOrderExecutor.Order memory o = _v2Order(f);
                h = e2.getOrderHash(o);
                chain = keccak256(abi.encodePacked(chain, abi.encode(o)));
            }
            assertEq(h, _at(s.stored, i), string.concat("getOrderHash != stored order_hash, order ", vm.toString(i)));
            byKind[f.kind]++;
        }
        assertEq(chain, s.keeperDigest, "the structs hashed here are not the keeper's structs");
        for (uint256 k = 0; k < s.kinds.length; ++k) {
            assertGt(byKind[uint8(s.kinds[k])], 0, "an order type of this set never occurred");
        }
    }

    function test_v3_base_keeperStructFromStoredOrderData_isTheStoredHash() public {
        _run(true, SetVectors(V.V3_BASE_CHAIN_ID, V.V3_BASE_EXECUTOR, V.V3_BASE_SEED, V.V3_BASE_COUNT, V.V3_BASE_KINDS, V.V3_BASE_ROUTERS, V.V3_BASE_STORED, V.V3_BASE_KEEPER_DIGEST));
    }

    function test_v3_arbitrum_keeperStructFromStoredOrderData_isTheStoredHash() public {
        _run(true, SetVectors(V.V3_ARB_CHAIN_ID, V.V3_ARB_EXECUTOR, V.V3_ARB_SEED, V.V3_ARB_COUNT, V.V3_ARB_KINDS, V.V3_ARB_ROUTERS, V.V3_ARB_STORED, V.V3_ARB_KEEPER_DIGEST));
    }

    function test_v2_base_keeperStructFromStoredOrderData_isTheStoredHash() public {
        _run(false, SetVectors(V.V2_BASE_CHAIN_ID, V.V2_BASE_EXECUTOR, V.V2_BASE_SEED, V.V2_BASE_COUNT, V.V2_BASE_KINDS, V.V2_BASE_ROUTERS, V.V2_BASE_STORED, V.V2_BASE_KEEPER_DIGEST));
    }

    function test_v2_mainnet_keeperStructFromStoredOrderData_isTheStoredHash() public {
        _run(false, SetVectors(V.V2_MAINNET_CHAIN_ID, V.V2_MAINNET_EXECUTOR, V.V2_MAINNET_SEED, V.V2_MAINNET_COUNT, V.V2_MAINNET_KINDS, V.V2_MAINNET_ROUTERS, V.V2_MAINNET_STORED, V.V2_MAINNET_KEEPER_DIGEST));
    }

    /// The four sets add up to the 300 orders the TS half posted.
    function test_three_hundred_orders() public pure {
        assertEq(V.V3_BASE_COUNT + V.V3_ARB_COUNT + V.V2_BASE_COUNT + V.V2_MAINNET_COUNT, 300);
    }
}
