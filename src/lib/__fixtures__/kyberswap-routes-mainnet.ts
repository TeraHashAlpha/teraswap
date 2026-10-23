/**
 * [fix/functional-chain-ui F2] REAL KyberSwap Aggregator `GET /ethereum/api/v1/routes` responses,
 * recorded (not synthesised) on 2026-10-23 from https://aggregator-api.kyberswap.com, WETH -> USDC
 * on Ethereum mainnet, `saveGas=0&gasInclude=true`, no wallet.
 *
 * Trimmed for size: every hop keeps its recorded pool / tokenIn / tokenOut / swapAmount / amountOut /
 * exchange / poolType verbatim; the opaque `extra` / `poolExtra` blobs are dropped, as is
 * `routeSummary` metadata the adapter never reads.
 *
 *   KYBER_ROUTES_WETH_USDC_1     amountIn 1 WETH     -> 1 path, `pool` is a 0x pool ADDRESS
 *   KYBER_ROUTES_WETH_USDC_2000  amountIn 2000 WETH  -> 18 split paths recorded; paths 0,4,10,14,15
 *                                kept: hashflow + PMM (`pool` embeds 0x token addresses),
 *                                metric-propamm + fluid-dex-t1 (`pool` is a 0x address),
 *                                uniswap-v4-stable-stable (`pool` is a 32-byte v4 pool id)
 */
export const KYBER_ROUTES_WETH_USDC_1 = {
  "code": 0,
  "message": "successfully",
  "data": {
    "routeSummary": {
      "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "amountIn": "1000000000000000000",
      "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "amountOut": "2403152850",
      "gas": "330498",
      "gasUsd": "0.11080714525871903",
      "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      "route": [
        [
          {
            "pool": "0xe0554a476a092703abdb3ef35c80e0d76d32939f",
            "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapAmount": "1000000000000000000",
            "amountOut": "2403152850",
            "exchange": "uniswapv3",
            "poolType": "uniswapv3"
          }
        ]
      ]
    }
  }
} as const

export const KYBER_ROUTES_WETH_USDC_2000 = {
  "code": 0,
  "message": "successfully",
  "data": {
    "routeSummary": {
      "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "amountIn": "2000000000000000000000",
      "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "amountOut": "4783113769718",
      "gas": "8178250",
      "gasUsd": "2.612196793925969",
      "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      "route": [
        [
          {
            "pool": "hashflow_v3_mm46_1_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2_0xdac17f958d2ee523a2206206994597c13d831ec7",
            "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "tokenOut": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "swapAmount": "177078007828869790801",
            "amountOut": "423868371870",
            "exchange": "hashflow-v3/uniswapv3",
            "poolType": "hashflow-v3"
          }
        ],
        [
          {
            "pool": "pmm_1_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapAmount": "80000000000000000000",
            "amountOut": "191290602132",
            "exchange": "pmm-1/uniswapv3",
            "poolType": "orderbook"
          }
        ],
        [
          {
            "pool": "0xe9c19e5bd10e5096519fe1d2a9d783f79b8211da",
            "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapAmount": "59160500572657400136",
            "amountOut": "142124744531",
            "exchange": "metric-propamm/uniswapv3",
            "poolType": "metric-propamm"
          }
        ],
        [
          {
            "pool": "0x2b21c65d9a7dc6926ee330a1c6e5a8037fd81774f3dc066536f800128e39f634",
            "tokenIn": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapAmount": "723586589872",
            "amountOut": "722814291461",
            "exchange": "uniswap-v4-stable-stable",
            "poolType": "uniswap-v4"
          }
        ],
        [
          {
            "pool": "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b",
            "tokenIn": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "tokenOut": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapAmount": "925248649617",
            "amountOut": "924250492168",
            "exchange": "fluid-dex-t1",
            "poolType": "fluid-dex-t1"
          }
        ]
      ]
    }
  }
} as const
