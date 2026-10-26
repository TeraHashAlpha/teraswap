/**
 * [chore/copy-leftovers] RECORDED Velora (ex-ParaSwap) `GET /prices` response, trimmed.
 *
 * Recorded 2026-10-26 from https://api.paraswap.io/prices?srcToken=WETH&destToken=USDC&amount=10e18
 * &srcDecimals=18&destDecimals=6&side=SELL&network=1&version=6.2 (public, no key). Trimmed to the fields the
 * adapter reads: the per-hop `data` payloads, `hmac`, `blockNumber` and `contractAddress`es are dropped.
 *
 * What it proves: a hop's `exchange` is a Velora-internal venue id, not always a DEX name — `metric-v1` is a
 * Velora-integrated market maker with no display name in the response, next to `uniswapv4`. The adapter used
 * to hand those ids to the UI verbatim as the Route.
 */
export const VELORA_PRICES_MAINNET_WETH_USDC = {
  "priceRoute": {
    "network": 1,
    "srcToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "srcDecimals": 18,
    "srcAmount": "10000000000000000000",
    "destToken": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "destDecimals": 6,
    "destAmount": "23139442840",
    "gasCostUSD": "0.153374",
    "gasCost": "591170",
    "side": "SELL",
    "version": "6.2",
    "bestRoute": [
      {
        "percent": 70,
        "swaps": [
          {
            "srcToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "destToken": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapExchanges": [
              {
                "exchange": "metric-v1",
                "srcAmount": "7000000000000000000",
                "destAmount": "16197648622",
                "percent": 100,
                "poolAddresses": [
                  "0xe9c19e5bd10e5096519fe1d2a9d783f79b8211da"
                ],
                "poolIdentifiers": [
                  "metric-v1_0xe9c19e5bd10e5096519fe1d2a9d783f79b8211da"
                ],
                "targetExchange": "0x3c6c4fc94f1493b9d76c5e4c4cdedb444d3cc0a2",
                "fallback": {
                  "exchange": "uniswapv3",
                  "srcAmount": "7000000000000000000",
                  "destAmount": "16187958847",
                  "percent": 100,
                  "poolAddresses": [
                    "0xe0554a476a092703abdb3ef35c80e0d76d32939f"
                  ],
                  "poolIdentifiers": [
                    "uniswapv3_0xe0554a476a092703abdb3ef35c80e0d76d32939f"
                  ],
                  "targetExchange": "0xe592427a0aece92de3edee1f18e0157c05861564"
                }
              }
            ]
          }
        ]
      },
      {
        "percent": 30,
        "swaps": [
          {
            "srcToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "destToken": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "swapExchanges": [
              {
                "exchange": "metric-v1",
                "srcAmount": "3000000000000000000",
                "destAmount": "6949608729",
                "percent": 100,
                "poolAddresses": [
                  "0x99125a7187d8a730345b0bf9ba5af7465e58292e"
                ],
                "poolIdentifiers": [
                  "metric-v1_0x99125a7187d8a730345b0bf9ba5af7465e58292e"
                ],
                "targetExchange": "0x3c6c4fc94f1493b9d76c5e4c4cdedb444d3cc0a2",
                "fallback": {
                  "exchange": "uniswapv3",
                  "srcAmount": "3000000000000000000",
                  "destAmount": "6942276978",
                  "percent": 100,
                  "poolAddresses": [
                    "0x11b815efb8f581194ae79006d24e0d814b7697f6"
                  ],
                  "poolIdentifiers": [
                    "uniswapv3_0x11b815efb8f581194ae79006d24e0d814b7697f6"
                  ],
                  "targetExchange": "0xe592427a0aece92de3edee1f18e0157c05861564"
                }
              }
            ]
          },
          {
            "srcToken": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "destToken": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "swapExchanges": [
              {
                "exchange": "uniswapv4",
                "srcAmount": "6949608729",
                "destAmount": "6941794218",
                "percent": 100,
                "poolAddresses": [
                  "0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239"
                ],
                "poolIdentifiers": [
                  "uniswapv4_0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239"
                ],
                "targetExchange": "0x66a9893cc07d91d95644aedd05d03f95e1dba8af"
              }
            ]
          }
        ]
      }
    ]
  }
} as const
