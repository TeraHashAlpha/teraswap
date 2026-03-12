/**
 * Supabase Database type definitions for TeraSwap analytics.
 *
 * These types mirror the SQL schema in supabase/schema.sql.
 * Regenerate with `supabase gen types typescript` after schema changes.
 */

export interface Database {
  public: {
    Tables: {
      swaps: {
        Row: {
          id: string
          created_at: string
          wallet: string
          tx_hash: string | null
          chain_id: number
          source: string
          token_in: string
          token_in_symbol: string
          token_out: string
          token_out_symbol: string
          amount_in: string
          amount_out: string
          amount_in_usd: number | null
          amount_out_usd: number | null
          slippage: number
          fee_collected: boolean
          fee_amount: string | null
          gas_used: string | null
          gas_price: string | null
          status: 'pending' | 'confirmed' | 'failed'
          mev_protected: boolean
        }
        Insert: Omit<Database['public']['Tables']['swaps']['Row'], 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['swaps']['Insert']>
      }
      quotes: {
        Row: {
          id: string
          created_at: string
          token_in: string
          token_in_symbol: string
          token_out: string
          token_out_symbol: string
          amount_in: string
          sources_queried: string[]
          sources_responded: string[]
          best_source: string | null
          best_amount_out: string | null
          all_quotes: Record<string, string> | null
          response_time_ms: number
          wallet: string | null
        }
        Insert: Omit<Database['public']['Tables']['quotes']['Row'], 'id' | 'created_at'> & {
          id?: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['quotes']['Insert']>
      }
      security_events: {
        Row: {
          id: string
          type: string
          severity: 'info' | 'warn' | 'critical'
          timestamp: string
          wallet: string | null
          token_in: string | null
          token_out: string | null
          amount_usd: number | null
          deviation: number | null
          source: string | null
          message: string
          metadata: Record<string, unknown> | null
        }
        Insert: Omit<Database['public']['Tables']['security_events']['Row'], 'timestamp'> & {
          timestamp?: string
        }
        Update: Partial<Database['public']['Tables']['security_events']['Insert']>
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
