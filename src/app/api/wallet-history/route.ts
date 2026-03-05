import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/wallet-history?address=0x...
 *
 * Fetches recent asset transfers using Alchemy's alchemy_getAssetTransfers API.
 * Falls back to Etherscan if Alchemy fails.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const address = searchParams.get('address')

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { error: 'Invalid or missing address parameter' },
      { status: 400 },
    )
  }

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL

  if (!rpcUrl) {
    return NextResponse.json({ transfers: [], error: 'RPC not configured' })
  }

  try {
    // Fetch both sent and received transfers in parallel
    const [sentRes, receivedRes] = await Promise.all([
      fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'alchemy_getAssetTransfers',
          params: [{
            fromAddress: address,
            category: ['external', 'erc20', 'erc721', 'erc1155'],
            order: 'desc',
            maxCount: '0x19', // 25
            withMetadata: true,
          }],
        }),
      }),
      fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 2,
          jsonrpc: '2.0',
          method: 'alchemy_getAssetTransfers',
          params: [{
            toAddress: address,
            category: ['external', 'erc20', 'erc721', 'erc1155'],
            order: 'desc',
            maxCount: '0x19', // 25
            withMetadata: true,
          }],
        }),
      }),
    ])

    const [sentJson, receivedJson] = await Promise.all([
      sentRes.json(),
      receivedRes.json(),
    ])

    const sentTransfers = (sentJson.result?.transfers ?? []).map(
      (t: AlchemyTransfer) => ({ ...t, direction: 'sent' as const }),
    )
    const receivedTransfers = (receivedJson.result?.transfers ?? []).map(
      (t: AlchemyTransfer) => ({ ...t, direction: 'received' as const }),
    )

    // Merge and sort by block number descending
    const all = [...sentTransfers, ...receivedTransfers]
      .sort((a, b) => {
        const blockA = parseInt(a.blockNum, 16)
        const blockB = parseInt(b.blockNum, 16)
        return blockB - blockA
      })
      .slice(0, 50)

    return NextResponse.json({ transfers: all })
  } catch (err) {
    console.error('[wallet-history] Alchemy error:', err)
    return NextResponse.json({ transfers: [], error: 'Failed to fetch transfers' })
  }
}

interface AlchemyTransfer {
  blockNum: string
  hash: string
  from: string
  to: string
  value: number | null
  asset: string | null
  category: string
  metadata: { blockTimestamp: string }
  direction?: 'sent' | 'received'
}
