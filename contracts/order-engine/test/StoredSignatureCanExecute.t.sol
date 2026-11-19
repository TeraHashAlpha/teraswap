// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// [fix/server-builds-order-data, A95 S-2] The signature POST /api/orders stores must be one the executors accept.
//
// src/app/api/orders/orders-server-builds-order-data.test.ts ("A95 S-2") POSTs 12 orders (v3 Base, v3 Arbitrum, v2 Base, v2
// Mainnet; each with the three signature texts viem recovers the signer from but OpenZeppelin's ECDSA refuses: v = 0/1,
// the high-s twin with v 27/28, the high-s twin with v 0/1) to the real route and writes StoredSignatureVectors.sol: per row
// the abi.encode of the struct the KEEPER builds from the stored order_data, the signature text that was sent, the one
// that was stored. On the executors' real bytecode, at the production address with the production chain id:
//   - canExecute(order, sent) REVERTS (the premise: this is a text the executor refuses, so a row holding it can never run);
//   - canExecute(order, stored) does not revert and does not answer "Invalid signature" (the signature check passed; what
//     it answers next, e.g. "Router not whitelisted", is the executor's own state, which a fresh test deployment has none of).
// No RPC, no fork, no ffi.

import "forge-std/Test.sol";
import {TeraSwapOrderExecutorV3} from "../TeraSwapOrderExecutorV3.sol";
import {TeraSwapOrderExecutor} from "../TeraSwapOrderExecutor.sol";
import {StoredSignatureVectors as V} from "./StoredSignatureVectors.sol";

contract StoredSignatureCanExecuteTest is Test {
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

    /// 0 = reverted, 1 = answered "Invalid signature", 2 = the signature was accepted (any other answer).
    function _canExecute(V.Row memory r, bytes memory sig) private returns (uint8) {
        if (r.v3) {
            TeraSwapOrderExecutorV3 e = _v3At(r.chainId, r.executor);
            TeraSwapOrderExecutorV3.Order memory o = abi.decode(r.order, (TeraSwapOrderExecutorV3.Order));
            try e.canExecute(o, sig) returns (bool, string memory reason) {
                return keccak256(bytes(reason)) == keccak256("Invalid signature") ? 1 : 2;
            } catch {
                return 0;
            }
        }
        TeraSwapOrderExecutor e2 = _v2At(r.chainId, r.executor);
        TeraSwapOrderExecutor.Order memory o2 = abi.decode(r.order, (TeraSwapOrderExecutor.Order));
        try e2.canExecute(o2, sig) returns (bool, string memory reason2) {
            return keccak256(bytes(reason2)) == keccak256("Invalid signature") ? 1 : 2;
        } catch {
            return 0;
        }
    }

    function test_twelve_rows() public pure {
        assertEq(V.COUNT, 12);
    }

    /// The premise: the text the caller sent is one the executor's ECDSA refuses (so storing it as sent stored a dead row).
    function test_sentSignature_isRefusedByTheExecutor() public {
        uint256 refused;
        for (uint256 i = 0; i < V.COUNT; ++i) {
            V.Row memory r = V.row(i);
            if (_canExecute(r, r.sent) == 0) ++refused;
        }
        assertEq(refused, V.COUNT, "rows whose SENT signature the executor refused (reverted)");
    }

    /// The fix: the text the route stored passes the executor's signature check, for all 12.
    function test_storedSignature_isAcceptedByTheExecutor() public {
        uint256 accepted;
        for (uint256 i = 0; i < V.COUNT; ++i) {
            V.Row memory r = V.row(i);
            if (_canExecute(r, r.stored) == 2) ++accepted;
        }
        assertEq(accepted, V.COUNT, "rows whose STORED signature the executor accepted");
    }
}
