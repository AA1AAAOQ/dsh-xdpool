/**
 * Direct CodeArts upstream client for xdpool's own provider.
 *
 * The transport here is a port of CodeArts2API's `internal/codearts` +
 * `internal/server/chat.go` request path (MIT), not a queue consumer:
 *
 * - one stable `x-ot-session-id` per credential, so the upstream's "three
 *   concurrent sessions per account" counter sees one session;
 * - `TM.00001041` / 429 / 5xx are **short transient failures** — retry with
 *   `1s, 2s, 3s` backoff and the same credential, never a status poll;
 * - no `/api/v1/queue/status` request at all. That endpoint is why the pack can
 *   sit for thirty minutes on a tool call: a concurrency rejection is not a
 *   queue position, and treating it as one turns a two-second retry into a wait
 *   the user reads as "the model hung";
 * - request-shaped failures (bad tools, context overflow, unknown model) fail
 *   immediately and rotate nothing.
 *
 * The account pool and refresh mechanism still belong to the vendored pack: a
 * scan sign-in writes `CODEARTS_ACCOUNT_*` into the host credential store and an
 * entry into the pack's pool, and both are reachable through the cordis scope
 * the pack mounts on. Reusing them keeps one account list, one set of cooldowns
 * and one refresh queue instead of a second shadow pool.
 *
 * @module dsh-xdpool/codearts-upstream
 */
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  ToolCallId,
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { signRequest } from './codearts-signer.ts'
import {
  CODEARTS_CHAT_BASE,
  CODEARTS_CHAT_PATH,
  CODEARTS_MAX_OUTPUT_TOKENS,
  CODEARTS_USER_AGENT,
  classifyBusinessCode,
  classifyFailure,
  codeartsIdentityHeaders,
  errorDetail,
  nextUtc8DayStartMs,
  serializeMessages,
  upstreamSessionId,
  type CodeArtsAccountEntry,
  type CodeArtsAuth,
  type CodeArtsCredential,
  type CodeArtsFailure,
  type CodeArtsPool,
} from './codearts-protocol.ts'

/** The tiny slice of a cordis context this module reads. */
interface ServiceScope {
  get?(name: string): unknown
}

/** Optional logger, duck-typed so the host context's own logger fits. */
export interface CodeArtsLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

/** Construction options; every I/O seam is injectable for tests. */
export interface CodeartsUpstreamOptions {
  /** Lazy cordis scope the pack provided `accountPool` / `codeartsAuth` on. */
  scope: () => unknown
  logger?: CodeArtsLogger
  /** Fetch implementation; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Override the upstream origin (tests only). */
  baseUrl?: string
  /** Sleep implementation; defaults to a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Clock override for token freshness. */
  now?: () => number
}

/** Retry budget for transient upstream failures. */
const DEFAULT_MAX_ATTEMPTS = 4

/** Per-attempt backoff, indexed from one. CodeArts2API caps at 3 seconds. */
export function codeartsBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0
  return Math.min(attempt * 1000, 3000)
}

/** Time allowed for response headers before a request is considered hung. */
const CONNECT_TIMEOUT_MS = 60_000

/** First-token and per-chunk ceilings; both overridable for slow accounts. */
function firstTokenTimeoutMs(): number {
  const raw = Number.parseInt(process.env['DSH_CODEARTS_FIRST_TOKEN_TIMEOUT_MS'] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000
}

function chunkTimeoutMs(): number {
  const raw = Number.parseInt(process.env['DSH_CODEARTS_CHUNK_TIMEOUT_MS'] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000
}

/** Map a classified upstream failure to the harness's provider-neutral error. */
export function codeartsError(failure: CodeArtsFailure, model: string): LlmError {
  const detail = failure.message === '' ? '' : `：${failure.message.slice(0, 400)}`
  switch (failure.kind) {
    case 'auth':
      return new LlmError(
        `codearts: 账号登录态已失效，请在渠道页重新登录 CodeArts${detail}`,
        'AUTH',
        failure.status === undefined ? undefined : { status: failure.status },
      )
    case 'quota':
      return new LlmError(
        `codearts: 模型 ${model} 的积分额度已耗尽，预计次日（UTC+8）恢复${detail}`,
        'QUOTA',
        failure.status === undefined ? undefined : { status: failure.status },
      )
    case 'context':
      return new LlmError(
        `codearts: 请求超出模型 ${model} 的上下文窗口${detail}`,
        'CONTEXT_WINDOW_EXCEEDED',
        failure.status === undefined ? undefined : { status: failure.status },
      )
    case 'transient':
      return new LlmError(
        `codearts: 上游并发或限流，重试后仍失败${detail}`,
        'RATE_LIMIT',
        failure.status === undefined ? undefined : { status: failure.status },
      )
    case 'server':
      return new LlmError(
        `codearts: 上游服务暂时不可用${detail}`,
        'SERVER',
        failure.status === undefined ? undefined : { status: failure.status },
      )
    default:
      return new LlmError(
        `codearts: 请求被上游拒绝（HTTP ${String(failure.status ?? 400)}）${detail}`,
        'INVALID_REQUEST',
        failure.status === undefined ? undefined : { status: failure.status },
      )
  }
}

/** A credential is usable when it can sign a request at all. */
function usableCredential(credential: CodeArtsCredential | undefined): credential is CodeArtsCredential {
  return credential !== undefined
    && typeof credential.access_key_id === 'string' && credential.access_key_id !== ''
    && typeof credential.secret_access_key === 'string' && credential.secret_access_key !== ''
}

/** Read a service off a cordis scope without letting an unavailable service throw. */
function serviceOf(scope: unknown, name: string): unknown {
  try {
    return (scope as ServiceScope | undefined)?.get?.(name)
  } catch {
    return undefined
  }
}

/** Duck-type the pack's account pool. */
function asPool(service: unknown): CodeArtsPool | undefined {
  if (service === undefined || service === null) return undefined
  const candidate = service as Partial<CodeArtsPool>
  if (typeof candidate.getAvailableAccount !== 'function') return undefined
  if (typeof candidate.resolveCredentialByRef !== 'function') return undefined
  if (typeof candidate.listAccountsByProvider !== 'function') return undefined
  if (typeof candidate.updateModelRateLimit !== 'function') return undefined
  return service as CodeArtsPool
}

/** Duck-type the pack's refresh service. */
function asAuth(service: unknown): CodeArtsAuth | undefined {
  if (service === undefined || service === null) return undefined
  const candidate = service as Partial<CodeArtsAuth>
  return typeof candidate.refreshAccountCredential === 'function'
    ? service as CodeArtsAuth
    : undefined
}

/** Parse the credential document the pack stores behind a ref. */
function asCredential(value: unknown): CodeArtsCredential | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    try {
      return asCredential(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object') return undefined
  return value as CodeArtsCredential
}

/** Default sleep, abortable. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A block the SSE consumer is assembling. */
type StreamBlock =
  | { index: number; kind: 'text'; text: string }
  | { index: number; kind: 'reasoning'; text: string }
  | { index: number; kind: 'tool'; id: string; name: string; arguments: string; announced: boolean }

/** One parsed chat-completion chunk. */
interface UpstreamChunk {
  choices?: {
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    prompt_cache_hit_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error_code?: string
  error_msg?: string
}

/** Read one chunk with a timeout, honouring the caller's abort signal. */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('codearts: stream read timed out')), timeoutMs)
  })
  try {
    return await Promise.race([reader.read(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The CodeArts upstream client.
 *
 * One instance serves the provider route; it holds no credential state, because
 * the pool is re-read per request and a rotated credential must be visible to
 * the next call without rebuilding the adapter.
 */
export class CodeartsUpstream {
  private readonly options: CodeartsUpstreamOptions
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: CodeartsUpstreamOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? CODEARTS_CHAT_BASE).replace(/\/+$/u, '')
  }

  /** Whether the pool currently holds a CodeArts account at all. */
  hasAccounts(): boolean {
    const pool = this.pool()
    if (pool === undefined) return false
    try {
      return pool.listAccountsByProvider('codearts').some(entry => entry.enabled !== false)
    } catch {
      return false
    }
  }

  /**
   * Model ids the user switched off on the CodeArts card.
   *
   * The filter belongs to the pack's settings document, which the pool already
   * reads; carrying it here keeps the card's ticks effective after the adapter
   * swap. An unavailable pool simply answers "nothing switched off" rather than
   * hiding the whole roster.
   */
  disabledModels(): ReadonlySet<string> {
    const pool = this.pool()
    if (pool?.disabledModelsFor === undefined) return new Set()
    try {
      return pool.disabledModelsFor('codearts')
    } catch {
      return new Set()
    }
  }

  /**
   * Stream one turn.
   *
   * The first chunk is fetched before anything is yielded, so a transient
   * rejection can still be retried without duplicating output. After the first
   * chunk the stream is committed: a later failure propagates and the harness
   * records it as the attempt's failure.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal ?? new AbortController().signal
    const model = options.model
    if (model === '') throw new LlmError('codearts: 这条请求没有指定模型', 'INVALID_REQUEST')

    const maxAttempts = Math.max(1, Number.parseInt(process.env['DSH_CODEARTS_MAX_ATTEMPTS'] ?? '', 10) || DEFAULT_MAX_ATTEMPTS)
    const tried = new Set<string>()
    let lastFailure: CodeArtsFailure | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
      const resolved = await this.resolveAccount(model, tried)
      if (resolved === undefined) {
        if (lastFailure !== undefined) throw codeartsError(lastFailure, model)
        throw new LlmError(
          'codearts: 还没有登录 CodeArts。请在渠道页的 CodeArts 卡片里登录一次。',
          'MISSING_CREDENTIAL',
        )
      }
      const { entry, credential } = resolved
      const fresh = await this.refreshIfExpired(entry, credential)
      if (!usableCredential(fresh)) {
        tried.add(entry.id)
        lastFailure = { kind: 'auth', message: '凭据缺少 access_key_id / secret_access_key' }
        continue
      }

      const sessionId = upstreamSessionId(fresh) || `ses_${Math.random().toString(16).slice(2, 18)}`
      const body = this.requestBody(options, sessionId)
      const url = `${this.baseUrl}${CODEARTS_CHAT_PATH}`
      const identity = codeartsIdentityHeaders(fresh, model, sessionId)
      const signed = await signRequest(
        fresh.access_key_id as string,
        fresh.secret_access_key as string,
        typeof fresh.security_token === 'string' ? fresh.security_token : '',
        'POST',
        url,
        Buffer.from(body, 'utf8'),
        identity,
      )
      // The attribution UA is overwritten after signing on purpose: the gateway
      // rejects the harness UA with a WAF 403, and the UA does not participate
      // in the HMAC.
      const headers: Record<string, string> = {
        ...attributionHeaders(),
        ...signed,
        'user-agent': CODEARTS_USER_AGENT,
      }
      delete headers['host']
      delete headers['content-length']

      let response: Response
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      const connectTimer = setTimeout(() => controller.abort(new Error('codearts: connect timed out')), CONNECT_TIMEOUT_MS)
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
      } catch (error) {
        if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
        lastFailure = { kind: 'transient', message: String(error) }
        this.options.logger?.warn?.(`[codearts] transport error: ${String(error)}`)
        await this.backoff(attempt, signal)
        continue
      } finally {
        clearTimeout(connectTimer)
        signal.removeEventListener('abort', onAbort)
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const failure = classifyFailure(response.status, text || response.statusText)
        lastFailure = failure
        if (failure.kind === 'auth') {
          const refreshed = await this.forceRefresh(entry, fresh)
          if (refreshed !== undefined && usableCredential(refreshed)) {
            tried.delete(entry.id)
            continue
          }
          tried.add(entry.id)
          continue
        }
        if (failure.kind === 'quota') {
          await this.parkAccount(entry, model)
          tried.add(entry.id)
          continue
        }
        if (failure.kind === 'transient' || failure.kind === 'server') {
          await this.backoff(attempt, signal)
          continue
        }
        throw codeartsError(failure, model)
      }

      const iterator = this.consume(response, options, model)
      let first: IteratorResult<StreamChunk>
      try {
        first = await iterator.next()
      } catch (error) {
        if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
        if (error instanceof LlmError) {
          // The SSE frame can carry the same failures as an HTTP status. Only a
          // failure raised before the first yielded chunk can still be retried;
          // the cases that need an account action are handled as such.
          if (error.code === 'AUTH') {
            const refreshed = await this.forceRefresh(entry, fresh)
            if (refreshed !== undefined && usableCredential(refreshed)) {
              tried.delete(entry.id)
              continue
            }
            tried.add(entry.id)
            lastFailure = { kind: 'auth', message: error.message }
            continue
          }
          if (error.code === 'QUOTA') {
            await this.parkAccount(entry, model)
            tried.add(entry.id)
            lastFailure = { kind: 'quota', message: error.message }
            continue
          }
          if (error.code === 'RATE_LIMIT' || error.code === 'SERVER') {
            lastFailure = {
              kind: error.code === 'RATE_LIMIT' ? 'transient' : 'server',
              message: error.message,
            }
            await this.backoff(attempt, signal)
            continue
          }
          throw error
        }
        lastFailure = { kind: 'transient', message: String(error) }
        await this.backoff(attempt, signal)
        continue
      }
      if (first.done === true) return
      yield first.value
      yield* iterator
      return
    }

    if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
    throw codeartsError(
      lastFailure ?? { kind: 'transient', message: '重试次数已用尽' },
      model,
    )
  }

  /** Resolve the account pool from the lazy scope, checking the outer scope too. */
  private pool(): CodeArtsPool | undefined {
    return asPool(serviceOf(this.options.scope(), 'accountPool'))
  }

  /** Resolve the pack's per-credential refresh service. */
  private auth(): CodeArtsAuth | undefined {
    return asAuth(serviceOf(this.options.scope(), 'codeartsAuth'))
  }

  /** Pick the next available account, excluding ids this turn already burned. */
  private async resolveAccount(
    model: string,
    exclude: ReadonlySet<string>,
  ): Promise<{ entry: CodeArtsAccountEntry; credential: CodeArtsCredential } | undefined> {
    const pool = this.pool()
    if (pool === undefined) return undefined
    let picked: { entry: CodeArtsAccountEntry; credential: CodeArtsCredential } | null | undefined
    try {
      picked = await pool.getAvailableAccount('codearts', model, exclude)
    } catch (error) {
      this.options.logger?.warn?.(`[codearts] account selection failed: ${String(error)}`)
      return undefined
    }
    if (picked === null || picked === undefined) return undefined
    const credential = asCredential(picked.credential)
    if (credential === undefined) return undefined
    return { entry: picked.entry, credential }
  }

  /** Refresh a credential that is at or near expiry, before spending a request on it. */
  private async refreshIfExpired(
    entry: CodeArtsAccountEntry,
    credential: CodeArtsCredential,
  ): Promise<CodeArtsCredential> {
    const expiresAt = typeof credential.expires_at === 'string' ? Date.parse(credential.expires_at) : Number.NaN
    const now = this.options.now?.() ?? Date.now()
    // Five minutes of headroom: a refresh request and the following chat call
    // must both fit before the STS token expires.
    if (!Number.isFinite(expiresAt) || expiresAt - now > 5 * 60_000) return credential
    return (await this.forceRefresh(entry, credential)) ?? credential
  }

  /** Ask the pack to refresh one credential and re-read it. */
  private async forceRefresh(
    entry: CodeArtsAccountEntry,
    previous: CodeArtsCredential,
  ): Promise<CodeArtsCredential | undefined> {
    const auth = this.auth()
    const pool = this.pool()
    if (auth === undefined || pool === undefined) return undefined
    try {
      await auth.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      const refreshed = asCredential(await pool.resolveCredentialByRef(entry.credentialRef))
      if (refreshed === undefined) return undefined
      // A refresh that returns the same expired token did not help; do not loop.
      if (
        refreshed.access_key_id === previous.access_key_id
        && refreshed.expires_at === previous.expires_at
      ) {
        return undefined
      }
      return refreshed
    } catch (error) {
      this.options.logger?.warn?.(`[codearts] credential refresh failed for ${entry.id}: ${String(error)}`)
      return undefined
    }
  }

  /** Cool a quota-exhausted account until the next UTC+8 midnight. */
  private async parkAccount(entry: CodeArtsAccountEntry, model: string): Promise<void> {
    const pool = this.pool()
    if (pool === undefined) return
    try {
      await pool.updateModelRateLimit(entry.id, model, nextUtc8DayStartMs(this.options.now?.() ?? Date.now()))
    } catch (error) {
      this.options.logger?.warn?.(`[codearts] could not park ${entry.id}: ${String(error)}`)
    }
  }

  /** Wait before the next attempt, abortable. */
  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep
    await sleep(codeartsBackoffMs(attempt), signal)
  }

  /** Build the OpenAI-compatible request body. */
  private requestBody(options: GenerateOptions, sessionId: string): string {
    const messages = serializeMessages(options.messages, options.system)
    const tools = options.tools?.map(tool => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    const requested = typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens)
      ? options.maxTokens
      : CODEARTS_MAX_OUTPUT_TOKENS
    return JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // A cache key is what makes the upstream report prefix hits at all; the
      // session id is stable for one DSH conversation, so a tool loop reuses it.
      prompt_cache_key: typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : sessionId,
      include: ['reasoning.encrypted_content'],
      reasoning_summary: 'auto',
      tool_stream: true,
      max_tokens: Math.min(requested, CODEARTS_MAX_OUTPUT_TOKENS),
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      // The gateway's own "thinking" switch is top-level; `off` is the only
      // value that changes behaviour (on is the server default).
      ...(options.reasoningEffort === 'off' ? { thinking: { type: 'disabled' } } : {}),
    })
  }

  /**
   * Parse one SSE response into harness chunks.
   *
   * Everything up to the first chunk is still retryable by {@link stream}; the
   * consumer itself has no retry logic because output cannot be un-yielded.
   */
  private async *consume(
    response: Response,
    options: GenerateOptions,
    model: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body = response.body
    if (body === null) throw new LlmError('codearts: 上游返回了空响应体', EMPTY_RESPONSE_CODE)
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const signal = options.signal ?? new AbortController().signal
    let buffer = ''
    let receivedFirstToken = false
    let streamEnded = false
    let finishReason: string | undefined
    let usage: TokenUsage | undefined

    const blocks: StreamBlock[] = []
    const toolBlocks = new Map<number, StreamBlock & { kind: 'tool' }>()
    let nextIndex = 0
    let textBlock: (StreamBlock & { kind: 'text' }) | undefined
    let reasoningBlock: (StreamBlock & { kind: 'reasoning' }) | undefined
    let announcedTools = 0

    const ensureText = (): { block: StreamBlock & { kind: 'text' }; created: boolean } => {
      if (textBlock !== undefined) return { block: textBlock, created: false }
      textBlock = { index: nextIndex++, kind: 'text', text: '' }
      blocks.push(textBlock)
      return { block: textBlock, created: true }
    }
    const ensureReasoning = (): { block: StreamBlock & { kind: 'reasoning' }; created: boolean } => {
      if (reasoningBlock !== undefined) return { block: reasoningBlock, created: false }
      reasoningBlock = { index: nextIndex++, kind: 'reasoning', text: '' }
      blocks.push(reasoningBlock)
      return { block: reasoningBlock, created: true }
    }

    try {
      while (!streamEnded) {
        const timeout = receivedFirstToken ? chunkTimeoutMs() : firstTokenTimeoutMs()
        const result = await readWithTimeout(reader, timeout, signal)
        if (signal.aborted) throw new LlmError('codearts: request aborted', 'ABORTED')
        if (result.done) break
        receivedFirstToken = true
        buffer += decoder.decode(result.value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/u, '').trim()
          buffer = buffer.slice(newline + 1)
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') {
              streamEnded = true
              break
            }
            let chunk: UpstreamChunk
            try {
              chunk = JSON.parse(payload) as UpstreamChunk
            } catch {
              // A truncated/keep-alive frame is not an error; skip it.
              newline = buffer.indexOf('\n')
              continue
            }
            if (typeof chunk.error_code === 'string' && chunk.error_code !== '') {
              const message = typeof chunk.error_msg === 'string' && chunk.error_msg !== ''
                ? chunk.error_msg
                : errorDetail(payload)
              const failure = classifyBusinessCode(chunk.error_code, message)
              throw codeartsError(failure, model)
            }
            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
            if (typeof delta?.content === 'string' && delta.content !== '') {
              const { block, created } = ensureText()
              if (created) yield { type: 'block-start', index: block.index, blockType: 'text' }
              block.text += delta.content
              yield { type: 'text-delta', index: block.index, text: delta.content }
            }
            const reasoningDelta = typeof delta?.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta?.reasoning === 'string'
                ? delta.reasoning
                : ''
            if (reasoningDelta !== '') {
              const { block, created } = ensureReasoning()
              if (created) yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
              block.text += reasoningDelta
              yield { type: 'reasoning-delta', index: block.index, text: reasoningDelta }
            }
            for (const call of delta?.tool_calls ?? []) {
              const wireIndex = typeof call.index === 'number' ? call.index : 0
              let block = toolBlocks.get(wireIndex)
              if (block === undefined) {
                block = {
                  index: nextIndex++,
                  kind: 'tool',
                  id: typeof call.id === 'string' && call.id !== '' ? call.id : `codearts-${crypto.randomUUID()}`,
                  name: '',
                  arguments: '',
                  announced: false,
                }
                toolBlocks.set(wireIndex, block)
                blocks.push(block)
              }
              if (typeof call.id === 'string' && call.id !== '') block.id = call.id
              const name = typeof call.function?.name === 'string' ? call.function.name : ''
              if (name !== '' && block.name === '') block.name = name
              const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
              block.arguments += fragment
              if (!block.announced && block.name !== '') {
                block.announced = true
                announcedTools += 1
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
                yield {
                  type: 'tool-call-delta',
                  index: block.index,
                  id: ToolCallId(block.id),
                  name: block.name,
                  argumentsDelta: block.arguments,
                }
              } else if (block.announced && fragment !== '') {
                yield {
                  type: 'tool-call-delta',
                  index: block.index,
                  id: ToolCallId(block.id),
                  argumentsDelta: fragment,
                }
              }
            }
            if (chunk.usage !== undefined) {
              const promptTokens = chunk.usage.prompt_tokens ?? 0
              const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens
                ?? chunk.usage.prompt_cache_hit_tokens
                ?? 0
              const cacheWriteTokens = chunk.usage.prompt_tokens_details?.cache_write_tokens
              const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens
              usage = {
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                ...(typeof cacheWriteTokens === 'number' && cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
                ...(typeof reasoningTokens === 'number' && reasoningTokens > 0 ? { reasoningTokens } : {}),
              }
            }
          }
          newline = buffer.indexOf('\n')
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // A reader already closed by the server is not a failure.
      }
    }

    // A stream can end without `[DONE]` and without any content; both are the
    // empty-completion case the harness asks adapters to classify rather than
    // silently finish.
    const emittedBlocks = blocks.filter(block => block.kind !== 'tool' || (block.announced && block.name !== ''))
    if (emittedBlocks.length === 0 && usage === undefined) {
      throw new LlmError(
        `codearts: 模型 ${model} 返回了空回复`,
        EMPTY_RESPONSE_CODE,
      )
    }

    for (const block of emittedBlocks) {
      if (block.kind === 'text') {
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      } else if (block.kind === 'reasoning') {
        if (block.text.trim() !== '') {
          yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
        }
      } else {
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.id),
            name: block.name,
            arguments: normalizeToolArguments(block.arguments),
          },
        }
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    const reason = announcedTools > 0
      ? { kind: 'tool-calls' as const }
      : finishReason === 'length' || finishReason === 'max_tokens'
        ? { kind: 'max-tokens' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }
}

/** Ensure a tool argument string is JSON the harness can parse. */
function normalizeToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return '{}'
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : '{}'
  } catch {
    // An upstream that truncates a large argument stream would otherwise fail
    // the harness's own tool-argument validation with a cryptic parse error.
    return raw
  }
}