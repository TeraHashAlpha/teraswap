// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// [A91 R2-1 / design 120c "Tests that must exist"] The keeper's pre-screen bisect on the REAL Multicall3 runtime code
// (read from Base and Arbitrum One, identical: 3808 bytes, keccak 0xd5c15d…0891) and the real TeraSwapOrderExecutorV3.
//
// 1. test_singleAsk_*: an honest canExecute, asked alone with the keeper's explicit eth_call gas cap (SINGLE_ASK_GAS
//    = 3,000,000 in executor.js), answers for every order type (DCA, limit, stop-loss) and needs well under the cap;
//    a gas-burning row asked alone fails.
// 2. test_replay_*: every Multicall3 call and every alone-ask the keeper's bisect made for 1, 2 and 10 gas-burning
//    rows in one 50-row chunk (PrescreenBisectReplay.sol, generated from the shipped executor.js), replayed here at
//    the same eth_call gas cap: each call answers (or fails) exactly as the keeper saw it, the burners are the rows
//    that failed alone, and every healthy row is answered in that cycle. The keeper side
//    (executor/prescreen-bisect-replay.test.mjs) checks the shipped keeper makes exactly these calls.
//
// A "burner" is a row whose canExecute runs attacker code that burns all the gas it gets: a tokenIn whose balanceOf
// loops forever, or a priceFeed whose latestRoundData does. Order creation accepts such a token (audit A91 R2-1).

import "forge-std/Test.sol";
import "../TeraSwapOrderExecutorV3.sol";
import "./PrescreenBisectReplay.sol";

contract PbGoodToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }
}

contract PbBurnerToken {
    function balanceOf(address) external pure returns (uint256) {
        assembly {
            for {} 1 {} {}
        }
        return 0;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract PbBurnerFeed {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        assembly {
            for {} 1 {} {}
        }
        return (0, 0, 0, 0, 0);
    }
}

contract PbFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2000e8, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract PbRouter {
    fallback() external payable {}
}

contract PrescreenBisectTest is Test {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result3 {
        bool success;
        bytes returnData;
    }

    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    bytes32 constant MULTICALL3_CODEHASH = 0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891;
    uint256 constant SINGLE_ASK_GAS = 3_000_000; // executor.js SINGLE_ASK_GAS
    // Row kinds: the same bytes as executor/prescreen-bisect.replay.mjs.
    uint8 constant DCA = 0;
    uint8 constant LIMIT = 1;
    uint8 constant STOP = 2;
    uint8 constant LIMIT_FALSE = 3;
    uint8 constant BURN_TOKEN = 4;
    uint8 constant BURN_FEED = 5;

    string constant TYPESTRING =
        "Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,"
        "uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,"
        "bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)";

    TeraSwapOrderExecutorV3 ex;
    PbGoodToken good;
    PbBurnerToken burnerToken;
    PbBurnerFeed burnerFeed;
    PbFeed feed;
    PbRouter router;
    bytes32 domainSep;

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.etch(MULTICALL3, MULTICALL3_RUNTIME);
        assertEq(MULTICALL3.codehash, MULTICALL3_CODEHASH, "the Multicall3 runtime code of Base and Arbitrum One");
        good = new PbGoodToken();
        burnerToken = new PbBurnerToken();
        burnerFeed = new PbBurnerFeed();
        feed = new PbFeed();
        router = new PbRouter();
        ex = new TeraSwapOrderExecutorV3(address(0xFE), address(0xAD), address(0xEEEE), address(0));
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        vm.prank(address(0xAD));
        ex.bootstrap(routers, executors);
        domainSep = ex.domainSeparator();
    }

    /// The canExecute calldata of one signed V3 order of `kind` (owner key `pk`).
    function _call(uint256 pk, uint8 kind) internal returns (bytes memory) {
        address owner = vm.addr(pk);
        address tokenIn = kind == BURN_TOKEN ? address(burnerToken) : address(good);
        if (tokenIn == address(good)) {
            good.mint(owner, 1_000e18);
            vm.prank(owner);
            good.approve(address(ex), type(uint256).max);
        }
        bool isDca = kind == DCA || kind == BURN_TOKEN;
        TeraSwapOrderExecutorV3.Order memory o = TeraSwapOrderExecutorV3.Order({
            owner: owner,
            tokenIn: tokenIn,
            tokenOut: address(0xBEEF),
            amountIn: 100e18,
            minAmountOut: 1e18,
            maxSlippageBps: 100,
            orderType: isDca ? TeraSwapOrderExecutorV3.OrderType.DCA : (kind == STOP ? TeraSwapOrderExecutorV3.OrderType.STOP_LOSS : TeraSwapOrderExecutorV3.OrderType.LIMIT),
            condition: kind == STOP ? TeraSwapOrderExecutorV3.PriceCondition.BELOW : TeraSwapOrderExecutorV3.PriceCondition.ABOVE,
            targetPrice: isDca ? 0 : (kind == STOP || kind == LIMIT_FALSE ? 3000e8 : 1000e8),
            priceFeed: isDca ? address(0) : (kind == BURN_FEED ? address(burnerFeed) : address(feed)),
            expiry: block.timestamp + 30 days,
            nonce: pk,
            router: address(router),
            routerDataHash: bytes32(0),
            dcaInterval: isDca ? 3600 : 0,
            dcaTotal: isDca ? 10 : 0
        });
        bytes32 h = keccak256(
            abi.encode(
                keccak256(bytes(TYPESTRING)), o.owner, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.maxSlippageBps,
                o.orderType, o.condition, o.targetPrice, o.priceFeed, o.expiry, o.nonce, o.router, o.routerDataHash,
                o.dcaInterval, o.dcaTotal
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSep, h)));
        return abi.encodeCall(ex.canExecute, (o, abi.encodePacked(r, s, v)));
    }

    /// eth_call charges the intrinsic gas (21000 + calldata) inside its cap; the frame gets the rest.
    function _frameGas(uint256 cap, bytes memory data) internal pure returns (uint256 g) {
        g = 21000;
        for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
        g = cap - g;
    }

    /// One row asked alone, as the keeper does: (answered?, canExec, gas used).
    function _alone(bytes memory data) internal returns (bool ok, bool canExec, uint256 used) {
        uint256 frame = _frameGas(SINGLE_ASK_GAS, data); // before the measurement: it is the test's own work
        bytes memory ret;
        uint256 g0 = gasleft();
        (ok, ret) = address(ex).call{gas: frame}(data);
        used = g0 - gasleft();
        if (ok) (canExec, ) = abi.decode(ret, (bool, string));
    }

    // ── 1. the single ask's gas cap ──────────────────────────────────────────────────────────────────

    function test_singleAsk_honestCanExecuteNeedsWellUnderTheCap_everyOrderType() public {
        uint8[4] memory kinds = [DCA, LIMIT, STOP, LIMIT_FALSE];
        bool[4] memory expected = [true, true, true, false];
        string[4] memory names = ["DCA", "limit", "stop-loss", "limit (price below target)"];
        for (uint256 i = 0; i < 4; i++) {
            (bool ok, bool canExec, uint256 used) = _alone(_call(0x9000 + i, kinds[i]));
            assertTrue(ok, names[i]);
            assertEq(canExec, expected[i], names[i]);
            assertLt(used, SINGLE_ASK_GAS / 30, "well under the cap: < 100,000 gas");
            console.log(string.concat("honest canExecute asked alone, ", names[i], ": gas ", vm.toString(used)));
        }
    }

    function test_singleAsk_aBurnerAskedAloneFails() public {
        (bool ok, , uint256 used) = _alone(_call(0x9100, BURN_TOKEN));
        assertFalse(ok, "token burner");
        console.log(string.concat("burner token asked alone: fails after gas ", vm.toString(used)));
        (ok, , used) = _alone(_call(0x9101, BURN_FEED));
        assertFalse(ok, "feed burner");
        console.log(string.concat("burner feed asked alone: fails after gas ", vm.toString(used)));
    }

    // ── 2. the keeper's bisect, replayed ────────────────────────────────────────────────────────────

    function test_replay_oneBurner_cap50M() public {
        _replay(0);
    }

    function test_replay_twoBurners_cap50M() public {
        _replay(1);
    }

    function test_replay_tenBurners_cap50M() public {
        _replay(2);
    }

    function test_replay_tenBurners_cap550M() public {
        _replay(3);
    }

    function _replay(uint256 which) internal {
        PrescreenBisectReplay.Scenario memory sc = PrescreenBisectReplay.scenarios()[which];
        uint256 n = sc.kinds.length;
        bytes[] memory calls = new bytes[](n);
        for (uint256 i = 0; i < n; i++) calls[i] = _call(0x1000 + i, uint8(sc.kinds[i]));
        bool[] memory answered = new bool[](n);
        bool[] memory failedAlone = new bool[](n);
        uint256 replayed;
        bytes memory rec = sc.calls;
        for (uint256 p = 0; p < rec.length; ) {
            bool aggregate = uint8(rec[p++]) == 0;
            uint256 m = uint8(rec[p++]);
            uint256[] memory rows = new uint256[](m);
            for (uint256 j = 0; j < m; j++) rows[j] = uint8(rec[p++]);
            bool wantOk = uint8(rec[p++]) == 1;
            if (aggregate) {
                Call3[] memory c3 = new Call3[](m);
                for (uint256 j = 0; j < m; j++) c3[j] = Call3(address(ex), true, calls[rows[j]]);
                bytes memory data = abi.encodeWithSignature("aggregate3((address,bool,bytes)[])", c3);
                (bool ok, bytes memory ret) = MULTICALL3.call{gas: _frameGas(sc.cap, data)}(data);
                assertEq(ok, wantOk, string.concat(sc.name, ": aggregate3 call ", vm.toString(replayed)));
                if (ok) {
                    Result3[] memory res = abi.decode(ret, (Result3[]));
                    for (uint256 j = 0; j < m; j++) {
                        uint8 got = 0;
                        if (res[j].success) {
                            (bool ce, ) = abi.decode(res[j].returnData, (bool, string));
                            got = ce ? 2 : 1;
                            answered[rows[j]] = true;
                        }
                        assertEq(got, uint8(rec[p++]), string.concat(sc.name, ": call ", vm.toString(replayed), " row ", vm.toString(rows[j])));
                    }
                }
            } else {
                (bool ok, , ) = _alone(calls[rows[0]]);
                assertEq(ok, wantOk, string.concat(sc.name, ": alone-ask of row ", vm.toString(rows[0])));
                if (ok) answered[rows[0]] = true;
                else failedAlone[rows[0]] = true;
            }
            replayed++;
            vm.resetGasMetering(); // each replayed call is its own eth_call; the test's own budget is not the subject
        }
        uint256 burners;
        for (uint256 i = 0; i < n; i++) {
            uint8 k = uint8(sc.kinds[i]);
            bool burner = k == BURN_TOKEN || k == BURN_FEED;
            if (burner) {
                burners++;
                assertFalse(answered[i], string.concat(sc.name, ": a burner never answers, row ", vm.toString(i)));
                // One burner never fails its chunk: only its own call fails, and it is not bisected (scenario 0).
                if (which > 0) assertTrue(failedAlone[i], string.concat(sc.name, ": the bisect isolated the burner at row ", vm.toString(i)));
            } else {
                assertTrue(answered[i], string.concat(sc.name, ": healthy row answered in that cycle, row ", vm.toString(i)));
            }
        }
        console.log(string.concat(sc.name, ": ", vm.toString(replayed), " call(s) replayed, ", vm.toString(burners), " burner(s), ", vm.toString(n - burners), " healthy rows answered"));
    }

    bytes constant MULTICALL3_RUNTIME = hex"6080604052600436106100f35760003560e01c80634d2301cc1161008a578063a8b0574e11610059578063a8b0574e1461025a578063bce38bd714610275578063c3077fa914610288578063ee82ac5e1461029b57600080fd5b80634d2301cc146101ec57806372425d9d1461022157806382ad56cb1461023457806386d516e81461024757600080fd5b80633408e470116100c65780633408e47014610191578063399542e9146101a45780633e64a696146101c657806342cbb15c146101d957600080fd5b80630f28c97d146100f8578063174dea711461011a578063252dba421461013a57806327e86d6e1461015b575b600080fd5b34801561010457600080fd5b50425b6040519081526020015b60405180910390f35b61012d610128366004610a85565b6102ba565b6040516101119190610bbe565b61014d610148366004610a85565b6104ef565b604051610111929190610bd8565b34801561016757600080fd5b50437fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0140610107565b34801561019d57600080fd5b5046610107565b6101b76101b2366004610c60565b610690565b60405161011193929190610cba565b3480156101d257600080fd5b5048610107565b3480156101e557600080fd5b5043610107565b3480156101f857600080fd5b50610107610207366004610ce2565b73ffffffffffffffffffffffffffffffffffffffff163190565b34801561022d57600080fd5b5044610107565b61012d610242366004610a85565b6106ab565b34801561025357600080fd5b5045610107565b34801561026657600080fd5b50604051418152602001610111565b61012d610283366004610c60565b61085a565b6101b7610296366004610a85565b610a1a565b3480156102a757600080fd5b506101076102b6366004610d18565b4090565b60606000828067ffffffffffffffff8111156102d8576102d8610d31565b60405190808252806020026020018201604052801561031e57816020015b6040805180820190915260008152606060208201528152602001906001900390816102f65790505b5092503660005b8281101561047757600085828151811061034157610341610d60565b6020026020010151905087878381811061035d5761035d610d60565b905060200281019061036f9190610d8f565b6040810135958601959093506103886020850185610ce2565b73ffffffffffffffffffffffffffffffffffffffff16816103ac6060870187610dcd565b6040516103ba929190610e32565b60006040518083038185875af1925050503d80600081146103f7576040519150601f19603f3d011682016040523d82523d6000602084013e6103fc565b606091505b50602080850191909152901515808452908501351761046d577f08c379a000000000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260846000fd5b5050600101610325565b508234146104e6576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601a60248201527f4d756c746963616c6c333a2076616c7565206d69736d6174636800000000000060448201526064015b60405180910390fd5b50505092915050565b436060828067ffffffffffffffff81111561050c5761050c610d31565b60405190808252806020026020018201604052801561053f57816020015b606081526020019060019003908161052a5790505b5091503660005b8281101561068657600087878381811061056257610562610d60565b90506020028101906105749190610e42565b92506105836020840184610ce2565b73ffffffffffffffffffffffffffffffffffffffff166105a66020850185610dcd565b6040516105b4929190610e32565b6000604051808303816000865af19150503d80600081146105f1576040519150601f19603f3d011682016040523d82523d6000602084013e6105f6565b606091505b5086848151811061060957610609610d60565b602090810291909101015290508061067d576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601760248201527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060448201526064016104dd565b50600101610546565b5050509250929050565b43804060606106a086868661085a565b905093509350939050565b6060818067ffffffffffffffff8111156106c7576106c7610d31565b60405190808252806020026020018201604052801561070d57816020015b6040805180820190915260008152606060208201528152602001906001900390816106e55790505b5091503660005b828110156104e657600084828151811061073057610730610d60565b6020026020010151905086868381811061074c5761074c610d60565b905060200281019061075e9190610e76565b925061076d6020840184610ce2565b73ffffffffffffffffffffffffffffffffffffffff166107906040850185610dcd565b60405161079e929190610e32565b6000604051808303816000865af19150503d80600081146107db576040519150601f19603f3d011682016040523d82523d6000602084013e6107e0565b606091505b506020808401919091529015158083529084013517610851577f08c379a000000000000000000000000000000000000000000000000000000000600052602060045260176024527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060445260646000fd5b50600101610714565b6060818067ffffffffffffffff81111561087657610876610d31565b6040519080825280602002602001820160405280156108bc57816020015b6040805180820190915260008152606060208201528152602001906001900390816108945790505b5091503660005b82811015610a105760008482815181106108df576108df610d60565b602002602001015190508686838181106108fb576108fb610d60565b905060200281019061090d9190610e42565b925061091c6020840184610ce2565b73ffffffffffffffffffffffffffffffffffffffff1661093f6020850185610dcd565b60405161094d929190610e32565b6000604051808303816000865af19150503d806000811461098a576040519150601f19603f3d011682016040523d82523d6000602084013e61098f565b606091505b506020830152151581528715610a07578051610a07576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601760248201527f4d756c746963616c6c333a2063616c6c206661696c656400000000000000000060448201526064016104dd565b506001016108c3565b5050509392505050565b6000806060610a2b60018686610690565b919790965090945092505050565b60008083601f840112610a4b57600080fd5b50813567ffffffffffffffff811115610a6357600080fd5b6020830191508360208260051b8501011115610a7e57600080fd5b9250929050565b60008060208385031215610a9857600080fd5b823567ffffffffffffffff811115610aaf57600080fd5b610abb85828601610a39565b90969095509350505050565b6000815180845260005b81811015610aed57602081850181015186830182015201610ad1565b81811115610aff576000602083870101525b50601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b600082825180855260208086019550808260051b84010181860160005b84811015610bb1578583037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe001895281518051151584528401516040858501819052610b9d81860183610ac7565b9a86019a9450505090830190600101610b4f565b5090979650505050505050565b602081526000610bd16020830184610b32565b9392505050565b600060408201848352602060408185015281855180845260608601915060608160051b870101935082870160005b82811015610c52577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa0888703018452610c40868351610ac7565b95509284019290840190600101610c06565b509398975050505050505050565b600080600060408486031215610c7557600080fd5b83358015158114610c8557600080fd5b9250602084013567ffffffffffffffff811115610ca157600080fd5b610cad86828701610a39565b9497909650939450505050565b838152826020820152606060408201526000610cd96060830184610b32565b95945050505050565b600060208284031215610cf457600080fd5b813573ffffffffffffffffffffffffffffffffffffffff81168114610bd157600080fd5b600060208284031215610d2a57600080fd5b5035919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff81833603018112610dc357600080fd5b9190910192915050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112610e0257600080fd5b83018035915067ffffffffffffffff821115610e1d57600080fd5b602001915036819003821315610a7e57600080fd5b8183823760009101908152919050565b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc1833603018112610dc357600080fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa1833603018112610dc357600080fdfea2646970667358221220bb2b5c71a328032f97c676ae39a1ec2148d3e5d6f73d95e9b17910152d61f16264736f6c634300080c0033";
}
