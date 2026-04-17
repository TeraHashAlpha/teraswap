# Analyze Transaction

You are performing forensic analysis on Ethereum transaction `{{TX_HASH}}`.

## Instructions

Follow the 5-step procedure defined in `skills/tx-analyzer/SKILL.md`. Execute each step sequentially, collecting data before drawing conclusions.

### Step 1: Fetch transaction data

Use `cast` if available, otherwise fall back to curl + JSON-RPC.

```bash
# Set RPC (prefer env var, fall back to public)
RPC_URL="${RPC_URL:-https://eth.llamarpc.com}"
TX_HASH="{{TX_HASH}}"

# Transaction object
cast tx $TX_HASH --rpc-url $RPC_URL

# Receipt (logs, status, gas)
cast receipt $TX_HASH --rpc-url $RPC_URL

# Internal traces (requires archive node — OK if this fails)
cast run $TX_HASH --rpc-url $RPC_URL 2>/dev/null || echo "Trace unavailable"
```

### Step 2: Decode the transaction

1. Check the `to` address against the known addresses in SKILL.md
2. If it matches a TeraSwap contract, decode calldata using the ABI files in `skills/tx-analyzer/abis/`:
   - **OrderExecutor** (`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`): use `TeraSwapOrderExecutor.json`
   - **FeeCollector** (`0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`): use `TeraSwapFeeCollector.json`
3. Decode the 4-byte function selector:
   ```bash
   cast sig $(echo $CALLDATA | cut -c1-10)
   ```
4. Decode all event logs — match `topics[0]` against `common-defi.json` topic0 quick reference

### Step 3: Map fund flows

For every `Transfer` event (topic0 = `0xddf252ad...`):
- `from` = `topics[1]` (right-padded address)
- `to` = `topics[2]` (right-padded address)
- `value` = `data` (uint256)
- `token` = log `address` field

Also track:
- ETH value transfers (tx.value + internal transactions)
- WETH Deposit/Withdrawal events
- Fee deductions (SwapWithFee events)

Build the fund flow table and Mermaid diagram as specified in SKILL.md.

### Step 4: Identify anomalies

Check every pattern listed in SKILL.md Step 4. For each:
- **Found**: describe what was detected, with evidence (log index, address, amount)
- **Not found**: skip silently (don't list negatives unless specifically asked)

Priority order for reporting:
1. Critical anomalies (unexpected recipient, ownership transfer, executor change, reentrancy)
2. Warning anomalies (flash loan, price manipulation, approval chains, selfdestruct, delegatecall)
3. Info observations (multi-hop routing, WETH wrap/unwrap, Permit2)

### Step 5: Generate report

Output the report in the exact format from SKILL.md Step 5. Include:
- Summary block with status, block, from/to, value, gas
- Decoded function call with key parameters
- Fund flow table
- Decoded event log
- Anomalies with severity tags
- Risk assessment with recommendation

## Context clues

If this transaction was flagged by a specific system, factor that into the analysis:
- **P47 on-chain monitor**: check which event triggered the alert — focus on that event type
- **P45 post-execution validator**: the concern is output amount — focus on fund flows and recipient verification
- **Manual investigation**: perform full analysis without bias

## Output format

Use markdown. Be precise with addresses and amounts. Label every address using the known addresses table. For unknown addresses, note them as `Unknown (0x...)` and suggest checking Etherscan labels.

Do NOT speculate beyond what the data shows. If trace data is unavailable, note the limitation and work with receipt data only.
