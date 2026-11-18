# RPC environment variables (server vs browser)

Introduced by `feat/server-rpc-env-split`. Resolver: `src/lib/rpc-env.ts`. Names only below — never paste a URL
(provider keys live in the URL path).

## Why two keys

The browser key (`NEXT_PUBLIC_*`) is shipped to every visitor, so it gets an Alchemy **domain allowlist**. A
server request has no `Origin`, and the allowlist rejects it ("Unspecified origin not on whitelist", seen
29–30 Oct). The server therefore needs its own, **un-allowlisted** key in `RPC_URL_<chainId>`.

## Resolution order

| Chain | Server (first non-empty wins) — also the `/api/rpc` upstream | Browser |
|---|---|---|
| 1 Ethereum | `RPC_URL_1` → `RPC_URL` (legacy, mainnet only) → public default | `/api/rpc` |
| 8453 Base | `RPC_URL_8453` → `NEXT_PUBLIC_BASE_RPC_URL` (deprecated) → registry public fallback | `/api/rpc?chainId=8453` |
| 42161 Arbitrum | `RPC_URL_42161` → `NEXT_PUBLIC_ARBITRUM_RPC_URL` (deprecated) → registry public fallback | `/api/rpc?chainId=42161` |

`RPC_URL` is never consulted for Base/Arbitrum: it has always meant "the mainnet RPC".

### Browser reads all go through `/api/rpc` (`fix/user-ip-privacy`)

The browser no longer dials a provider on any chain: wagmi transports and `chains/clients.ts` use the same-origin
proxy, whose upstream is the **server** column above. Consequences:

- `RPC_URL_8453` / `RPC_URL_42161` now carry **every** Base / Arbitrum read. Set them before this ships: with them
  unset the proxy falls back to the deprecated `NEXT_PUBLIC_*` key (rejected server-side once that key has a domain
  allowlist) and then to the public endpoint (rate-limited).
- `NEXT_PUBLIC_BASE_RPC_URL` / `NEXT_PUBLIC_ARBITRUM_RPC_URL` are **deprecated**: read on the server only, through a
  computed lookup, so their value is no longer inlined into the client bundle. Once `rpc: chain=<id>
  source=RPC_URL_<id>` shows in the logs for 8453 and 42161, delete both names in Vercel.
- `NEXT_PUBLIC_RPC_URL` (mainnet) was still inlined into the bundle by `wagmiConfig.ts` / `chains/registry.ts`
  although the browser never called it. Fixed by `fix/mainnet-rpc-out-of-client` (below).

### Mainnet browser names retired (`fix/mainnet-rpc-out-of-client`, SEC-5)

`chains/registry.ts` read `NEXT_PUBLIC_RPC_URL` with a literal member access in a module the browser reaches, so its
value (a provider URL with its key) was inlined into a client chunk. No code reads `NEXT_PUBLIC_RPC_URL`,
`NEXT_PUBLIC_FALLBACK_RPC_1` or `NEXT_PUBLIC_FALLBACK_RPC_2` any more: the browser reads mainnet through `/api/rpc`
exactly as before, the server through `RPC_URL_1` → `RPC_URL` → public default, and the two FALLBACK names (they fed
only the server-side wagmi transport) are gone with it. A unit guard (`next-public-rpc-reads.guard.test.ts`) and the
CI bundle check (`third-party-hosts` job, marker values for all three names) keep it that way.

After the deploy (owner, in Vercel):

1. Confirm `RPC_URL_1` is set in Production and Preview, and that the logs show `rpc: chain=1 source=RPC_URL_1`.
2. **Rotate the provider key** that was in `NEXT_PUBLIC_RPC_URL`: it was in a public client chunk, so treat it as
   disclosed. Revoking it changes nothing on the site once step 1 holds.
3. Delete `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_FALLBACK_RPC_1`, `NEXT_PUBLIC_FALLBACK_RPC_2` in every environment.

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

Unset `RPC_URL_<id>` and redeploy; the server falls back to the browser env on Base/Arbitrum. On mainnet it falls back
to `RPC_URL`, then the public default (SEC-5: there is no mainnet browser env to fall back to).

## Not covered

The keeper / executor host reads its own `RPC_URL` (see `EC2-EXECUTOR-HOST.md`, `EXECUTOR-OPERATIONS.md`) — a separate
process, unaffected. Browser polling cadence (`wagmiConfig.ts`, `rpc-polling.ts`) is unchanged; only where the
reads are sent changed.
