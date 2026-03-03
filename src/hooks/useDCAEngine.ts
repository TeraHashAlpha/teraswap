'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from 'wagmi'
import {
  type DCAPosition,
  type DCAEvent,
  type DCAToken,
  type SmartWindowSnapshot,
} from '@/lib/dca-types'
import {
  loadFromStorage,
  getAllPositions,
  createPosition as engineCreate,
  pausePosition as enginePause,
  resumePosition as engineResume,
  cancelPosition as engineCancel,
  subscribe,
  registerWalletCallbacks,
  startGlobalTick as _startTick,
  stopGlobalTick,
  getActiveSnapshots,
} from '@/lib/dca-engine'

// Re-export startGlobalTick so it's accessible if needed
export { stopGlobalTick }

export interface UseDCAEngineReturn {
  positions: DCAPosition[]
  activeSnapshots: SmartWindowSnapshot[]
  latestEvent: DCAEvent | null
  createPosition: (
    tokenIn: DCAToken,
    tokenOut: DCAToken,
    totalAmount: string,
    numberOfParts: number,
    intervalMs: number,
    slippage?: number,
  ) => DCAPosition
  pausePosition: (id: string) => void
  resumePosition: (id: string) => void
  cancelPosition: (id: string) => void
  isReady: boolean
}

export function useDCAEngine(): UseDCAEngineReturn {
  const [positions, setPositions] = useState<DCAPosition[]>([])
  const [activeSnapshots, setActiveSnapshots] = useState<SmartWindowSnapshot[]>([])
  const [latestEvent, setLatestEvent] = useState<DCAEvent | null>(null)
  const [isReady, setIsReady] = useState(false)

  const { address } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()

  // Ref for latest address (avoids stale closures)
  const addressRef = useRef(address)
  addressRef.current = address

  // Ref for sendTransactionAsync
  const sendTxRef = useRef(sendTransactionAsync)
  sendTxRef.current = sendTransactionAsync

  // Initialize engine on mount
  useEffect(() => {
    loadFromStorage()
    setPositions([...getAllPositions()])
    setIsReady(true)

    // Register wallet callbacks for the DCA engine
    registerWalletCallbacks({
      sendTransaction: async (params) => {
        const fn = sendTxRef.current
        if (!fn) throw new Error('Wallet not connected')

        const hash = await fn({
          to: params.to,
          data: params.data,
          value: BigInt(params.value || '0'),
          gas: BigInt(params.gas || 300_000),
        })
        return hash
      },
      signCowOrder: async (_params) => {
        // CoW signing handled separately via useSwap hook pattern
        // For now, throw — DCA execution will use standard swaps
        throw new Error('CoW order signing not yet supported in DCA mode')
      },
      getUserAddress: () => addressRef.current,
    })

    // Subscribe to engine events
    const unsub = subscribe((event: DCAEvent) => {
      setLatestEvent(event)
      setPositions([...getAllPositions()])
      setActiveSnapshots(getActiveSnapshots())
    })

    // Start checking windows
    _startTick()

    // Refresh snapshots periodically
    const snapshotTimer = setInterval(() => {
      setActiveSnapshots(getActiveSnapshots())
    }, 5000)

    return () => {
      unsub()
      clearInterval(snapshotTimer)
      // Don't stop global tick — it should keep running
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const createPosition = useCallback(
    (
      tokenIn: DCAToken,
      tokenOut: DCAToken,
      totalAmount: string,
      numberOfParts: number,
      intervalMs: number,
      slippage?: number,
    ) => {
      const pos = engineCreate(tokenIn, tokenOut, totalAmount, numberOfParts, intervalMs, slippage)
      setPositions([...getAllPositions()])
      return pos
    },
    [],
  )

  const pausePosition = useCallback((id: string) => {
    enginePause(id)
    setPositions([...getAllPositions()])
  }, [])

  const resumePosition = useCallback((id: string) => {
    engineResume(id)
    setPositions([...getAllPositions()])
  }, [])

  const cancelPosition = useCallback((id: string) => {
    engineCancel(id)
    setPositions([...getAllPositions()])
  }, [])

  return {
    positions,
    activeSnapshots,
    latestEvent,
    createPosition,
    pausePosition,
    resumePosition,
    cancelPosition,
    isReady,
  }
}
