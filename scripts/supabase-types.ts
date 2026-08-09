export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// Generated with `supabase gen types typescript --linked`, then TRIMMED to the
// relations this job reads or writes.
//
// The full control-room schema is not published here — a type file is
// documentation, and table names alone can disclose more than intended.
// Keeping this narrow is a privacy boundary, not tidiness: regenerate with the
// command above and re-trim to what this job touches, never paste the whole
// output.

export type Database = {
  public: {
    Tables: {
      article_daily_snapshots: {
        Row: {
          comments: number | null
          created_at: string
          external_id: string
          id: string
          ingest_run_id: string | null
          observed_on: string
          reactions: number | null
          source: string
          views: number | null
        }
        Insert: {
          comments?: number | null
          created_at?: string
          external_id: string
          id?: string
          ingest_run_id?: string | null
          observed_on: string
          reactions?: number | null
          source?: string
          views?: number | null
        }
        Update: {
          comments?: number | null
          created_at?: string
          external_id?: string
          id?: string
          ingest_run_id?: string | null
          observed_on?: string
          reactions?: number | null
          source?: string
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "article_daily_snapshots_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      coverage_snapshots: {
        Row: {
          coverage_pct: number | null
          covered_lines: number | null
          id: number
          ingest_run_id: string | null
          observed_on: string
          plugin_id: number
          status: string | null
          total_lines: number | null
        }
        Insert: {
          coverage_pct?: number | null
          covered_lines?: number | null
          id?: number
          ingest_run_id?: string | null
          observed_on: string
          plugin_id: number
          status?: string | null
          total_lines?: number | null
        }
        Update: {
          coverage_pct?: number | null
          covered_lines?: number | null
          id?: number
          ingest_run_id?: string | null
          observed_on?: string
          plugin_id?: number
          status?: string | null
          total_lines?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "coverage_snapshots_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coverage_snapshots_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "plugins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coverage_snapshots_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_coverage_latest"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "coverage_snapshots_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_daily"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "coverage_snapshots_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_latest"
            referencedColumns: ["plugin_id"]
          },
        ]
      }
      creator_daily_metrics: {
        Row: {
          comments_delta: number | null
          commits_delta: number | null
          contributions_delta: number | null
          creator: string
          followers: number | null
          followers_delta: number | null
          id: number
          ingest_run_id: string | null
          observed_on: string
          platform: string
          posts: number | null
          reactions_delta: number | null
          total_comments: number | null
          total_commits: number | null
          total_contributions: number | null
          total_reactions: number | null
          total_views: number | null
          views_delta: number | null
        }
        Insert: {
          comments_delta?: number | null
          commits_delta?: number | null
          contributions_delta?: number | null
          creator: string
          followers?: number | null
          followers_delta?: number | null
          id?: number
          ingest_run_id?: string | null
          observed_on: string
          platform: string
          posts?: number | null
          reactions_delta?: number | null
          total_comments?: number | null
          total_commits?: number | null
          total_contributions?: number | null
          total_reactions?: number | null
          total_views?: number | null
          views_delta?: number | null
        }
        Update: {
          comments_delta?: number | null
          commits_delta?: number | null
          contributions_delta?: number | null
          creator?: string
          followers?: number | null
          followers_delta?: number | null
          id?: number
          ingest_run_id?: string | null
          observed_on?: string
          platform?: string
          posts?: number | null
          reactions_delta?: number | null
          total_comments?: number | null
          total_commits?: number | null
          total_contributions?: number | null
          total_reactions?: number | null
          total_views?: number | null
          views_delta?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "creator_daily_metrics_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      ecosystem_daily_metrics: {
        Row: {
          covered_lines: number | null
          daily_npm_downloads: number | null
          id: number
          ingest_run_id: string | null
          missed_lines: number | null
          observed_on: string
          owasp_coverage: number | null
          partial_lines: number | null
          test_coverage: number | null
          total_lines: number | null
          total_npm_downloads: number | null
          total_packages: number | null
          total_plugins: number | null
          total_rules: number | null
        }
        Insert: {
          covered_lines?: number | null
          daily_npm_downloads?: number | null
          id?: number
          ingest_run_id?: string | null
          missed_lines?: number | null
          observed_on: string
          owasp_coverage?: number | null
          partial_lines?: number | null
          test_coverage?: number | null
          total_lines?: number | null
          total_npm_downloads?: number | null
          total_packages?: number | null
          total_plugins?: number | null
          total_rules?: number | null
        }
        Update: {
          covered_lines?: number | null
          daily_npm_downloads?: number | null
          id?: number
          ingest_run_id?: string | null
          missed_lines?: number | null
          observed_on?: string
          owasp_coverage?: number | null
          partial_lines?: number | null
          test_coverage?: number | null
          total_lines?: number | null
          total_npm_downloads?: number | null
          total_packages?: number | null
          total_plugins?: number | null
          total_rules?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ecosystem_daily_metrics_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      external_articles: {
        Row: {
          author: string | null
          description: string | null
          external_id: string
          fetched_at: string
          id: number
          payload: Json
          published_at: string | null
          slug: string | null
          source: string
          title: string | null
          url: string | null
        }
        Insert: {
          author?: string | null
          description?: string | null
          external_id: string
          fetched_at?: string
          id?: number
          payload: Json
          published_at?: string | null
          slug?: string | null
          source: string
          title?: string | null
          url?: string | null
        }
        Update: {
          author?: string | null
          description?: string | null
          external_id?: string
          fetched_at?: string
          id?: number
          payload?: Json
          published_at?: string | null
          slug?: string | null
          source?: string
          title?: string | null
          url?: string | null
        }
        Relationships: []
      }
      external_tweets: {
        Row: {
          fetched_at: string
          id: number
          payload: Json
          photo_url: string | null
          tweet_id: string
        }
        Insert: {
          fetched_at?: string
          id?: number
          payload: Json
          photo_url?: string | null
          tweet_id: string
        }
        Update: {
          fetched_at?: string
          id?: number
          payload?: Json
          photo_url?: string | null
          tweet_id?: string
        }
        Relationships: []
      }
      ingest_runs: {
        Row: {
          error_message: string | null
          finished_at: string | null
          gha_run_url: string | null
          id: string
          rows_written: number | null
          started_at: string
          status: string
          workflow: string
        }
        Insert: {
          error_message?: string | null
          finished_at?: string | null
          gha_run_url?: string | null
          id?: string
          rows_written?: number | null
          started_at?: string
          status: string
          workflow: string
        }
        Update: {
          error_message?: string | null
          finished_at?: string | null
          gha_run_url?: string | null
          id?: string
          rows_written?: number | null
          started_at?: string
          status?: string
          workflow?: string
        }
        Relationships: []
      }
      metric_snapshots: {
        Row: {
          dimension: string
          id: number
          ingest_run_id: string | null
          kind: string
          observed_on: string
          payload: Json | null
          source: string
          value: number | null
        }
        Insert: {
          dimension?: string
          id?: number
          ingest_run_id?: string | null
          kind: string
          observed_on: string
          payload?: Json | null
          source: string
          value?: number | null
        }
        Update: {
          dimension?: string
          id?: number
          ingest_run_id?: string | null
          kind?: string
          observed_on?: string
          payload?: Json | null
          source?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "metric_snapshots_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      npm_alltime_downloads: {
        Row: {
          alltime_total: number
          ingest_run_id: string | null
          measured_on: string
          plugin_id: number
        }
        Insert: {
          alltime_total: number
          ingest_run_id?: string | null
          measured_on?: string
          plugin_id: number
        }
        Update: {
          alltime_total?: number
          ingest_run_id?: string | null
          measured_on?: string
          plugin_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "npm_alltime_downloads_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "npm_alltime_downloads_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: true
            referencedRelation: "plugins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "npm_alltime_downloads_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: true
            referencedRelation: "v_coverage_latest"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "npm_alltime_downloads_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: true
            referencedRelation: "v_plugin_daily"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "npm_alltime_downloads_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: true
            referencedRelation: "v_plugin_latest"
            referencedColumns: ["plugin_id"]
          },
        ]
      }
      plugin_daily_metrics: {
        Row: {
          github_forks: number | null
          github_stars: number | null
          id: number
          ingest_run_id: string | null
          npm_downloads_d1: number | null
          npm_downloads_d30: number | null
          npm_downloads_d7: number | null
          npm_version: string | null
          observed_on: string
          plugin_id: number
          published: boolean | null
          rule_count: number | null
        }
        Insert: {
          github_forks?: number | null
          github_stars?: number | null
          id?: number
          ingest_run_id?: string | null
          npm_downloads_d1?: number | null
          npm_downloads_d30?: number | null
          npm_downloads_d7?: number | null
          npm_version?: string | null
          observed_on: string
          plugin_id: number
          published?: boolean | null
          rule_count?: number | null
        }
        Update: {
          github_forks?: number | null
          github_stars?: number | null
          id?: number
          ingest_run_id?: string | null
          npm_downloads_d1?: number | null
          npm_downloads_d30?: number | null
          npm_downloads_d7?: number | null
          npm_version?: string | null
          observed_on?: string
          plugin_id?: number
          published?: boolean | null
          rule_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plugin_daily_metrics_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plugin_daily_metrics_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "plugins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plugin_daily_metrics_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_coverage_latest"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "plugin_daily_metrics_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_daily"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "plugin_daily_metrics_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_latest"
            referencedColumns: ["plugin_id"]
          },
        ]
      }
      plugin_dependents: {
        Row: {
          created_at: string
          dependent_count: number | null
          id: string
          ingest_run_id: string | null
          observed_on: string
          plugin_id: number
        }
        Insert: {
          created_at?: string
          dependent_count?: number | null
          id?: string
          ingest_run_id?: string | null
          observed_on: string
          plugin_id: number
        }
        Update: {
          created_at?: string
          dependent_count?: number | null
          id?: string
          ingest_run_id?: string | null
          observed_on?: string
          plugin_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "plugin_dependents_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plugin_dependents_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "plugins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plugin_dependents_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_coverage_latest"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "plugin_dependents_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_daily"
            referencedColumns: ["plugin_id"]
          },
          {
            foreignKeyName: "plugin_dependents_plugin_id_fkey"
            columns: ["plugin_id"]
            isOneToOne: false
            referencedRelation: "v_plugin_latest"
            referencedColumns: ["plugin_id"]
          },
        ]
      }
      plugins: {
        Row: {
          category: string
          created_at: string
          deprecated: boolean
          description: string | null
          id: number
          name: string
          slug: string
        }
        Insert: {
          category: string
          created_at?: string
          deprecated?: boolean
          description?: string | null
          id?: number
          name: string
          slug: string
        }
        Update: {
          category?: string
          created_at?: string
          deprecated?: boolean
          description?: string | null
          id?: number
          name?: string
          slug?: string
        }
        Relationships: []
      }
      ratchet_history: {
        Row: {
          bucket: string
          current_value: number
          id: number
          kind: string
          observed_on: string
        }
        Insert: {
          bucket: string
          current_value: number
          id?: number
          kind: string
          observed_on: string
        }
        Update: {
          bucket?: string
          current_value?: number
          id?: number
          kind?: string
          observed_on?: string
        }
        Relationships: []
      }
      storefront_ratchet: {
        Row: {
          bucket: string
          current_value: number
          description: string | null
          display_icon: string | null
          display_label: string
          display_order: number
          display_unit: string | null
          kind: string
          provenance_url: string | null
          source_kinds: Json
          updated_at: string
          weight: number
        }
        Insert: {
          bucket: string
          current_value?: number
          description?: string | null
          display_icon?: string | null
          display_label: string
          display_order?: number
          display_unit?: string | null
          kind: string
          provenance_url?: string | null
          source_kinds?: Json
          updated_at?: string
          weight?: number
        }
        Update: {
          bucket?: string
          current_value?: number
          description?: string | null
          display_icon?: string | null
          display_label?: string
          display_order?: number
          display_unit?: string | null
          kind?: string
          provenance_url?: string | null
          source_kinds?: Json
          updated_at?: string
          weight?: number
        }
        Relationships: []
      }
    }
    Views: {
      v_ecosystem_latest: {
        Row: {
          covered_lines: number | null
          daily_npm_downloads: number | null
          missed_lines: number | null
          observed_on: string | null
          owasp_coverage: number | null
          partial_lines: number | null
          test_coverage: number | null
          total_lines: number | null
          total_npm_downloads: number | null
          total_packages: number | null
          total_plugins: number | null
          total_rules: number | null
        }
        Relationships: []
      }
      v_npm_alltime_ecosystem: {
        Row: {
          ecosystem_alltime: number | null
          last_measured_on: string | null
          packages_measured: number | null
        }
        Relationships: []
      }
      v_plugin_daily: {
        Row: {
          category: string | null
          description: string | null
          name: string | null
          npm_downloads_d1: number | null
          npm_downloads_d30: number | null
          npm_downloads_d7: number | null
          observed_on: string | null
          plugin_id: number | null
          slug: string | null
        }
        Relationships: []
      }
      v_plugin_latest: {
        Row: {
          category: string | null
          description: string | null
          github_forks: number | null
          github_stars: number | null
          name: string | null
          npm_downloads_d1: number | null
          npm_downloads_d30: number | null
          npm_downloads_d7: number | null
          npm_version: string | null
          observed_on: string | null
          plugin_id: number | null
          published: boolean | null
          rule_count: number | null
          slug: string | null
        }
        Relationships: []
      }
      v_storefront_ratchet: {
        Row: {
          bucket: string | null
          current_value: number | null
          description: string | null
          display_icon: string | null
          display_label: string | null
          display_order: number | null
          display_unit: string | null
          kind: string | null
          provenance_url: string | null
          updated_at: string | null
        }
        Insert: {
          bucket?: string | null
          current_value?: number | null
          description?: string | null
          display_icon?: string | null
          display_label?: string | null
          display_order?: number | null
          display_unit?: string | null
          kind?: string | null
          provenance_url?: string | null
          updated_at?: string | null
        }
        Update: {
          bucket?: string | null
          current_value?: number | null
          description?: string | null
          display_icon?: string | null
          display_label?: string | null
          display_order?: number | null
          display_unit?: string | null
          kind?: string | null
          provenance_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      refresh_storefront_ratchet: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
