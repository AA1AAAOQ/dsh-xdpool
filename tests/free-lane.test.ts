/**
 * The free lane, pinned from both ends.
 *
 * Three things about this lane are easy to get quietly wrong, so they are what
 * these tests are about:
 *
 * - The gateway gates the free tier on the shape of the request, not on a key.
 *   A turn missing one of the four lowercase quartet names answers
 *   `403 FreeTierError`, so the fingerprint pass is not decoration — and the
 *   pass must also not DISABLE tools the caller declared.
 * - Quota is counted per session id. A harness that mints a fresh session per
 *   turn spends the allowance and then reports the model as broken, so the same
 *   conversation must always produce the same session.
 * - The other two wires are not chat wire. Their streams are translated frame by
 *   frame, and a frame the caller cannot decode is a wrong answer rather than a
 *   missing one, so translation is checked against real payloads of each wire.
 *
 * Nothing here leaves the process: the transport has a seam, and every listing and
 * turn in this file is served by a local loopback listener or by that seam.
 */
import { describe, expect, it } from 'vitest'
import http, { createServer } from 'node:http'
import {
  FREE_CLIENT_UA,
  REQUEST_RE,
  SESSION_RE,
  applyFingerprint,
  baseModelId,
  freeLane,
  gatewayHeaders,
  mintRequestId,
  mintSessionId,
  postFreeStreamed,
  requestIdFor,
  restoreToolName,
  sessionForConversation,
  wireFor,
} from '../src/free-upstream.ts'
import {
  FreeToolWire,
  chatChunksFor,
  requestBodyFor,
  toolDefsFor,
} from '../src/free-messages.ts'
import {
  FALLBACK_FREE_MODEL_IDS,
  FreeCatalog,
  buildFreeCatalog,
  capabilitiesFor,
  displayModelName,
  isFreeLane,
  isRegionSensitive,
  parseListing,
} from '../src/free-catalog.ts'

const SLOW = 60_000

/** Feed one wire's event through the translation and return the chat deltas. */
function translate(wire: 'chat' | 'responses' | 'messages', payload: unknown, tools = new FreeToolWire([])) {
  return chatChunksFor(wire, payload, tools)
}

/** The concatenated `content` of every text delta in a delta sequence. */
function textOf(deltas: readonly Record<string, unknown>[]): string {
  return deltas.map(delta => (typeof delta.content === 'string' ? delta.content : '')).join('')
}

/** Every tool-call name a delta sequence emitted. */
function callNames(deltas: readonly Record<string, unknown>[]): string[] {
  const names: string[] = []
  for (const delta of deltas) {
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const call of calls) {
      const fn = (call as { function?: { name?: unknown } } | undefined)?.function
      if (typeof fn?.name === 'string') names.push(fn.name)
    }
  }
  return names
}

describe('the free lane request', () => {
  it('routes each model to the wire its endpoint speaks', () => {
    // A model answered on the wrong wire is a 404 or a silently different answer,
    // and the mapping is by model, so it is checked model by model.
    expect(wireFor('muse-spark-1.3-contributor-free')).toBe('responses')
    expect(wireFor('union-alpha')).toBe('messages')
    expect(wireFor('space-bunny-free')).toBe('chat')
    // An unknown id falls to chat, which is the shape everything starts as.
    expect(wireFor('some-model-nobody-has-heard-of')).toBe('chat')
    // The suffix a reasoning label adds must not move a model off its wire.
    expect(wireFor('muse-spark-1.3-contributor-free (high)')).toBe('responses')
    expect(baseModelId('muse-spark-1.3-contributor-free (high)')).toBe('muse-spark-1.3-contributor-free')
  })

  it('keeps one conversation on one session', () => {
    // Quota is counted per session id, so a fresh id per turn would spend the
    // allowance and then read as a broken model.
    const first = sessionForConversation('conversation-a')
    const second = sessionForConversation('conversation-a')
    expect(first).toBe(second)
    expect(SESSION_RE.test(first)).toBe(true)
    // Different conversations must NOT share, or one user's turns spend another's
    // allowance.
    expect(sessionForConversation('conversation-b')).not.toBe(first)
    // A session the caller already minted is honoured as-is: the harness owns
    // that id, and re-deriving it would split the conversation's history.
    const caller = mintSessionId()
    expect(sessionForConversation(caller)).toBe(caller)
    // No id at all still produces a valid one rather than an empty header.
    expect(SESSION_RE.test(sessionForConversation(undefined))).toBe(true)
  })

  it('keeps one turn on one request id', () => {
    const session = sessionForConversation('conversation-a')
    const first = requestIdFor(session, 'turn-1')
    expect(first).toBe(requestIdFor(session, 'turn-1'))
    expect(REQUEST_RE.test(first)).toBe(true)
    expect(requestIdFor(session, 'turn-2')).not.toBe(first)
    expect(REQUEST_RE.test(mintRequestId())).toBe(true)
    expect(REQUEST_RE.test(mintSessionId().replace('ses_', 'msg_'))).toBe(true)
  })

  it('identifies itself as the desktop client the gateway expects', () => {
    const headers = gatewayHeaders({ session: 'ses_x', requestId: 'msg_x', stream: true })
    // The pooled credential. A real key here reads as an unknown one.
    expect(headers.authorization).toBe('Bearer public')
    // The gateway checks this against a floor and rejects anything older.
    expect(headers['user-agent']).toBe(FREE_CLIENT_UA)
    expect(headers['x-opencode-client']).toBe('desktop')
    expect(headers['x-opencode-session']).toBe('ses_x')
    expect(headers['x-opencode-request']).toBe('msg_x')
    expect(headers.accept).toBe('text/event-stream')
    // A listing is JSON, and it asks for it explicitly.
    expect(gatewayHeaders({ session: 'ses_x', requestId: 'msg_x', stream: false, accept: 'application/json' }).accept).toBe(
      'application/json',
    )
  })
})

/** The names one tool-definition list declares, in whichever wire's spelling. */
function declaredNames(tools: unknown): string[] {
  return toolDefsFor(tools, 'chat').map(tool => {
    const fn = (tool as { function?: { name?: unknown } }).function
    return String(fn?.name ?? '')
  })
}

describe('the free lane fingerprint pass', () => {
  it('declares the whole quartet or the turn is refused', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'search_docs' }] }
    applyFingerprint(body, 'chat')
    // All four lowercase quartet names must be present or the gateway answers
    // 403 FreeTierError. The caller's own tool survives alongside them.
    expect(declaredNames(body.tools)).toEqual(expect.arrayContaining(['bash', 'glob', 'grep', 'read']))
    expect(declaredNames(body.tools)).toContain('search_docs')
  })

  it('promotes the real shell into the bash slot', () => {
    // On this host the shell tool is `pwsh`, not `bash`. Left alone, the turn is
    // admitted and then the model calls a tool nobody declared, 24 times a run.
    const body: Record<string, unknown> = {
      tools: [
        { type: 'function', function: { name: 'pwsh', description: 'run a command' } },
        { type: 'function', function: { name: 'list_dir', description: 'list' } },
      ],
    }
    const rename = applyFingerprint(body, 'chat')
    expect(rename.get('bash')).toBe('pwsh')
    expect(declaredNames(body.tools)).toContain('bash')
    expect(declaredNames(body.tools)).not.toContain('pwsh')
    // And the response side can put the caller's own name back.
    expect(restoreToolName('bash', rename)).toBe('pwsh')
  })

  it('never disables a tool the caller declared', () => {
    // A declared `Bash` is canonicalised to `bash`, not dropped: dropping it
    // would remove a tool the harness is offering the model.
    const body: Record<string, unknown> = {
      tools: [
        { type: 'function', function: { name: 'Bash', description: 'x' } },
        { type: 'function', function: { name: 'Read', description: 'x' } },
      ],
    }
    const rename = applyFingerprint(body, 'chat')
    expect(declaredNames(body.tools)).toContain('bash')
    expect(declaredNames(body.tools)).toContain('read')
    // Both were case variants, so each one still needs its own name restored on the
    // way back out — nothing was promoted into an empty slot.
    expect(rename.get('bash')).toBe('Bash')
    expect(rename.get('read')).toBe('Read')
  })

  it('fills a missing tool_choice only when there is nothing to choose from', () => {
    // With the caller's tools present, an invented `tool_choice` would force a
    // call the caller never asked for.
    const withTools: Record<string, unknown> = { tools: [{ name: 'search_docs' }] }
    applyFingerprint(withTools, 'chat')
    expect(withTools.tool_choice).toBeUndefined()

    // With only decoys declared, a chat-wire turn must refuse tools outright.
    const noTools: Record<string, unknown> = { tools: [] }
    applyFingerprint(noTools, 'chat')
    expect(noTools.tool_choice).toBe('none')

    // The Messages wire spells the same refusal differently.
    const claude: Record<string, unknown> = { tools: [] }
    applyFingerprint(claude, 'messages')
    expect(claude.tool_choice).toEqual({ type: 'none' })

    // The Responses wire asks the gateway to pick.
    const responses: Record<string, unknown> = { tools: [] }
    applyFingerprint(responses, 'responses')
    expect(responses.tool_choice).toBe('auto')
  })

  it('makes a promoted tool callable rather than merely present', () => {
    // The pass renamed `pwsh` to `bash`. If the response side judged the
    // incoming `bash` against the quartet without restoring it first, the call
    // would be judged a decoy and dropped — the tool would be visible to the
    // model and unreachable by the harness. The wire is given the rename map for
    // exactly this.
    const body: Record<string, unknown> = {
      tools: [{ type: 'function', function: { name: 'pwsh', description: 'x' } }],
    }
    const rename = applyFingerprint(body, 'chat')
    const tools = new FreeToolWire(body.tools, rename)
    // The model calls the slot it was given.
    const frames = tools.admit('c0', 'bash', '{"command":"ls"}', 'call_1')
    expect(callNames(frames)).toEqual(['pwsh'])
    expect(tools.calls()).toBe(1)
    expect(tools.suppressed()).toBe(false)
  })

  it('drops a decoy call the caller cannot run', () => {
    const tools = new FreeToolWire([{ type: 'function', function: { name: 'search_docs' } }])
    expect(tools.admit('c0', 'bash', '{}')).toEqual([])
    expect(tools.calls()).toBe(0)
    // The call the caller CAN run survives.
    expect(callNames(tools.admit('c1', 'search_docs', '{}', 'call_2'))).toEqual(['search_docs'])
    expect(tools.calls()).toBe(1)
  })

  it('holds arguments that arrive before the name, then releases them', () => {
    // A provider that streams arguments before naming the block is rare but real.
    // Forwarding them optimistically would leak a dropped block's fragments.
    const tools = new FreeToolWire([{ name: 'search_docs' }])
    expect(tools.admit('c0', undefined, '{"q":')).toEqual([])
    const frames = tools.admit('c0', 'search_docs', '"cats"}', 'call_1')
    const args = frames
      .flatMap(delta => (Array.isArray(delta.tool_calls) ? delta.tool_calls : []))
      .map(call => (call as { function?: { arguments?: unknown } }).function?.arguments)
      .filter((value): value is string => typeof value === 'string')
      .join('')
    expect(args).toBe('{"q":"cats"}')
  })
})

describe('the free lane request translation', () => {
  it('reads tool definitions in both spellings', () => {
    // The Responses wire spells a tool flat; the other two nest it under
    // `function`. Reading only one shape silently drops every tool of the other
    // wire, and the turn then answers as if the model had no tools at all.
    const flat = toolDefsFor([{ type: 'function', name: 'search_docs', parameters: {} }], 'responses')
    expect(flat).toEqual([{ type: 'function', name: 'search_docs', description: '', parameters: {} }])
    const nested = toolDefsFor([{ type: 'function', function: { name: 'search_docs', parameters: {} } }], 'chat')
    expect(nested).toEqual([
      { type: 'function', function: { name: 'search_docs', description: '', parameters: {} } },
    ])
    // And the Messages wire names the schema its own way.
    expect(toolDefsFor([{ name: 'search_docs' }], 'messages')[0]).toHaveProperty('input_schema')
  })

  it('re-spells a request for the Messages wire', () => {
    const warnings: string[] = []
    const out = requestBodyFor(
      'messages',
      {
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 64,
        temperature: 0.2,
      },
      { modelId: 'union-alpha', warnings },
    )
    expect(out.system).toBe('be brief')
    expect(Array.isArray(out.messages)).toBe(true)
    expect(out.max_tokens).toBe(64)
    // The field name is the wire's, not the caller's.
    expect(out.max_output_tokens).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('re-spells a request for the Responses wire', () => {
    const warnings: string[] = []
    const out = requestBodyFor(
      'responses',
      {
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 64,
      },
      { modelId: 'muse-spark-1.3-contributor-free', warnings },
    )
    expect(out.instructions).toBe('be brief')
    expect(Array.isArray(out.input)).toBe(true)
    // Same field, the other wire's name.
    expect(out.max_output_tokens).toBe(64)
    expect(out.max_tokens).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('leaves the chat wire alone', () => {
    const warnings: string[] = []
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    const out = requestBodyFor('chat', body, { modelId: 'space-bunny-free', warnings })
    // Re-encoding the chat wire risks splitting a multi-byte character at a
    // frame boundary, so its message list is passed straight through.
    expect(out.messages).toEqual(body.messages)
    expect(out.model).toBe('space-bunny-free')
  })
})

describe('the free lane stream translation', () => {
  it('passes the chat wire through', () => {
    const event = translate('chat', {
      choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
    expect(textOf(event.frames)).toBe('hello')
    expect(event.finish).toBe('stop')
    expect(event.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 })
  })

  it('translates a Messages stream', () => {
    const tools = new FreeToolWire([{ name: 'search_docs' }])
    const start = translate('messages', {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2 } },
    }, tools)
    // Anthropic reports cache reads separately; the chat spelling counts them as
    // prompt tokens, because the model was actually read.
    expect(start.usage?.prompt_tokens).toBe(12)

    const block = translate('messages', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    }, tools)
    expect(block.frames).toEqual([])

    const text = translate('messages', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    }, tools)
    expect(textOf(text.frames)).toBe('hi')

    const thinking = translate('messages', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    }, tools)
    expect(thinking.frames[0]).toEqual({ reasoning_content: 'hmm' })

    const end = translate('messages', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, tools)
    expect(end.finish).toBe('length')

    const stop = translate('messages', { type: 'message_stop' }, tools)
    // Its own end frame: a stream that carried it was closed on purpose, so it
    // must not read as a cut one.
    expect(stop.done).toBe(true)
    expect(stop.frames).toEqual([])
  })

  it('names a Messages tool call for the harness', () => {
    const tools = new FreeToolWire([{ name: 'search_docs' }])
    const opened = translate('messages', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'search_docs', id: 'call_1' },
    }, tools)
    expect(callNames(opened.frames)).toEqual(['search_docs'])
    const args = translate('messages', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"cats"}' },
    }, tools)
    expect(tools.calls()).toBe(1)
    expect(args.frames.length).toBeGreaterThan(0)
  })

  it('reads every terminal frame of the Responses wire', () => {
    // Only reading `response.completed` made `response.incomplete` — the frame a
    // turn that hit the output ceiling ends on — look like a stream the gateway
    // cut, so a finished turn got retried and then failed.
    for (const type of ['response.completed', 'response.incomplete', 'response.failed', 'response.done']) {
      const event = translate('responses', {
        type,
        response: { status: type === 'response.incomplete' ? 'incomplete' : 'completed', usage: { input_tokens: 5, output_tokens: 1 } },
      })
      expect(event.done, `${type} must end the turn`).toBe(true)
    }
    const incomplete = translate('responses', {
      type: 'response.incomplete',
      response: { status: 'incomplete', usage: { input_tokens: 5, output_tokens: 1 } },
    })
    // Hit the ceiling: reported as such, not as a clean stop.
    expect(incomplete.finish).toBe('length')
    expect(incomplete.usage?.prompt_tokens).toBe(5)
  })

  it('translates Responses text, reasoning and tool calls', () => {
    const tools = new FreeToolWire([{ name: 'search_docs' }])
    const text = translate('responses', { type: 'response.output_text.delta', delta: 'hi' }, tools)
    expect(textOf(text.frames)).toBe('hi')

    const reasoning = translate('responses', { type: 'response.reasoning_summary_text.delta', delta: 'hmm' }, tools)
    expect(reasoning.frames[0]).toEqual({ reasoning_content: 'hmm' })

    const opened = translate('responses', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', name: 'search_docs', call_id: 'call_1' },
    }, tools)
    expect(callNames(opened.frames)).toEqual(['search_docs'])

    const args = translate('responses', {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"q":"cats"}',
    }, tools)
    expect(args.frames.length).toBeGreaterThan(0)
    expect(tools.calls()).toBe(1)
  })

  it('takes reasoning from whichever field the gateway used', () => {
    // Four spellings exist in the wild. Taking the first non-empty one avoids
    // double-counting a thought that arrives under two names.
    for (const field of ['reasoning', 'reasoning_content', 'reasoning_text', 'thinking']) {
      const event = translate('chat', { choices: [{ delta: { [field]: 'hmm' } }] })
      expect(event.frames[0], `${field} must be read`).toEqual({ reasoning_content: 'hmm' })
    }
  })
})

describe('the free lane transport', () => {
  interface Seen {
    method: string
    url: string
    headers: Record<string, unknown>
    body: string
  }

  /**
   * Serve one scripted answer from loopback.
   *
   * The module's own transport reads its base URL once at import, so pointing the
   * suite at a random port would need an import hook. The transport already
   * carries a seam for exactly this, so the seam is what routes the request — and
   * the request it forwards is a real one over a real socket, so the bytes under
   * test are the bytes the gateway would receive.
   */
  async function withGateway(
    answers: { listing?: string; turn: { status?: number; headers?: Record<string, string>; body: string } },
    run: (seen: Seen[]) => Promise<void>,
  ): Promise<void> {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(answers.listing ?? '{"data":[{"id":"space-bunny-free"}]}')
          return
        }
        res.writeHead(answers.turn.status ?? 200, {
          'content-type': 'text/event-stream',
          ...(answers.turn.headers ?? {}),
        })
        res.end(answers.turn.body)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const previous = freeLane.fetch
    freeLane.fetch = {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const target = new URL(url)
        return httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: `${target.pathname}${target.search}`,
            method: init.method ?? 'GET',
            headers: init.headers ?? {},
          },
          init.body,
        )
      },
    }
    try {
      await run(seen)
    } finally {
      freeLane.fetch = previous
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  /** One loopback request, answered as a WHATWG `Response`. */
  function httpRequest(
    options: {
      hostname: string
      port: number
      path: string
      method: string
      headers: Record<string, string>
    },
    body: string | undefined,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = http.request(options, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk as Buffer))
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              headers: response.headers as unknown as HeadersInit,
            }),
          )
        })
      })
      request.on('error', reject)
      if (body !== undefined) request.write(body, 'utf8')
      request.end()
    })
  }

  it('answers a chat-wire turn with deltas', async () => {
    const deltas: Record<string, unknown>[] = []
    let seen: Seen[] = []
    await withGateway(
      {
        turn: {
          body: [
            'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n'),
        },
      },
      async requestLog => {
        seen = requestLog
        const result = await postFreeStreamed({
          modelId: 'space-bunny-free',
          body: { messages: [{ role: 'user', content: 'hi' }] },
          session: 'ses_0000000000000000000000000000',
          requestId: 'msg_0000000000000000000000000000',
          hooks: { onDelta: delta => deltas.push(delta) },
        })
        expect(result.status).toBe(200)
        expect(result.finishReason).toBe('stop')
        // The usage frame goes last and carries no choices, so a decoder reading
        // choices does not trip over it.
        expect(deltas[deltas.length - 1]).toEqual({
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        })
        expect(textOf(deltas)).toBe('hi')
      },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toBe('/zen/v1/chat/completions')
    // The pooled credential, on the wire, not just in the helper.
    expect(seen[0]?.headers.authorization).toBe('Bearer public')
    expect(seen[0]?.headers['x-opencode-session']).toBe('ses_0000000000000000000000000000')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ model: 'space-bunny-free', stream: true })
  }, SLOW)

  it('holds the finish reason to what the caller can run', async () => {
    const deltas: Record<string, unknown>[] = []
    await withGateway(
      {
        turn: {
          body: [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
            '',
          ].join('\n'),
        },
      },
      async () => {
        const result = await postFreeStreamed({
          modelId: 'space-bunny-free',
          // Only `search_docs` is declared, so `bash` is a decoy.
          body: { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'search_docs' }] },
          session: 'ses_0000000000000000000000000000',
          requestId: 'msg_0000000000000000000000000000',
          hooks: { onDelta: delta => deltas.push(delta) },
        })
        // The gateway reported a call nobody can run. Echoing `tool_calls` would
        // leave the turn demanding a retry forever.
        expect(result.finishReason).toBe('stop')
        expect(result.suppressedOnly).toBe(true)
        expect(callNames(deltas)).toEqual([])
      },
    )
  }, SLOW)

  it('answers a JSON body to a stream request as a delta sequence', async () => {
    // A front proxy that mislabels a JSON body as an event stream is common.
    // Believing the header truncates real answers.
    const deltas: Record<string, unknown>[] = []
    await withGateway(
      {
        turn: {
          // Declared as text/event-stream, delivered as JSON.
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        },
      },
      async () => {
        const result = await postFreeStreamed({
          modelId: 'space-bunny-free',
          body: { messages: [{ role: 'user', content: 'hi' }] },
          session: 'ses_0000000000000000000000000000',
          requestId: 'msg_0000000000000000000000000000',
          hooks: { onDelta: delta => deltas.push(delta) },
        })
        expect(textOf(deltas)).toBe('hi')
        expect(result.finishReason).toBe('stop')
      },
    )
  }, SLOW)

  it('answers a Responses document to a stream request as a delta sequence', async () => {
    const deltas: Record<string, unknown>[] = []
    let seen: Seen[] = []
    await withGateway(
      {
        turn: {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'response',
            response: {
              status: 'completed',
              usage: { input_tokens: 4, output_tokens: 2 },
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
            },
          }),
        },
      },
      async requestLog => {
        seen = requestLog
        const result = await postFreeStreamed({
          modelId: 'muse-spark-1.3-contributor-free',
          body: { messages: [{ role: 'user', content: 'hi' }] },
          session: 'ses_0000000000000000000000000000',
          requestId: 'msg_0000000000000000000000000000',
          hooks: { onDelta: delta => deltas.push(delta) },
        })
        expect(textOf(deltas)).toBe('hi')
        expect(result.finishReason).toBe('stop')
        // The document's own usage survives the replay.
        expect(deltas[deltas.length - 1]).toHaveProperty('usage')
      },
    )
    expect(seen[0]?.url).toBe('/zen/v1/responses')
  }, SLOW)
}, SLOW)

/**
 * Run `fn` with the free lane's transport answering with a canned response.
 *
 * No loopback server here on purpose. The listing half of this file only needs
 * one response object, and building a server for it meant reaching for a helper
 * that lives inside the transport `describe` below -- a cross-scope call that
 * throws a ReferenceError the catalog's own catch swallows, so a broken stub
 * looks exactly like a working one. The seam takes a `Response`, which is all
 * `freeFetch` ever returns, and nothing outside this closure is involved.
 */
async function withListing(
  answer: () => Response | (() => Promise<Response>),
  run: () => Promise<void>,
): Promise<void> {
  const previous = freeLane.fetch
  freeLane.fetch = {
    fetch: async () => (typeof answer === 'function' ? await answer() : answer),
  }
  try {
    await run()
  } finally {
    freeLane.fetch = previous
  }
}

/** One canned listing response, as the gateway's own JSON shape. */
function listingReply(ids: readonly string[]): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('the free lane catalog', () => {
  it('advertises only the免密 ids, prefixed for routing', () => {
    // The prefix is what the shim routes on, so it is applied in one place.
    expect(isFreeLane('space-bunny-free')).toBe(true)
    expect(isFreeLane('union-alpha')).toBe(true)
    expect(isFreeLane('some-paid-model')).toBe(false)
    const rows = buildFreeCatalog(['space-bunny-free', 'some-paid-model', 'union-alpha', 'space-bunny-free'])
    expect(rows.map(row => row.modelId)).toEqual(['free:space-bunny-free', 'free:union-alpha'])
    // The bare id stays beside the prefixed one: the wire needs the bare name.
    expect(rows[0]?.id).toBe('space-bunny-free')
    expect(rows[0]?.name).toBe(displayModelName('space-bunny-free'))
  })

  it('reads capabilities off the model, with a baseline for unknown ids', () => {
    expect(capabilitiesFor('union-alpha').vision).toBe(true)
    // An id no table names falls back rather than claiming a window of zero,
    // which would make the picker unusable.
    const unknown = capabilitiesFor('model-nobody-has-heard-of')
    expect(unknown.contextWindow).toBeGreaterThan(0)
    expect(unknown.maxOutput).toBeGreaterThan(0)
    // Region-sensitive models answer differently depending on where the request
    // leaves from, so the row says so.
    expect(isRegionSensitive('muse-spark-1.3-contributor-free')).toBe(true)
    expect(isRegionSensitive('union-alpha')).toBe(false)
  })

  it('starts from a static roster so an unreachable gateway still answers', () => {
    // An empty group is the one shape a user reads as "the plugin is broken".
    const catalog = new FreeCatalog()
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(catalog.hasRows()).toBe(true)
    expect(FALLBACK_FREE_MODEL_IDS.length).toBeGreaterThan(0)
  })

  /**
 * The regression this guards is "a failed refresh empties the picker".
 *
 * Previously this test called the real gateway and swallowed the result, so it
 * passed whether the refresh worked or failed -- it never exercised the branch
 * it was named for, and it inherited the network's latency, which is what made
 * it time out under a parallel run. Both answers are now served by a loopback
 * server, so the failure path is the one under test and the duration is ours.
 */
it('keeps its rows when a listing refresh fails', async () => {
  const catalog = new FreeCatalog()
  const before = catalog.current().length
  expect(before).toBeGreaterThan(0)

  for (const reply of [
    new Response('upstream is unwell', { status: 500 }),
    // A 200 that is HTML: the gateway answering with a landing page is a real
    // failure mode, and JSON.parse has to be what rejects it.
    new Response('<!doctype html><title>not json</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    new Response(JSON.stringify({ data: 'not-a-list' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    await withListing(() => reply, async () => {
      await catalog.refresh({ session: 'ses_0000000000000000000000000000' }).catch(() => null)
      // Whatever the gateway did, the picker must still have models in it: an
      // empty group is the one shape a user reads as "the plugin is broken".
      expect(catalog.current().length).toBeGreaterThanOrEqual(1)
    })
  }
})

it('takes a working listing when one arrives, and keeps it through a later failure', async () => {
  const catalog = new FreeCatalog()
  await withListing(() => listingReply(['space-bunny-free', 'union-alpha']), async () => {
    await catalog.refresh({ session: 'ses_0000000000000000000000000000' })
  })
  const live = catalog.current().map(row => row.modelId)
  // A live listing REPLACES the static roster rather than merging into it: the
  // gateway is the authority on what is free right now, and a roster kept
  // alongside it would keep offering models the upstream has already retired.
  // The static list is the offline fallback, not a second source of truth.
  expect(live).toEqual(['free:space-bunny-free', 'free:union-alpha'])
  expect(catalog.updatedAt()).toBeTruthy()
  expect(catalog.error()).toBeUndefined()

  // And a later failure must not roll any of that back to the static list.
  await withListing(() => new Response('gone', { status: 503 }), async () => {
    await catalog.refresh({ session: 'ses_0000000000000000000000000000' }).catch(() => null)
  })
  expect(catalog.current().map(row => row.modelId)).toEqual(live)
  expect(catalog.error()).toBeTruthy()
})

it('records why a refresh failed, without clearing the rows it already had', async () => {
  const catalog = new FreeCatalog()
  const before = catalog.current().length
  await withListing(() => new Response('gone', { status: 503 }), async () => {
    await catalog.refresh({ session: 'ses_0000000000000000000000000000' }).catch(() => null)
  })
  expect(catalog.current().length).toBe(before)
  // The error is kept so the page can say why the numbers may be stale, rather
  // than silently showing a roster nobody can verify.
  expect(catalog.error()).toBeTruthy()
})
})