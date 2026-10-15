/**
 * Usage accounting, wired end to end.
 *
 * `tests/usage-stats.test.ts` pins the arithmetic; this file pins the WIRING,
 * because the two halves drift apart silently while both still pass their own
 * tests. Four failures are invisible to unit tests and fatal in production:
 *
 *   - asking the gateway for usage and NOT stripping it, so the host receives
 *     an SSE event it never requested;
 *   - stripping it and never looking, so the panel reports "not reported"
 *     about a gateway that answered;
 *   - filing the same physical call twice, so one turn that rotated reads as
 *     two;
 *   - filing a refusal no request ever made.
 *
 * Every case asserts BOTH sides of one call - what the host received AND what
 * the recorder holds. A test that checked only one half would pass under
 * exactly the bug it exists to catch.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { UsageRecorder } from '../src/stats.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** An auth directory holding `count` distinct live accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbusage-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    await writeFile(join(auth, `workbuddy-desktop.${i}.info`), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A pooled shim wired to a recorder, already bound and ready to serve. */
async function shimWith(
  recorder: UsageRecorder,
  fetchImpl: (url: unknown, init: RequestInit) => Promise<Response>,
  options: { authDirs?: string[]; maxAttempts?: number } = {},
): Promise<{ pool: WorkBuddyAccountPool; shim: { baseUrl(): string; token(): string } }> {
  const pool = new WorkBuddyAccountPool({ authDirs: options.authDirs ?? [await fakeAuthDir(1)] })
  await pool.scan()
  const shim = createWorkBuddyShim({
    pool,
    client: new WorkBuddyUpstreamClient({ fetchImpl: fetchImpl as never }),
    catalog: new WorkBuddyCatalog(),
    region: 'cn',
    usageRecorder: recorder,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
  shims.push(shim)
  await shim.ready
  return { pool, shim }
}

/** Ask the shim one chat turn and read the whole SSE body back. */
async function ask(shim: { baseUrl(): string; token(): string }): Promise<{ status: number; text: string }> {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: response.status, text: await response.text() }
}

/** Three SSE frames: an answer, a usage trailer, and the sentinel. */
function usageStream(input: number, output: number): string {
  return 'data: {"choices":[{"delta":{"content":"早"}}]}\n\n'
    + `data: {"choices":[],"usage":{"prompt_tokens":${input},"completion_tokens":${output}}}\n\n`
    + 'data: [DONE]\n\n'
}

describe('usage wiring', () => {
  it('asks for the numbers and takes them back before the host sees them', async () => {
    // Only the chat request is recorded. `serveSuccessfulStream` fires a
    // background balance refresh through the same fetch, so capturing "the last
    // body seen" silently measures THAT request instead - one that has no
    // `stream_options` at all, for reasons that have nothing to do with the
    // wiring under test. An assertion about a request's fields must pin the
    // request it means.
    const chatBodies: string[] = []
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(recorder, async (url, init) => {
      if (String(url).includes('/chat/completions')) chatBodies.push(String(init.body))
      return new Response(usageStream(12, 5), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const { status, text } = await ask(shim)
    expect(status).toBe(200)
    expect(text).toContain('早')
    expect(text).toContain('[DONE]')
    // The host asked for no usage frame and must not receive one.
    expect(text).not.toContain('usage')

    expect(chatBodies).toHaveLength(1)
    const sent = JSON.parse(chatBodies[0] ?? '{}') as Record<string, unknown>
    const options = sent['stream_options'] as Record<string, unknown> | undefined
    expect(options?.['include_usage']).toBe(true)

    const summary = recorder.summary()
    expect(summary.calls).toBe(1)
    expect(summary.turns).toBe(1)
    expect(summary.failedTurns).toBe(0)
    expect(summary.usageReported).toBe(true)
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]?.model).toBe('hy4-preview')
    expect(summary.rows[0]?.region).toBe('cn')
    expect(summary.rows[0]?.inputTokens).toBe(12)
    expect(summary.rows[0]?.outputTokens).toBe(5)
  })

  it('forwards every other frame byte for byte', async () => {
    const upstream = usageStream(9, 9)
    const trailer = 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":9}}\n\n'
    const expected = upstream.replace(trailer, '')
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(recorder, async () => new Response(upstream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const { text } = await ask(shim)
    expect(text).toBe(expected)
    expect(recorder.summary().rows[0]?.inputTokens).toBe(9)
  })

  it('never corrupts a character split across chunk boundaries', async () => {
    // The forwarder slices RAW BYTES; decoding and re-encoding would emit a
    // U+FFFD at the split - a character the user reads and the logs cannot
    // explain. Cutting mid-character is the only way to catch that.
    const bytes = Buffer.from(usageStream(1, 1), 'utf8')
    const cut = bytes.indexOf(0xe6) + 1 // one byte into the first character
    expect(cut).toBeGreaterThan(0)
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(recorder, async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, cut))
          controller.enqueue(bytes.subarray(cut))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))

    const { text } = await ask(shim)
    expect(text).toContain('早')
    expect(text).not.toContain('\uFFFD')
  })

  it('keeps a content frame that merely carries usage', async () => {
    // Some gateways report usage on their LAST CONTENT CHUNK instead of a
    // separate trailer. Dropping that frame would delete the user's answer, and
    // ignoring its usage would make the panel claim nothing was reported.
    const upstream = 'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n'
      + 'data: [DONE]\n\n'
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(recorder, async () => new Response(upstream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const { text } = await ask(shim)
    // The content frame is forwarded EXACTLY as the gateway sent it, usage
    // field included. The host asked for this frame; editing a field out of a
    // frame it DID request would make the transcript disagree with the gateway,
    // and dropping the whole frame would delete the user's answer. Only a frame
    // carrying nothing but usage is removed.
    expect(text).toContain(upstream.slice(0, upstream.indexOf('\n\n')))
    expect(text).toContain('[DONE]')

    const summary = recorder.summary()
    expect(summary.usageReported).toBe(true)
    expect(summary.rows[0]?.inputTokens).toBe(3)
    expect(summary.rows[0]?.outputTokens).toBe(4)
  })

  it('files a rotated turn as one turn and several calls', async () => {
    // A reset timestamp in the near FUTURE, or the penalized account never
    // enters cooldown and the rotation is not what this case is about.
    const resetAt = new Date(Date.now() + 10 * 60 * 1000)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const resetText = `${resetAt.getFullYear()}-${pad(resetAt.getMonth() + 1)}-${pad(resetAt.getDate())} `
      + `${pad(resetAt.getHours())}:${pad(resetAt.getMinutes())}:${pad(resetAt.getSeconds())}`
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(
      recorder,
      async () => new Response(
        JSON.stringify({ code: 6004, msg: `您的使用量已超出频率限制，将在 ${resetText} UTC+8 重置` }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
      { authDirs: [await fakeAuthDir(3)], maxAttempts: 3 },
    )

    const { status } = await ask(shim)
    expect(status).toBe(429)

    const summary = recorder.summary()
    expect(summary.calls).toBe(3)
    expect(summary.turns).toBe(1)
    expect(summary.failedTurns).toBe(1)
    expect(summary.recoveredTurns).toBe(0)
  })

  it('files nothing when no request ever left the machine', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'wbusage-empty-'))
    const recorder = new UsageRecorder()
    const { shim } = await shimWith(
      recorder,
      async () => {
        throw new Error('the upstream must never be reached')
      },
      { authDirs: [emptyDir] },
    )

    const { status } = await ask(shim)
    expect(status).toBe(401)
    expect(recorder.size()).toBe(0)
  })
})