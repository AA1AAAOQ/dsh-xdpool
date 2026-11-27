/**
 * Behaviour of the replacement CodeArts provider.
 *
 * These tests drive the adapter against a scripted fetch, so what is pinned is
 * the wire contract the CodeArts2API port exists for:
 *
 * - one stable `x-ot-session-id` per credential across turns (the upstream's
 *   per-account concurrency counter sees a session, not one per request);
 * - `TM.00001041` is retried in ~1s, not polled against
 *   `/api/v1/queue/status` for thirty minutes;
 * - a request-shaped 400 fails on the first attempt;
 * - a 401 refreshes the pack credential once, then retries;
 * - a quota rejection parks that account and rotates.
 *
 * @module dsh-xdpool/tests/codearts-adapter
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageId, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodeartsHostAdapter } from '../src/codearts-host-adapter.ts'
import type { CodeArtsCredential } from '../src/codearts-protocol.ts'

const MODEL = 'deepseek-v4.1-flash'

/** A credential old enough to be used as-is (expires in an hour). */
function credential(overrides: Partial<CodeArtsCredential> = {}): CodeArtsCredential {
  return {
    access_key_id: 'HSTAAAAAAAAAAAAAAAAAAA',
    secret_access_key: 'sk-secret-0123456789abcdef',
    security_token: 'sts-token-abc123',
    domain_id: 'hid-0123456789',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refresh_token: 'refresh-1',
    ...overrides,
  }
}

interface FakeEntry {
  id: string
  provider: string
  enabled: boolean
  credentialRef: string
}

/** A minimal pack pool: selection order, cooldowns, and a mutable credential map. */
class FakePool {
  readonly entries: FakeEntry[]
  readonly credentials = new Map<string, CodeArtsCredential>()
  readonly cooldowns: { id: string; model: string; resetAt: number }[] = []

  constructor(accounts: { id: string; credential: CodeArtsCredential }[]) {
    this.entries = accounts.map(({ id }) => ({
      id,
      provider: 'codearts',
      enabled: true,
      credentialRef: `CODEARTS_ACCOUNT_${id}`,
    }))
    for (const { id, credential: value } of accounts) this.credentials.set(`CODEARTS_ACCOUNT_${id}`, value)
  }

  async getAvailableAccount(
    provider: string,
    _model: string,
    exclude?: ReadonlySet<string>,
  ): Promise<{ entry: FakeEntry; credential: CodeArtsCredential } | null> {
    const entry = this.entries.find(candidate => candidate.provider === provider
      && candidate.enabled
      && !(exclude?.has(candidate.id) ?? false))
    if (entry === undefined) return null
    return { entry, credential: this.credentials.get(entry.credentialRef) as CodeArtsCredential }
  }

  async resolveCredentialByRef(refName: string): Promise<CodeArtsCredential | undefined> {
    return this.credentials.get(refName)
  }

  listAccountsByProvider(provider: string): readonly FakeEntry[] {
    return this.entries.filter(entry => entry.provider === provider)
  }

  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    this.cooldowns.push({ id: accountId, model: modelId, resetAt: resetAtMs })
  }
}

/** A fake refresh service that rotates the credential in place. */
class FakeAuth {
  calls = 0
  constructor(private readonly pool: FakePool, private readonly next: (current: CodeArtsCredential) => CodeArtsCredential) {}

  async refreshAccountCredential(refName: string, _pool: unknown, _accountId: string): Promise<void> {
    this.calls += 1
    const current = this.pool.credentials.get(refName)
    if (current === undefined) throw new Error('missing credential')
    this.pool.credentials.set(refName, this.next(current))
  }
}

function scopeOf(pool: FakePool, auth?: FakeAuth): unknown {
  return {
    get(name: string): unknown {
      if (name === 'accountPool') return pool
      if (name === 'codeartsAuth') return auth
      return undefined
    },
  }
}

/** Build one SSE response body from lines. */
function sse(lines: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Options with a user turn and one tool schema. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codearts',
    model: MODEL,
    messages: [
      {
        id: MessageId('m1'),
        role: 'user',
        content: [{ type: 'text', text: 'read the file' }],
        source: { kind: 'user' },
      },
    ],
    tools: [
      {
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    ...overrides,
  }
}

/** Collect every chunk of one turn. */
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('replacement CodeArts provider', () => {
  it('advertises the roster and resolves an unlisted id from its own name', async () => {
    const adapter = new CodeartsHostAdapter({ scope: () => undefined, sleep: async () => {} })
    const models = await adapter.listModels('codearts')
    expect(models.map(model => model.id)).toContain('glm-5.3')
    expect(models.map(model => model.id)).toContain('deepseek-v4.1-flash')
    const resolved = await adapter.resolveModel('codearts', 'deepseek-v4.1-flash')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(65_536)
    const unknown = await adapter.resolveModel('codearts', 'experimental-model')
    expect(unknown.id).toBe('experimental-model')
    expect(unknown.defaultMaxTokens).toBe(65_536)
  })

  it('drops half tool pairs and keeps reasoning_content on assistant history', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    let body = ''
    const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
      body = String(init.body)
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    await collect(adapter.stream(request({
      messages: [
        {
          id: MessageId('m1'),
          role: 'user',
          content: [{ type: 'text', text: 'go' }],
          source: { kind: 'user' },
        },
        {
          id: MessageId('m2'),
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'calling' },
            { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"path":"a"}' },
            // A call whose result was cut by compaction: the upstream rejects it.
            { type: 'tool-call', id: ToolCallId('c2'), name: 'read', arguments: '{"path":"b"}' },
          ],
          source: { kind: 'model', provider: 'codearts', model: MODEL },
        },
        {
          id: MessageId('m3'),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('c1'),
            content: [{ type: 'text', text: 'file contents' }],
          }],
          source: { kind: 'tool', callId: ToolCallId('c1') },
        },
      ],
    })))
    const payload = JSON.parse(body) as {
      messages: {
        role: string
        content: string
        reasoning_content?: string
        tool_calls?: { id: string }[]
        tool_call_id?: string
      }[]
    }
    const assistant = payload.messages.find(message => message.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('thinking')
    expect(assistant?.tool_calls?.map(call => call.id)).toEqual(['c1'])
    const tool = payload.messages.find(message => message.role === 'tool')
    expect(tool?.tool_call_id).toBe('c1')
    expect(tool?.content).toBe('file contents')
  })

  it('sends one stable session id and parses text, reasoning and tool calls', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
      seen.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      })
      return sse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'considering' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'reading ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'now' } }] }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                function: { name: 'read', arguments: '{"path":' },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
          }],
        }),
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
      ])
    })
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })

    const chunks = await collect(adapter.stream(request()))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain('/api/v2/chat/completions')
    expect(seen[0]?.headers['x-ot-session-id']).toMatch(/^ses_[0-9a-f]{16}$/u)
    expect(seen[0]?.headers['user-session-id']).toBe(seen[0]?.headers['x-ot-session-id'])
    expect(seen[0]?.headers['model-id']).toBe(MODEL)
    expect(seen[0]?.headers['model-name']).toBe(MODEL)
    expect(seen[0]?.headers['Authorization']).toContain('x-ot-session-id')
    expect(seen[0]?.body).toContain('"tool_stream":true')
    expect(seen[0]?.body).toContain('"model":"deepseek-v4.1-flash"')

    const types = chunks.map(chunk => (chunk as { type: string }).type)
    expect(types.filter(type => type === 'block-start')).toHaveLength(3)
    expect(types).toContain('text-delta')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('tool-call-delta')
    const toolEnd = chunks.find(chunk => (chunk as { type: string }).type === 'block-end'
      && (chunk as { block: { type: string } }).block.type === 'tool-call')
    expect((toolEnd as { block: { arguments: string } }).block.arguments).toBe('{"path":"a.txt"}')
    const usage = chunks.find(chunk => (chunk as { type: string }).type === 'usage') as {
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
    }
    // CodeArts reports a total prompt count; the harness wants disjoint counts.
    expect(usage.usage.inputTokens).toBe(6)
    expect(usage.usage.cacheReadTokens).toBe(4)
    const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('reuses the session id across two turns of the same credential', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    const seen: string[] = []
    const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
      seen.push((init.headers as Record<string, string>)['x-ot-session-id'] ?? '')
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    await collect(adapter.stream(request()))
    await collect(adapter.stream(request()))
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    expect(seen[1]).not.toBe('')
  })

  it('retries TM.00001041 briefly without touching the queue-status endpoint', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    const urls: string[] = []
    const sleeps: number[] = []
    const fetchImpl = async (url: unknown): Promise<Response> => {
      urls.push(String(url))
      if (urls.length === 1) {
        return new Response('{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: 'after retry' } }] })])
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    const chunks = await collect(adapter.stream(request()))
    expect(urls).toHaveLength(2)
    expect(sleeps).toEqual([1000])
    expect(urls.every(url => !url.includes('/queue/status'))).toBe(true)
    expect(chunks.some(chunk => (chunk as { type: string }).type === 'text-delta')).toBe(true)
    // The point of the fix: the retry is one second, not the pack's ten-second
    // queue poll repeated for up to thirty minutes.
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(5000)
  })

  it('fails a request-shaped 400 immediately', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return new Response('{"error_code":"InferHub.001001005.400","error_msg":"temperature -> should be between 0 and 2"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(calls).toBe(1)
  })

  it('refreshes once on 401, then retries with the new credential', async () => {
    const pool = new FakePool([{ id: 'a1', credential: credential() }])
    const auth = new FakeAuth(pool, current => credential({
      access_key_id: 'HSTNEWKEY000000000000',
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      // Same domain: the session id changes because the AK changed.
      domain_id: current.domain_id,
    }))
    const seen: string[] = []
    let calls = 0
    const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
      calls += 1
      seen.push((init.headers as Record<string, string>)['x-ot-session-id'] ?? '')
      if (calls === 1) {
        return new Response('{"error_code":"APIG.0301","error_msg":"signature verify failed"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: 'fresh' } }] })])
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool, auth),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    const chunks = await collect(adapter.stream(request()))
    expect(auth.calls).toBe(1)
    expect(calls).toBe(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(chunks.some(chunk => (chunk as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('parks a quota-exhausted account and rotates to the next one', async () => {
    const pool = new FakePool([
      { id: 'a1', credential: credential() },
      { id: 'a2', credential: credential({ access_key_id: 'HSTBBBBBBBBBBBBBBBBB', domain_id: 'hid-b' }) },
    ])
    const seenKeys: string[] = []
    let calls = 0
    const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
      calls += 1
      seenKeys.push((init.headers as Record<string, string>)['x-ot-access-key'] ?? (init.headers as Record<string, string>)['Authorization'] ?? '')
      if (calls === 1) {
        return new Response('{"error_code":"TM.00001050","error_msg":"您的积分已耗尽"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: 'second account' } }] })])
    }
    const adapter = new CodeartsHostAdapter({
      scope: () => scopeOf(pool),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })
    const chunks = await collect(adapter.stream(request()))
    expect(pool.cooldowns).toHaveLength(1)
    expect(pool.cooldowns[0]?.id).toBe('a1')
    expect(pool.cooldowns[0]?.model).toBe(MODEL)
    expect(calls).toBe(2)
    expect(seenKeys[0]).not.toBe(seenKeys[1])
    expect(chunks.some(chunk => (chunk as { type: string }).type === 'text-delta')).toBe(true)
  })
})