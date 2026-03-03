import { create } from 'zustand'

export interface SwapRecord {
  id: string
  date: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  txHash: string
  status: 'pending' | 'confirmed' | 'failed'
}

interface SwapHistoryStore {
  records: SwapRecord[]
  addRecord: (record: SwapRecord) => void
  updateStatus: (txHash: string, status: SwapRecord['status']) => void
}

// Zustand store com persistência em memória (localStorage no MVP)
export const useSwapHistory = create<SwapHistoryStore>((set) => ({
  records: [],
  addRecord: (record) =>
    set((state) => ({
      records: [record, ...state.records].slice(0, 50), // max 50 registos
    })),
  updateStatus: (txHash, status) =>
    set((state) => ({
      records: state.records.map((r) => (r.txHash === txHash ? { ...r, status } : r)),
    })),
}))
