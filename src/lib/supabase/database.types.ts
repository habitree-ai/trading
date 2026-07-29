/**
 * DB 타입 — Supabase 프로젝트에서 생성한 것. 손으로 고치지 말 것.
 *
 * 스키마를 바꾼 뒤에는 재생성한다:
 *   npx supabase gen types typescript --project-id iwdjhrecujchauavpnja > src/lib/supabase/database.types.ts
 *
 * 앱이 쓰는 도메인 모델은 `@/lib/domain`에 있고, 이 파일의 Row 타입과 구조가 같다.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      balance_snapshots: {
        Row: {
          at: string
          book_id: string
          equity: number
          id: string
          image_id: string | null
          source: string
          user_id: string
        }
        Insert: {
          at: string
          book_id: string
          equity: number
          id?: string
          image_id?: string | null
          source?: string
          user_id: string
        }
        Update: {
          at?: string
          book_id?: string
          equity?: number
          id?: string
          image_id?: string | null
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "balance_snapshots_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "balance_snapshots_image_id_fkey"
            columns: ["image_id"]
            isOneToOne: false
            referencedRelation: "trade_images"
            referencedColumns: ["id"]
          },
        ]
      }
      books: {
        Row: {
          base_currency: string
          created_at: string
          exchange: string | null
          id: string
          initial_capital: number
          memo: string | null
          name: string
          okx_sync_enabled: boolean
          start_date: string
          status: Database["public"]["Enums"]["book_status"]
          user_id: string
        }
        Insert: {
          base_currency?: string
          created_at?: string
          exchange?: string | null
          id?: string
          initial_capital?: number
          memo?: string | null
          name: string
          okx_sync_enabled?: boolean
          start_date?: string
          status?: Database["public"]["Enums"]["book_status"]
          user_id: string
        }
        Update: {
          base_currency?: string
          created_at?: string
          exchange?: string | null
          id?: string
          initial_capital?: number
          memo?: string | null
          name?: string
          okx_sync_enabled?: boolean
          start_date?: string
          status?: Database["public"]["Enums"]["book_status"]
          user_id?: string
        }
        Relationships: []
      }
      goals: {
        Row: {
          book_id: string
          id: string
          metric: Database["public"]["Enums"]["goal_metric"]
          period: Database["public"]["Enums"]["goal_period"]
          target_value: number
          tier: Database["public"]["Enums"]["goal_tier"]
          user_id: string
        }
        Insert: {
          book_id: string
          id?: string
          metric: Database["public"]["Enums"]["goal_metric"]
          period: Database["public"]["Enums"]["goal_period"]
          target_value: number
          tier: Database["public"]["Enums"]["goal_tier"]
          user_id: string
        }
        Update: {
          book_id?: string
          id?: string
          metric?: Database["public"]["Enums"]["goal_metric"]
          period?: Database["public"]["Enums"]["goal_period"]
          target_value?: number
          tier?: Database["public"]["Enums"]["goal_tier"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          book_id: string
          cursor_at: string | null
          error: string | null
          fills_added: number
          finished_at: string | null
          id: string
          source: string
          started_at: string
          trades_added: number
          user_id: string
        }
        Insert: {
          book_id: string
          cursor_at?: string | null
          error?: string | null
          fills_added?: number
          finished_at?: string | null
          id?: string
          source?: string
          started_at?: string
          trades_added?: number
          user_id: string
        }
        Update: {
          book_id?: string
          cursor_at?: string | null
          error?: string | null
          fills_added?: number
          finished_at?: string | null
          id?: string
          source?: string
          started_at?: string
          trades_added?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_fills: {
        Row: {
          amount: number | null
          created_at: string
          fee: number | null
          filled_at: string
          id: string
          okx_bill_id: string | null
          order_no: string | null
          price: number
          role: Database["public"]["Enums"]["fill_role"]
          trade_id: string
          user_id: string
        }
        Insert: {
          amount?: number | null
          created_at?: string
          fee?: number | null
          filled_at: string
          id?: string
          okx_bill_id?: string | null
          order_no?: string | null
          price: number
          role: Database["public"]["Enums"]["fill_role"]
          trade_id: string
          user_id: string
        }
        Update: {
          amount?: number | null
          created_at?: string
          fee?: number | null
          filled_at?: string
          id?: string
          okx_bill_id?: string | null
          order_no?: string | null
          price?: number
          role?: Database["public"]["Enums"]["fill_role"]
          trade_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_fills_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_images: {
        Row: {
          confidence: number | null
          created_at: string
          engine: Database["public"]["Enums"]["extract_engine"]
          extracted: Json | null
          id: string
          kind: Database["public"]["Enums"]["capture_kind"]
          ocr_raw: string | null
          storage_path: string
          trade_id: string | null
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          engine?: Database["public"]["Enums"]["extract_engine"]
          extracted?: Json | null
          id?: string
          kind: Database["public"]["Enums"]["capture_kind"]
          ocr_raw?: string | null
          storage_path: string
          trade_id?: string | null
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          engine?: Database["public"]["Enums"]["extract_engine"]
          extracted?: Json | null
          id?: string
          kind?: Database["public"]["Enums"]["capture_kind"]
          ocr_raw?: string | null
          storage_path?: string
          trade_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_images_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          book_id: string
          created_at: string
          emotion: string | null
          entry_at: string
          entry_price: number | null
          equity_after: number | null
          equity_before: number | null
          exit_at: string | null
          exit_price: number | null
          fee: number | null
          funding_fee: number | null
          id: string
          leverage: number | null
          margin_mode: Database["public"]["Enums"]["margin_mode"] | null
          note: string | null
          notional: number | null
          okx_pos_id: string | null
          pnl: number | null
          rationale: string | null
          result: Database["public"]["Enums"]["trade_result"]
          review: string | null
          seq: number
          setup: string | null
          side: Database["public"]["Enums"]["trade_side"]
          stop_price: number | null
          symbol: string
          tp1_price: number | null
          tp2_price: number | null
          tp3_price: number | null
          updated_at: string
          user_id: string
          withdrawal: number | null
        }
        Insert: {
          book_id: string
          created_at?: string
          emotion?: string | null
          entry_at: string
          entry_price?: number | null
          equity_after?: number | null
          equity_before?: number | null
          exit_at?: string | null
          exit_price?: number | null
          fee?: number | null
          funding_fee?: number | null
          id?: string
          leverage?: number | null
          margin_mode?: Database["public"]["Enums"]["margin_mode"] | null
          note?: string | null
          notional?: number | null
          okx_pos_id?: string | null
          pnl?: number | null
          rationale?: string | null
          result?: Database["public"]["Enums"]["trade_result"]
          review?: string | null
          seq: number
          setup?: string | null
          side: Database["public"]["Enums"]["trade_side"]
          stop_price?: number | null
          symbol: string
          tp1_price?: number | null
          tp2_price?: number | null
          tp3_price?: number | null
          updated_at?: string
          user_id: string
          withdrawal?: number | null
        }
        Update: {
          book_id?: string
          created_at?: string
          emotion?: string | null
          entry_at?: string
          entry_price?: number | null
          equity_after?: number | null
          equity_before?: number | null
          exit_at?: string | null
          exit_price?: number | null
          fee?: number | null
          funding_fee?: number | null
          id?: string
          leverage?: number | null
          margin_mode?: Database["public"]["Enums"]["margin_mode"] | null
          note?: string | null
          notional?: number | null
          okx_pos_id?: string | null
          pnl?: number | null
          rationale?: string | null
          result?: Database["public"]["Enums"]["trade_result"]
          review?: string | null
          seq?: number
          setup?: string | null
          side?: Database["public"]["Enums"]["trade_side"]
          stop_price?: number | null
          symbol?: string
          tp1_price?: number | null
          tp2_price?: number | null
          tp3_price?: number | null
          updated_at?: string
          user_id?: string
          withdrawal?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      book_status: "active" | "closed"
      capture_kind: "position" | "chart" | "balance"
      extract_engine: "ocr" | "ai" | "manual"
      fill_role: "open" | "close"
      margin_mode: "cross" | "isolated"
      goal_metric:
        | "return_pct"
        | "max_drawdown_pct"
        | "win_rate"
        | "expectancy"
        | "risk_per_trade_pct"
        | "trade_count"
      goal_period: "week" | "month" | "year"
      goal_tier: "beta" | "alpha"
      trade_result: "win" | "loss" | "be" | "open"
      trade_side: "long" | "short"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      book_status: ["active", "closed"],
      capture_kind: ["position", "chart", "balance"],
      extract_engine: ["ocr", "ai", "manual"],
      fill_role: ["open", "close"],
      goal_metric: [
        "return_pct",
        "max_drawdown_pct",
        "win_rate",
        "expectancy",
        "risk_per_trade_pct",
        "trade_count",
      ],
      margin_mode: ["cross", "isolated"],
      goal_period: ["week", "month", "year"],
      goal_tier: ["beta", "alpha"],
      trade_result: ["win", "loss", "be", "open"],
      trade_side: ["long", "short"],
    },
  },
} as const
