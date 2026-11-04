// Frontend agent kinds used by the workbench UI (kebab-case, also used in REST paths).
export type AIServiceAgentKind = 'log-analysis' | 'project-expert' | 'package-search'

// Backend agent kinds as persisted on chat sessions / messages (snake_case).
export type BackendAgentKind = 'log_analysis' | 'project_expert' | 'package_search'

export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale'

export type ChatRole = 'user' | 'ai' | 'system'

export const AGENT_KINDS: AIServiceAgentKind[] = ['project-expert', 'log-analysis', 'package-search']

export function agentKindToBackend(kind: AIServiceAgentKind): BackendAgentKind {
  switch (kind) {
    case 'log-analysis':
      return 'log_analysis'
    case 'package-search':
      return 'package_search'
    case 'project-expert':
    default:
      return 'project_expert'
  }
}

export function backendToAgentKind(kind?: string | null): AIServiceAgentKind | null {
  switch (kind) {
    case 'log_analysis':
      return 'log-analysis'
    case 'package_search':
      return 'package-search'
    case 'project_expert':
      return 'project-expert'
    default:
      return null
  }
}

/** Project repository option returned by GET /api/v1/project-repos. */
export interface ProjectRepoOption {
  id: number
  project_name: string
  project_code: string
  default_branch: string
  description?: string
  is_enabled?: boolean
}

/**
 * Raw Agent trace event as emitted by RavenAIService. We keep it permissive
 * (mirror of the backend object) so new trace types do not break the panel.
 */
export interface AgentTraceEvent {
  seq?: number
  type: string
  ts?: string
  [key: string]: unknown
}

export interface SSEFrame {
  event?: string
  data: Record<string, unknown>
}

/** A single rendered message in a conversation thread. */
export interface ChatEntry {
  id: string
  role: ChatRole
  content: string
  kind?: 'answer' | 'user' | 'plan' | 'device_action'
  traceEvents?: AgentTraceEvent[]
  traceRunning?: boolean
}

/** Lightweight history turn sent back to the backend for multi-turn context. */
export interface HistoryTurn {
  role: string
  content: string
}

/** Mirror of backend ChatSessionSummary. */
export interface ChatSessionSummary {
  id: string
  title: string
  last_message_at: string
  message_count: number
  created_at: string
  updated_at: string
  is_pinned?: boolean
  pinned_at?: string | null
  active_run_id?: string | null
  run_status?: string | null
  run_agent_kind?: string | null
  run_started_at?: string | null
  run_updated_at?: string | null
}

/** Mirror of backend ChatMessageRecord. */
export interface ChatMessageRecord {
  id: string
  session_id: string
  role: ChatRole
  content: string
  created_at: string
  updated_at: string
  run_id?: string | null
  run_status?: string | null
  run_agent_kind?: string | null
  trace_events?: unknown[] | null
}

export interface UserProfile {
  id: string
  username: string
  display_name?: string | null
  email?: string | null
  is_active?: boolean
  role?: string
  language?: string | null
  last_login_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface UserAuthPayload {
  token: string
  expires_at: number
  user: UserProfile
}

export interface UserRegistrationRequest {
  username: string
  password: string
  display_name?: string
  email: string
}

export interface RavenClientAIRouteCapabilities {
  image_input: boolean
  document_input: boolean
  tool_use: boolean
  partial_streaming: boolean
  thinking_budget: boolean
}

export interface RavenClientAIRoute {
  slot: 'primary' | 'backup'
  provider: string
  api_protocol?: 'anthropic_messages' | 'openai_responses'
  base_url: string
  api_key: string
  model: string
  small_fast_model?: string | null
  capabilities: RavenClientAIRouteCapabilities
}

export interface RavenClientAICapabilitySnapshot {
  revision: string
  issued_at: number
  expires_at: number
  refresh_after_seconds: number
  routes: RavenClientAIRoute[]
}

export interface RavenClientAIUsageReport {
  invocation_id: string
  slot: 'primary' | 'backup'
  provider: string
  model: string
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  outcome?: 'ok' | 'slow' | 'timeout' | 'hard_failure'
  tokens: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
  }
  duration_ms?: number
  ttft_ms?: number
  error_kind?: string
}

export interface AIServiceConfig {
  host: string
  port: number
  baseUrl: string
  hasToken: boolean
  token?: string
}

/** Per-session conversation state held in the external conversation store. */
export interface ConversationState {
  sessionId: string
  messages: ChatEntry[]
  loadingMessages: boolean
  isSending: boolean
  activeRunId: string | null
  runStatus: RunStatus
  runAgentKind: BackendAgentKind | null
  /** Dedupe map of `${runId}:${seq}` -> 1 so replayed frames are not double-rendered. */
  seenSeq: Record<string, number>
  /** Stable assistant placeholder id for the current run. */
  currentAnswerId: string | null
  /** Abort controller for the active SSE pump; aborting drops the reader, not the run. */
  subscription: AbortController | null
  /** Loaded once per session-id. */
  loaded: boolean
  /** Last agent kind used in this conversation. */
  lastAgentKind: BackendAgentKind | null
  /** Last project repo id selected for this conversation (frontend-only). */
  lastProjectRepoId: number | null
}
