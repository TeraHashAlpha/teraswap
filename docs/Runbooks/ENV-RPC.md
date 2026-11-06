# RPC environment variables (server vs browser)

Introduced by `feat/server-rpc-env-split`. Resolver: `src/lib/rpc-env.ts`. Names only below — never paste a URL
(provider keys live in the URL path).

## Why two keys

The browser key (`NEXT_PUBLIC_*`) is shipped to every visitor, so it gets an Alchemy **domain allowlist**. A
server request has no `Origin`, and the allowlist rejects it ("Unspecified origin not on whitelist", seen
29–30 Oct). The server therefore needs its own, **un-allowlisted** key in `RPC_URL_<chainId>`.

## Resolution order

| Chain | Server (first non-empty wins) | Browser |
|---|---|---|
| 1 Ethereum | `RPC_URL_1` → `RPC_URL` (legacy, mainnet only) → `NEXT_PUBLIC_RPC_URL` → public default | `NEXT_PUBLIC_RPC_URL` → default |
| 8453 Base | `RPC_URL_8453` → `NEXT_PUBLIC_BASE_RPC_URL` → registry public fallback | `NEXT_PUBLIC_BASE_RPC_URL` → fallback |
| 42161 Arbitrum | `RPC_URL_42161` → `NEXT_PUBLIC_ARBITRUM_RPC_URL` → registry public fallback | `NEXT_PUBLIC_ARBITRUM_RPC_URL` → fallback |

`RPC_URL` is never consulted for Base/Arbitrum: it has always meant "the mainnet RPC".

## Rollout

1. In Vercel (Production + Preview) add `RPC_URL_1`, `RPC_URL_8453`, `RPC_URL_42161` with a key that has **no** domain
   allowlist (scope the app to the three networks). Mark them Sensitive — they are server-only, so inlining is not needed.
2. Redeploy. Each serverless instance logs one line per chain on its first RPC resolution:
   `rpc: chain=<id> source=<ENV_NAME>` — `source=RPC_URL_<id>` confirms the split; `NEXT_PUBLIC_*` or `public-default`
   means the server is still on the old path.
3. Only then enable the allowlist on the browser key.

Unset is safe: behaviour is identical to before the split. `validateEnv()` warns (one line, naming the fallback) for each
unset `RPC_URL_<id>`.

## Rollback

Unset `RPC_URL_<id>` and redeploy; the server falls back to the browser env.

## Not covered

The keeper / executor host reads its own `RPC_URL` (see `EC2-EXECUTOR-HOST.md`, `EXECUTOR-OPERATIONS.md`) — a separate
process, unaffected. Browser polling (`wagmiConfig.ts`) is unchanged.
