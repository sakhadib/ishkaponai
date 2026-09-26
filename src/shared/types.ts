/**
 * Domain and IPC types shared by the agent host, main process, preload bridge
 * and renderer.
 *
 * This module must stay free of Node and DOM imports so it can be bundled into
 * every process target. Types only — no runtime values.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Subset of `NodeJS.Platform`, safe for the renderer to depend on. */
export type Platform = 'win32' | 'darwin' | 'linux' | 'freebsd' | 'openbsd' | 'sunos'

/**
 * There is no theme mode, and that is deliberate: ISHKAPON is light-only. The
 * type is gone rather than pinned to `'light'`, so a future contributor cannot
 * reintroduce a switch by wiring an existing enum back up.
 */

/** `auto` mirrors the language of the user's message. */
export type LanguagePref = 'auto' | 'en' | 'bn'

/**
 * The subjects the product covers. `general` is not offered in Personalise — it
 * is the value a session takes when no subject is chosen, and it is a fallback
 * rather than a preference.
 */
export const STUDY_SUBJECTS = ['math', 'physics', 'chemistry'] as const

export type StudySubject = (typeof STUDY_SUBJECTS)[number]

export type Subject = StudySubject | 'general'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled'

export type ToolCallStatus =
  | 'running'
  | 'complete'
  | 'error'
  | 'timeout'
  | 'cancelled'

// ---------------------------------------------------------------------------
// Persisted entities
// ---------------------------------------------------------------------------

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  modelId: string | null
  subject: Subject | null
  preferredLanguage: LanguagePref
  /** Structured running summary produced by context compaction. */
  summary: string | null
  /** Highest message `seq` covered by `summary`. */
  summaryUpToSeq: number
  pinned: boolean
}

export interface Message {
  id: string
  sessionId: string
  seq: number
  role: Role
  /** Markdown source. Empty for tool-only rows. */
  content: string
  /** Model "thinking" trace, when the provider emits one. */
  reasoning: string | null
  status: MessageStatus
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  createdAt: number
}

export interface ToolCall {
  id: string
  sessionId: string
  messageId: string
  seq: number
  /** Always `python` in v1 — the single execution substrate. */
  tool: 'python'
  code: string
  stdout: string | null
  /** `repr()` of a bare expression, when the code was an expression. */
  resultValue: string | null
  /** Exception text, returned to the model as data rather than thrown. */
  error: string | null
  status: ToolCallStatus
  durationMs: number | null
  truncated: boolean
  createdAt: number
}

export interface SessionDetail {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
}

// ---------------------------------------------------------------------------
// Settings and secrets
// ---------------------------------------------------------------------------

export interface Settings {
  /** OpenRouter model slug. `null` until the user chooses one. */
  modelId: string | null
  preferredLanguage: LanguagePref
  /** System-prompt layer 2. User text, treated as untrusted input. */
  userInstructions: string
  pythonTimeoutMs: number
  showThinking: boolean
  maxOutputTokens: number
  /**
   * Who the answers are for. Injected into the system prompt so the model can
   * pitch at the right level and stick to the right syllabus.
   *
   * Deliberately *not* a `Profile` object. Flat fields keep the migration and
   * validation paths unchanged, and a nested object here would be a structure
   * with one consumer. Every field is optional, because a student who has told
   * us nothing must still get a working app.
   */
  studentName: string
  /** Age in years, or `null` when not given. */
  studentAge: number | null
  /** Free text: "Class 10", "Year 11", "O-Level", "HSC". Not enumerated,
   *  because what a student calls their year depends on their curriculum. */
  studentGrade: string
  /** Subjects the student mainly wants to study. */
  studySubjects: StudySubject[]
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: null,
  preferredLanguage: 'auto',
  userInstructions: '',
  pythonTimeoutMs: 60_000,
  showThinking: true,
  maxOutputTokens: 2048,
  studentName: '',
  studentAge: null,
  studentGrade: '',
  studySubjects: []
}

/**
 * What the renderer is allowed to know about the API key. The plaintext key is
 * never returned to the renderer.
 */
export interface SecretStatus {
  configured: boolean
  /** e.g. `...abcd`. Null when no key is stored. */
  hint: string | null
  /**
   * Set when the OS secret store is unavailable (e.g. Linux `basic_text`),
   * meaning the stored value is effectively plaintext. The UI must warn.
   */
  backendWarning: string | null
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  /** USD per million prompt tokens. */
  pricingPrompt: number | null
  /** USD per million completion tokens. */
  pricingCompletion: number | null
  supportsTools: boolean
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: Platform
  arch: string
  locale: string
}

// ---------------------------------------------------------------------------
// Agent events (agent host -> main -> renderer)
// ---------------------------------------------------------------------------

export interface TurnUsage {
  tokensIn: number
  tokensOut: number
  costUsd: number | null
}

/**
 * Every event is a discriminated union member so the renderer can switch
 * exhaustively. New members must be added to `AgentEvent` and handled in the
 * renderer's reducer.
 */
export type AgentEvent =
  | { type: 'turn.started'; sessionId: string; messageId: string }
  | { type: 'reasoning.delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'message.delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'tool.started'; sessionId: string; messageId: string; toolCall: ToolCall }
  | { type: 'tool.output'; sessionId: string; toolCallId: string; chunk: string }
  | {
      type: 'tool.finished'
      sessionId: string
      toolCallId: string
      status: ToolCallStatus
      resultValue?: string | null
      error?: string | null
      durationMs?: number
      truncated?: boolean
    }
  | { type: 'compaction.started'; sessionId: string }
  | { type: 'compaction.finished'; sessionId: string; summary: string }
  | { type: 'title.suggested'; sessionId: string; title: string }
  | { type: 'turn.finished'; sessionId: string; messageId: string; usage: TurnUsage }
  | {
      type: 'turn.error'
      sessionId: string
      messageId: string
      message: string
      fatal: boolean
    }

// ---------------------------------------------------------------------------
// Agent host wire protocol
//
// Main -> agent over `utilityProcess.postMessage`.
// Agent -> main over `process.parentPort.postMessage`.
// ---------------------------------------------------------------------------

/** One prior turn, replayed to the agent so it can rebuild context. */
export interface TurnRecord {
  role: 'user' | 'assistant'
  content: string
  /**
   * Tool calls made during that assistant turn. Replaying these keeps the
   * calculation trail in context, so a later turn can refer back to a value
   * instead of recomputing or hallucinating it.
   */
  toolCalls?: ToolCallRecord[]
}

/** Condensed tool call, for context replay. */
export interface ToolCallRecord {
  code: string
  resultValue: string | null
  stdout: string | null
  error: string | null
}

export interface AgentInitCommand {
  kind: 'init'
  /** `null` clears the key; the agent must then refuse to start turns. */
  apiKey: string | null
}

export interface AgentSendCommand {
  kind: 'send'
  sessionId: string
  /** Id of the assistant message being produced. */
  messageId: string
  /** The student's new message. */
  text: string
  /** Prior turns, oldest first. Excludes the new message. */
  history: TurnRecord[]
  /** Compacted running summary, or `null` when the session fits in budget. */
  summary: string | null
  modelId: string
  maxOutputTokens: number
  pythonTimeoutMs: number
  preferredLanguage: LanguagePref
}

export interface AgentStopCommand {
  kind: 'stop'
  sessionId: string
}

export interface AgentSettingsCommand {
  kind: 'settings'
  settings: Settings
}

export interface AgentResetInterpreterCommand {
  kind: 'reset-interpreter'
  sessionId: string
}

export type AgentCommand =
  | AgentInitCommand
  | AgentSendCommand
  | AgentStopCommand
  | AgentSettingsCommand
  | AgentResetInterpreterCommand

/** Handshake and failure notices that are not part of a turn. */
export type AgentToMain =
  | { type: 'host.ready' }
  | { type: 'host.error'; message: string }
  | AgentEvent
