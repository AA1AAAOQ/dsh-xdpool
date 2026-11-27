/**
 * `codearts` as a host adapter owned by this plugin.
 *
 * The vendored channel pack already registers a `codearts` provider, and this
 * class is the replacement requested for it: same provider id, same model
 * names, but the transport is {@link CodeartsUpstream} — the CodeArts2API
 * request path, with a stable `x-ot-session-id` and no queue polling. The pack's
 * adapter is told to stand aside through `DSH_XDPOOL_OWNS_POOL_LANES` (see
 * `mountChannelPack`), so the two never race for the route.
 *
 * Login, the account list, the model blacklist and credits still belong to the
 * pack: this class only answers the five `LlmAdapter` methods, and every request
 * re-reads the pool through the cordis scope the pack provided. That split is
 * deliberate — a scan sign-in must keep landing in the one pool the channel card
 * already renders.
 *
 * @module dsh-xdpool/codearts-host-adapter
 */
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  CODEARTS_MAX_OUTPUT_TOKENS,
  CODEARTS_MODELS,
  CODEARTS_PROVIDER_ID,
  CODEARTS_PROVIDER_NAME,
  type CodeArtsModelRow,
} from './codearts-protocol.ts'
import { CodeartsUpstream, type CodeArtsLogger } from './codearts-upstream.ts'

/** Everything the adapter needs, with every I/O seam injectable. */
export interface CodeartsHostAdapterOptions {
  /** Lazy cordis scope that carries the pack's `accountPool`. */
  scope: () => unknown
  logger?: CodeArtsLogger
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Test seam; overrides the upstream origin. */
  baseUrl?: string
  /** Test seam; replaces the retry sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Test seam; replaces the clock. */
  now?: () => number
}

/** Reasoning is a plain on/off switch on this gateway. */
const EFFORTS = [
  { id: ReasoningEffortId('on'), name: '开启' },
  { id: ReasoningEffortId('off'), name: '关闭' },
] as const

/**
 * The provider implementation.
 *
 * `listModels` always returns the shipped roster. It deliberately does not gate
 * on a signed-in account the way the pack did: the host caches a provider's
 * catalogue per route, and a gate that flips only after a scan sign-in left the
 * CodeArts group absent until a restart whenever the picker had been opened
 * beforehand. A model row that cannot serve yet is a better failure than a
 * provider that vanished.
 */
export class CodeartsHostAdapter extends LlmAdapter {
  private readonly upstream: CodeartsUpstream

  constructor(options: CodeartsHostAdapterOptions) {
    super()
    this.upstream = new CodeartsUpstream(options)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider !== '' ? provider : CODEARTS_PROVIDER_ID
    return { id, name: CODEARTS_PROVIDER_NAME }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const id = typeof provider === 'string' && provider !== '' ? provider : CODEARTS_PROVIDER_ID
    const hidden = this.upstream.disabledModels()
    return CODEARTS_MODELS
      .filter(row => !hidden.has(row.id))
      .map(row => ({
        provider: id,
        id: row.id,
        name: row.name,
        inputModalities: ['text'],
      }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const id = typeof provider === 'string' && provider !== '' ? provider : CODEARTS_PROVIDER_ID
    const row = CODEARTS_MODELS.find(entry => entry.id === model)
    return this.describe(id, row ?? { id: model, name: model })
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    return { model: resolved, stream: (options: GenerateOptions) => this.stream(options) }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.upstream.stream(options)
  }

  /** Whether any CodeArts account is signed in, for callers that want to warn. */
  hasAccounts(): boolean {
    return this.upstream.hasAccounts()
  }

  /** Everything the picker shows for one model. */
  private describe(provider: string, row: CodeArtsModelRow): LlmResolvedModelInfo {
    return {
      provider,
      id: row.id,
      name: row.name,
      // The pack serialized images away, so claiming image input here would
      // promise a capability the wire never carried. Text-only is the honest
      // answer until this adapter actually forwards image parts.
      inputModalities: ['text'],
      defaultMaxTokens: CODEARTS_MAX_OUTPUT_TOKENS,
      ...(row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow } }),
      reasoning: { efforts: [...EFFORTS], defaultEffort: ReasoningEffortId('on') },
    }
  }
}