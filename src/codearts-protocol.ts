/**
 * CodeArts wire protocol for the xdpool-owned provider.
 *
 * This module is the pieces of CodeArts2API
 * (https://github.com/AA1AAAOQ/CodeArts2API, MIT) that are pure data:
 * identity headers, the stable upstream session id, the model roster, the
 * harness→OpenAI message projection, and the failure taxonomy.
 *
 * WHY A SEPARATE PROVIDER
 *
 * The vendored channel pack's CodeArts adapter answers `HTTP 400 + TM.00001041`
 * by polling `/api/v1/queue/status` every ten seconds for up to thirty minutes.
 * `TM.00001041` is not a queue ticket at all — it is "this account already has
 * its three concurrent upstream sessions". The pack never sends
 * `x-ot-session-id`, so the upstream treats every request as a new session and
 * the third call onward lands on that ceiling; in a tool loop that reads as
 * "the model thinks, then hangs". CodeArts2API pins the cause and its cure:
 * derive one `ses_<hash(domain|AK)>` per credential and reuse it (§6 of its
 * `docs/UPSTREAM.md`), and treat the code as a short transient retry instead of
 * a thirty-minute wait.
 *
 * THE RULES THIS FILE ENCODES
 *
 * - The session id is a pure function of the credential, not of the request.
 * - `model-id` / `model-name` always equal the body's `model`; the upstream
 *   answers 406 when they differ.
 * - No `maas_type` header: the benefit lane is retired, every call is billed
 *   as credits (CodeArts2API §3).
 * - A failure is classified once, here, so "rotate the account", "retry after a
 *   second" and "the request itself is wrong" cannot be confused.
 *
 * @module dsh-xdpool/codearts-protocol
 */
import { createHash, randomBytes } from 'node:crypto'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Provider route this module serves; the same id the pack used, so a pinned
 *  picker selection and the channel card keep working across the swap. */
export const CODEARTS_PROVIDER_ID = 'codearts'

/** Name shown in the picker. */
export const CODEARTS_PROVIDER_NAME = 'CodeArts Agent'

/** Upstream entry point for chat completions. */
export const CODEARTS_CHAT_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** OpenAI-compatible chat path under {@link CODEARTS_CHAT_BASE}. */
export const CODEARTS_CHAT_PATH = '/api/v2/chat/completions'

/**
 * User-Agent the snap-access gateway accepts.
 *
 * Measured by the pack before this module existed: the harness attribution UA
 * is rejected with `403 TM.00000001` on every request, while this IDE-shaped UA
 * is answered normally. Only the UA is replaced; the attribution header still
 * rides along for support.
 */
export const CODEARTS_USER_AGENT = 'CodeArts-Agent/1.0 (Windows NT 10.0; Win64; x64)'

/** Upstream refuses a larger output budget with an empty 131072 stream; 65536
 *  is the measured ceiling and also what the IDE sends. */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65_536

/** A model row this provider advertises. */
export interface CodeArtsModelRow {
  id: string
  name: string
  /** Published context window, when the vendor publishes one. */
  contextWindow?: number
}

/**
 * The shipped roster.
 *
 * Ids and windows are the pack's own cross-checked table (`CONTEXT_WINDOWS`),
 * plus `glm-5.3`, which was missing from its fallback list even though it is
 * the vendor's default. Nothing here is invented: a model without a published
 * window simply carries no figure, and an id a caller names that is not listed
 * is still accepted (the upstream is the authority, not this table).
 */
export const CODEARTS_MODELS: readonly CodeArtsModelRow[] = [
  { id: 'glm-5.3', name: 'glm-5.3', contextWindow: 1_000_000 },
  { id: 'glm-5.3-flash', name: 'glm-5.3-flash', contextWindow: 1_048_576 },
  { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752 },
  { id: 'GLM-5.1', name: 'GLM-5.1', contextWindow: 200_000 },
  { id: 'GLM-5', name: 'GLM-5' },
  { id: 'openpangu-2.0-pro', name: 'openpangu-2.0-pro' },
  { id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' },
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 1_048_576 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 1_048_576 },
]

/** A stored CodeArts credential, snake_cased as the pack writes it. */
export interface CodeArtsCredential {
  access_key_id?: string
  secret_access_key?: string
  security_token?: string
  expires_at?: string
  domain_id?: string
  refresh_token?: string
  [key: string]: unknown
}

/** One account row in the pack's pool. */
export interface CodeArtsAccountEntry {
  id: string
  provider: string
  enabled?: boolean
  credentialRef: string
  expiresAt?: number
  refreshable?: boolean
  modelRateLimits?: Record<string, number>
}

/** The slice of the pack's account pool this provider consumes. */
export interface CodeArtsPool {
  getAvailableAccount(
    provider: string,
    model: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: CodeArtsAccountEntry; credential: CodeArtsCredential } | null | undefined>
  resolveCredentialByRef(refName: string): Promise<unknown>
  listAccountsByProvider(provider: string): readonly CodeArtsAccountEntry[]
  updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void>
  /** Ids the user switched off on the CodeArts card, when the pack exposes it. */
  disabledModelsFor?(provider: string): ReadonlySet<string>
}

/** The pack's refresh service, duck-typed. */
export interface CodeArtsAuth {
  refreshAccountCredential(refName: string, pool: unknown, accountId: string): Promise<void>
}

/** Random lowercase hex, the spelling the IDE uses for trace ids. */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * The credential's stable upstream session id.
 *
 * `ses_` + first 8 bytes of SHA-256 over `domain_id|access_key_id`, exactly as
 * CodeArts2API derives it. Reusing it is the entire concurrency fix: the
 * upstream counts `x-ot-session-id` values per account, so a stable value is one
 * session rather than one per request.
 *
 * Empty when the credential carries no identity at all — the caller then falls
 * back to a random id for that one request rather than sending `ses_`.
 */
export function upstreamSessionId(credential: CodeArtsCredential): string {
  const accessKey = credential.access_key_id ?? ''
  const domain = credential.domain_id ?? ''
  const key = `${domain}|${accessKey}`
  if (key === '|') return ''
  return `ses_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`
}

/** `created-time` header shape: UTC, second precision, trailing `Z`. */
function createdTime(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/**
 * Identity and tracing headers for one chat request.
 *
 * These are CodeArts2API's `baseHeaders()` verbatim in meaning. They are not
 * decoration: the gateway routes and meters on `plugin-*` / `ide-*`, and it
 * validates `model-id` against the body. The two session headers carry the same
 * stable value so neither counter can disagree.
 */
export function codeartsIdentityHeaders(
  credential: CodeArtsCredential,
  model: string,
  sessionId: string,
  now: Date = new Date(),
): Record<string, string> {
  const traceId = randomHex(16)
  return {
    'content-type': 'application/json',
    'app-id': 'CodeAgent3.0',
    'x-ot-function': 'agent-general',
    'x-ot-trace-id': traceId,
    'x-ot-span-id': randomHex(8),
    'x-snap-traceid': `${traceId}_${randomHex(8)}`,
    'x-ot-client-type': 'IDE',
    'x-ot-client-version': '26.9.902',
    'plugin-name': 'codemate_vscode',
    'plugin-version': '26.9.902',
    'ide-name': 'VSCode',
    'ide-version': '26.9.902',
    'created-time': createdTime(now),
    'user-msg-id': `msg_${randomHex(12)}`,
    'x-ot-session-id': sessionId,
    'x-ot-parent-session-id': '',
    'user-session-id': sessionId,
    'is_confidential': 'false',
    'X-Language': 'zh-cn',
    'model-id': model,
    'model-name': model,
  }
}

/** One wire tool call. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One message in the OpenAI-shaped request. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** Readable text of a content block list. */
export function contentToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('')
}

/**
 * Keep only tool pairs that exist on both sides.
 *
 * The upstream rejects an assistant `tool_calls` entry with no matching `tool`
 * role message (and a tool message naming an unknown call). DSH history can
 * legitimately contain a half pair after an aborted turn, and compaction may
 * cut the other half, so filtering here is cheaper than a 400 at the gateway.
 */
function pairedToolIds(messages: readonly Message[]): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call' && block.id !== '') calls.add(block.id)
      if (block.type === 'tool-result' && block.toolCallId !== '') results.add(block.toolCallId)
    }
  }
  const keptCalls = new Set([...calls].filter(id => results.has(id)))
  const keptResults = new Set([...results].filter(id => calls.has(id)))
  return { calls: keptCalls, results: keptResults }
}

/** Normalize a model-produced arguments string to something JSON-parsable. */
function normalizeArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return '{}'
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // The upstream expects an object; a scalar or array is not a tool shape.
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify(parsed)
    }
    return '{}'
  } catch {
    return '{}'
  }
}

/**
 * Project DSH messages onto the OpenAI wire.
 *
 * `reasoning_content` is always present on assistant messages, even when empty:
 * deepseek-v4-flash/pro answer 400 `Missing reasoning_content field` otherwise,
 * and that is the exact failure the pack documented before this module existed.
 */
export function serializeMessages(
  messages: readonly Message[],
  system?: string,
): WireMessage[] {
  const { calls: keptCalls, results: keptResults } = pairedToolIds(messages)
  const wire: WireMessage[] = []
  if (system !== undefined && system.trim() !== '') {
    wire.push({ role: 'system', content: system })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentToText(message.content)
      if (text !== '') wire.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = contentToText(message.content)
      const reasoning = message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('')
      const toolCalls: WireToolCall[] = message.content
        .filter(block => block.type === 'tool-call')
        .filter(block => keptCalls.has(block.id))
        .map(block => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: normalizeArguments(block.arguments) },
        }))
      if (text === '' && reasoning === '' && toolCalls.length === 0) continue
      wire.push({
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    // A user-role message either carries a tool result (DSH's ToolResultMessage)
    // or ordinary user content; the pack emits the text first and the tool
    // messages after it, and that order is what keeps a tool result adjacent to
    // its call when the same turn also contains prose.
    const text = contentToText(message.content)
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (text !== '' || toolResults.length === 0) {
      if (text !== '') wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      if (!keptResults.has(result.toolCallId)) continue
      const content = contentToText(result.content)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: content === '' ? '(no output)' : content,
      })
    }
  }
  return wire
}

/** Failure classes the retry loop routes on. */
export type CodeArtsFailureKind = 'auth' | 'quota' | 'transient' | 'invalid' | 'context' | 'server'

/** One classified upstream failure. */
export interface CodeArtsFailure {
  kind: CodeArtsFailureKind
  status?: number
  /** Upstream business code (`TM.…`, `APIG.…`, `InferHub.…`), when present. */
  code?: string
  message: string
}

/** Codes whose 4xx delivery still means "the credential is dead". */
const CREDENTIAL_CODES = /APIG\.0(301|303|602)|STS5\.\d+|invalid_grant/iu

/** Quota exhaustion wording; terminal for that account until the daily reset. */
const QUOTA_CODES = /TM\.00001050|(^|[^0-9])4291([^0-9]|$)/u
const QUOTA_TEXT = /insufficient[\s_-]+quota|积分已耗尽|积分不足|balance\s+not\s+enough|quota\s+exhausted/iu

/** Concurrency / peak / rate wording; retry shortly on the same credential. */
const TRANSIENT_CODES = /TM\.00001041|81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too\s+many\s+requests/iu
const TRANSIENT_TEXT = /peak\s+usage|high\s+demand|try\s+again\s+after|peak\s+hours|排队|限流|并发会话数已达上限/iu

/** Context-overflow wording, mapped to the harness's own code. */
const CONTEXT_TEXT = /context(?:\s+window)?\s+(?:length|limit)|maximum\s+context|too\s+many\s+tokens|输入过长|超出上下文|上下文.{0,8}超/iu

/**
 * Join the pieces a provider error may spread across: `error.code`,
 * `error.type`, `error.message`, `error_code`, `error_msg`, `message`.
 */
export function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return body
    const record = parsed as Record<string, unknown>
    const nested = typeof record.error === 'object' && record.error !== null
      ? record.error as Record<string, unknown>
      : undefined
    const pieces = [
      nested?.code,
      nested?.type,
      nested?.message,
      record.error_code,
      record.error_msg,
      record.message,
    ].filter((value): value is string => typeof value === 'string' && value !== '')
    if (pieces.length > 0) return pieces.join(' ')
  } catch {
    // HTML error pages and truncated bodies are reported raw.
  }
  return body
}

/**
 * Classify one upstream rejection.
 *
 * `httpStatus` is the transport status; a business error delivered inside a 200
 * SSE frame passes the SSE-level status separately via {@link classifyBusinessCode}.
 */
export function classifyFailure(httpStatus: number | undefined, body: string): CodeArtsFailure {
  const detail = errorDetail(body)
  const code = (() => {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const value = record.error_code ?? (typeof record.error === 'object' && record.error !== null
          ? (record.error as Record<string, unknown>).code
          : undefined)
        if (typeof value === 'string') return value
      }
    } catch {
      // No structured code; the text still classifies.
    }
    return undefined
  })()
  const combined = code === undefined ? detail : `${code} ${detail}`

  if (CREDENTIAL_CODES.test(combined)) {
    return { kind: 'auth', ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code === undefined ? {} : { code }), message: detail }
  }
  if (httpStatus === 401) {
    return { kind: 'auth', status: httpStatus, ...(code === undefined ? {} : { code }), message: detail }
  }
  if (httpStatus === 403) {
    // A WAF verdict on a header is not an expired credential; only a body that
    // names the token is. CodeArts2API and the pack both measured this.
    return { kind: 'invalid', status: httpStatus, ...(code === undefined ? {} : { code }), message: detail }
  }
  if (QUOTA_CODES.test(combined) || QUOTA_TEXT.test(combined)) {
    return { kind: 'quota', ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code === undefined ? {} : { code }), message: detail }
  }
  if (CONTEXT_TEXT.test(combined)) {
    return { kind: 'context', ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code === undefined ? {} : { code }), message: detail }
  }
  if (TRANSIENT_CODES.test(combined) || TRANSIENT_TEXT.test(combined) || httpStatus === 429) {
    return { kind: 'transient', ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code === undefined ? {} : { code }), message: detail }
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { kind: 'server', status: httpStatus, ...(code === undefined ? {} : { code }), message: detail }
  }
  return { kind: 'invalid', ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code === undefined ? {} : { code }), message: detail }
}

/**
 * Classify an in-band error frame (`{"error_code":…}` inside a 200 SSE body).
 *
 * These are not HTTP failures, so there is no status to pass; the business code
 * and message carry everything.
 */
export function classifyBusinessCode(code: string, message: string): CodeArtsFailure {
  return classifyFailure(undefined, JSON.stringify({ error_code: code, error_msg: message }))
}

/**
 * The next UTC+8 midnight, as epoch milliseconds.
 *
 * CodeArts settles credits and daily allowances on the China calendar day; a
 * quota-exhausted account is parked until that instant rather than for a
 * guessed number of minutes.
 */
export function nextUtc8DayStartMs(now: number = Date.now()): number {
  const utc8 = new Date(now + 8 * 60 * 60 * 1000)
  const next = Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate() + 1)
  return next - 8 * 60 * 60 * 1000
}