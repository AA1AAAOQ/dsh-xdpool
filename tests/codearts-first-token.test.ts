/**
 * The two waits a CodeArts turn used to pay before it produced anything.
 *
 * ## What was measured
 *
 * A real desktop session (`session.v4.jsonl`, provider `codearts`, model
 * `deepseek-v4.1-flash`) put **65 seconds** between `step/start` and the first
 * streamed chunk on three of six steps, and 55s on a fourth. The stream itself
 * lasted 0.3–2.9s. So the wait was never the model: it was two things this pack
 * did before and around the request.
 *
 * ## 1. The model catalogue blocked the first token
 *
 * `ensureRemoteModels()` was `async` and `await`ed `catalogGate.run(...)`, and it
 * is called from `resolveModel` — which DSH runs on every turn, inside
 * `prepareCall`. On a cold process (or after the 10-minute catalogue TTL) the
 * gate fired two serial signed GETs, each capped by `FETCH_TIMEOUT_MS = 10s`:
 * `opengw.developer.huaweicloud.com/api/v1/gateway/config` and
 * `snap-access…/v1/model/builtin`. All of that happened **before the chat request
 * was even sent**, and because the gate is keyed on `inFlight`, every concurrent
 * turn queued behind the same fetch.
 *
 * The file cache made it worse, not better: `saveModelsCache()` wrote
 * `~/.cache/deveco/codearts_models.json` on every successful fetch and
 * `loadModelsCache` did not exist anywhere in the bundle (0 hits) — the benefit
 * catalogue had its read-back, the model catalogue did not. So every restart
 * re-paid the network cost with nothing to show for the previous run.
 *
 * ## 2. Tool calls were withheld until the stream ended
 *
 * `consumeSse` emitted `tool-call-delta` only for the wire's native
 * `delta.tool_calls` fragments; a **DSML** call (the `deepseek-v4-flash` /
 * `deepseek-v4-pro` tool mode) was parsed and handed to `emitDsmlFeed`, which
 * yielded one block-start plus one complete delta — and the block-end for every
 * call was held until `data: [DONE]`, i.e. the end of the whole answer. A
 * `write` carrying a large file therefore arrived as one lump after the model had
 * already finished, which is what "工具调用出现之后还要再等一会儿" is.
 *
 * ## Why source assertions
 *
 * `pack.js` is a single-file build artifact of another repository
 * (`vendor/channel-pack/src` is not tracked here), so it cannot be imported and
 * driven — the module touches the host's cordis services at load time. The same
 * choice as `codearts-resign-headers.test.ts`: assert on the source, in a window
 * that only the CodeArts adapter occupies. Every assertion below fails loudly if a
 * future pack refresh drops the patch.
 *
 * The behaviour of the incremental delta pump **is** tested for real, because that
 * function is self-contained: `flushToolDeltas` is lifted out of the bundle and
 * driven with fragments. That test is what caught the first version of the patch
 * advancing the loop cursor instead of tracking a per-block offset — with four
 * fragments arriving, only the first one was ever emitted.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

/**
 * The CodeArts adapter, bounded by anchors unique to it.
 *
 * The other twelve adapters each carry their own `ensureRemoteModels`,
 * `listModels` and `resolveModel`, so a whole-file regex would pass on someone
 * else's code. This window is the only place those fixes are meant to land.
 */
function codeArtsWindow(): string {
  const started = pack.indexOf('var CodeArtsAdapter = class')
  expect(started).toBeGreaterThan(-1)
  const ended = pack.indexOf('function registerCodeArtsLlm(ctx, options)', started)
  expect(ended).toBeGreaterThan(started)
  return pack.slice(started, ended)
}

/** A line of real code, not a comment mentioning an old spelling. */
function codeLines(source: string): string[] {
  return source.split('\n').filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
}

describe('the catalogue fetch no longer runs in front of the first token', () => {
  it('reads the on-disk catalogue before it ever asks the network', () => {
    // Without this, a cold process has nothing to answer `listModels` with and the
    // only remaining source is the two 10s-timeout GETs.
    expect(codeArtsWindow()).toContain('const cached = loadModelsCache()')
  })

  it('refreshes in the background instead of awaiting the gate', () => {
    const window = codeArtsWindow()
    expect(window).toContain('void this.catalogGate.run(')
    // A comment may quote the old spelling; a live `await` may not survive.
    expect(codeLines(window).some(line => line.includes('await this.catalogGate.run('))).toBe(false)
  })

  it('is a plain method, so its two call sites cannot await it', () => {
    const window = codeArtsWindow()
    expect(/async ensureRemoteModels\(\)/.test(window)).toBe(false)
    // `resolveModel` is the one DSH calls on every turn; it must not block.
    expect(/async resolveModel\(provider, model, _signal\) \{\s*\n\s*await this\.ensureRemoteModels\(\);/.test(window)).toBe(false)
    expect(/async listModels\(_provider\) \{[^}]{0,200}?await this\.ensureRemoteModels\(\);/.test(window)).toBe(false)
  })

  it('swallows a background refresh failure', () => {
    // Detached from `await`, an unhandled rejection terminates the host process.
    // A catalogue that failed to refresh is explicitly allowed to fail.
    expect(codeArtsWindow()).toMatch(/\.catch\(\(\) => \{\s*\}\);/)
  })

  it('has a reader for the file it has always written', () => {
    // The write side predates this patch; the bug was that nothing read it back.
    expect(pack).toContain('function loadModelsCache()')
    expect(pack).toContain('function saveModelsCache(models)')
    expect(pack).toContain('models.cachedAtMs = mtimeMs')
    // The freshness stamp travels with the rows, so `remoteModelsStale` can honour
    // the file's age instead of pretending a restored catalogue is brand new.
    expect(pack).toContain('owner.remoteModels.cachedAtMs')
  })
})

describe('the queue retry stops paying a fixed ten seconds', () => {
  it('backs off instead of hammering a quota that a rejection also consumes', () => {
    // Measured against the live endpoint: every request that comes back
    // `TM.00001041` *also* occupies a slot, so a tight poll fills the 3-slot quota
    // with its own attempts. Probing once a second produced 111 consecutive
    // rejections across 131 seconds with no success; probing every 8s failed 8/8.
    // The backoff therefore has to grow.
    expect(pack).toContain('let queueRetryDelay = 1500;')
    expect(pack).toContain('Math.min(20000, Math.round(queueRetryDelay * 1.8))')
    // Growth must apply AFTER the wait, or the first retry already pays the grown
    // value and the fast first window is lost.
    const window = codeArtsWindow()
    const waited = window.indexOf('await delay(queueRetryDelay, options.signal);')
    const grown = window.indexOf('queueRetryDelay = Math.min(20000')
    expect(waited).toBeGreaterThan(-1)
    expect(grown).toBeGreaterThan(waited)
  })

  it('uses the wait hint the server itself supplied', () => {
    // `probeDelayMs` is a module-level helper next to `delay`, not a member of the
    // adapter — it is shared by every channel that polls a queue.
    expect(pack).toContain('function probeDelayMs(')
    expect(pack).toContain('queueDelayMs(info)')
    expect(codeArtsWindow()).toContain('queueRetryDelay = probeDelayMs(probe, queueRetryDelay)')
  })

  it('does not re-probe a response that already said what it was', () => {
    // `queue/status` costs a signed round trip (measured 395ms) and commonly
    // answers `working`, which the old code then turned back into a retry. Only a
    // body-less 5xx is genuinely undecidable locally.
    const window = codeArtsWindow()
    expect(window).toContain('if (errorText.trim() === "" || response.status >= 500)')
    expect(window).toContain('await delay(queueRetryDelay, options.signal)')
  })

  it('still fails fast when the status endpoint says the model really is down', () => {
    expect(codeArtsWindow()).toContain(
      'throw new LlmError2(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status })',
    )
  })
})

describe('a full concurrency quota is not queueing, so it is not retried', () => {
  /**
   * The actual cause of the 65-second wait, which the catalogue fix did not touch.
   *
   * Measured against the live endpoint with a real credential:
   *
   *   with `maas_type: benefit` -> HTTP 200, `InferHub.4004.200 benefit not found`
   *   without it                -> HTTP 400, `TM.00001041`
   *
   * and TM.00001041's own message is `并发会话数已达上限(3个)，请关闭部分会话后重试。`
   *
   * `isQueueError` treated that as queueing, so the retry loop ran and each round
   * paid `delay(QUEUE_RETRY_DELAY_MS = 10s)`. The observed gaps — 23.1s, 44.4s,
   * 55.1s, 65.0s — are 2, 4, 5 and 6 such rounds. Waiting cannot help: the three
   * occupied slots belong to this same process's unfinished sessions, so retrying
   * asks for a slot that nothing is going to free.
   */
  it('classifies TM.00001041 as a concurrency limit', () => {
    expect(pack).toContain('function isConcurrencyLimitError(body)')
    expect(pack).toContain('body.includes("TM.00001041")')
    expect(pack).toContain('并发会话数已达上限')
  })

  it('throws before reaching the retry delay, on the HTTP path', () => {
    const window = codeArtsWindow()
    expect(window).toContain('if (isConcurrencyLimitError(errorText))')
    expect(window).toContain('"CONCURRENCY_LIMIT"')
    // The throw must come BEFORE `queueAttempts += 1` / `await delay(...)`, or the
    // 10s is paid first and only then reported.
    const thrown = window.indexOf('if (isConcurrencyLimitError(errorText))')
    const wait = window.indexOf('await delay(queueRetryDelay, options.signal)')
    expect(thrown).toBeGreaterThan(-1)
    expect(wait).toBeGreaterThan(thrown)
  })

  it('throws before reaching the retry delay, on the in-stream path', () => {
    // The same failure also arrives as HTTP 200 with an embedded error event.
    const window = codeArtsWindow()
    expect(window).toContain('isConcurrencyLimitError(message2) || data.error_code === "TM.00001041"')
    const thrown = window.indexOf('isConcurrencyLimitError(message2)')
    const queueThrow = window.indexOf('throw new SseQueueRetryError(data.error_code, message2)')
    expect(thrown).toBeGreaterThan(-1)
    expect(queueThrow).toBeGreaterThan(thrown)
  })

  it('says what the user can actually do about it', () => {
    // A retry loop's failure reads as "the model is busy". This one has to name the
    // cause and the two real options, or the user retries forever.
    const window = codeArtsWindow()
    expect(window).toContain('\\u5E76\\u53D1\\u4F1A\\u8BDD\\u6570\\u5DF2\\u8FBE\\u4E0A\\u9650')
    expect(window).toContain('\\u5207\\u6362\\u5230\\u53E6\\u4E00\\u4E2A CodeArts \\u8D26\\u53F7')
  })

  it('releases the response body instead of only unlocking it', () => {
    // The leak that fills the quota in the first place: the generator throws on an
    // embedded error, `for await` stops early, and the old `finally` only called
    // `releaseLock()`. An unconsumed body keeps the upstream request alive, which
    // is exactly what the per-account slot counts. Releasing the lock is not enough
    // — it stops consuming but does not close, so the slot stays taken until the
    // upstream times the request out.
    //
    // `pack.js` is CRLF, so no assertion here may span a line break.
    const window = codeArtsWindow()
    const finallyAt = window.indexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(-1)
    const tail = window.slice(finallyAt, finallyAt + 900)
    // The cancel must be real code, not only the comment explaining why.
    const codeOnly = tail.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n')
    expect(codeOnly).toContain('await reader.cancel();')
  })

  it('cancels in every channel adapter, not just CodeArts', () => {
    // The quota is per account, and every adapter that abandons a response body
    // leaks a slot the same way. `releaseLock()`-only cleanup must be gone
    // everywhere. Measured against the live endpoint: after abandoning three
    // streams, the slot came back in **1.7s** when cancelled and **49.6s** when
    // merely left alone (a DELETE is accepted but does not terminate an in-flight
    // generation, so it is not a substitute).
    const cancels = pack.match(/await reader\.cancel\(\);/g) ?? []
    expect(cancels.length).toBeGreaterThan(4)
    // The shape that leaked: a `finally` whose only statement is `releaseLock()`.
    const lines = pack.split('\n')
    const releaseOnly = lines.filter(
      (line, at) => line.trim() === '} finally {' && (lines[at + 1] ?? '').trim() === 'reader.releaseLock();',
    )
    expect(releaseOnly).toHaveLength(0)
  })
})

describe('a rejected benefit probe is not repeated every turn', () => {
  /**
   * The root cause of the whole report, and the one that no amount of retry
   * tuning could have fixed.
   *
   * `deepseek-v4.1-flash` sits in `CODEARTS_BENEFIT_FALLBACK`, so every turn sent a
   * `maas_type: benefit` request first, and the account had no benefit entitlement,
   * so it answered `InferHub.4004.200`. The pack then dropped the header and
   * retried — which worked. But `benefitHeaderDropped` was a **per-turn local**, so
   * the next turn probed all over again.
   *
   * Why that is fatal rather than merely wasteful: a rejected request still takes a
   * concurrency slot, and the free tier has exactly 3. Measured with a real
   * credential, after letting the quota drain:
   *
   *   plain requests only        -> 2 successes, then TM.00001041
   *   one benefit probe + plain  -> 1 success, then TM.00001041
   *
   * So the probe cost one of the remaining slots — a turn that should serve one
   * generation was serving half of one. And recovery is slow: cancelled readers
   * only start returning slots after ~90s.
   */
  it('remembers the rejection per account and model', () => {
    expect(pack).toContain('var BENEFIT_UNSUPPORTED = /* @__PURE__ */ new Map();')
    expect(pack).toContain('function benefitKeyOf(accountId, model)')
    expect(pack).toContain('function benefitKnownUnsupported(accountId, model)')
    expect(pack).toContain('function markBenefitUnsupported(accountId, model)')
  })

  it('reads that memory before deciding to send the probe', () => {
    expect(codeArtsWindow()).toContain('if (isBenefitModel && benefitKnownUnsupported(currentAccountId, options.model)) {')
  })

  it('writes the conclusion on both failure paths', () => {
    // The rejection arrives either as an in-stream error event (HTTP 200) or as an
    // HTTP error body; a fix that covered only one would still leak a slot per turn
    // for whichever path the gateway happened to use.
    const window = codeArtsWindow()
    const marks = window.split('markBenefitUnsupported(currentAccountId, options.model)').length - 1
    expect(marks).toBeGreaterThanOrEqual(2)
  })

  it('keys the memory by account, so a re-login re-probes', () => {
    // A new sign-in changes `access_key_id`; the capability is per account, so the
    // key must include it or a fresh account would inherit a stale verdict.
    expect(pack).toContain('return String(accountId || "") + "|" + String(model || "").toLowerCase();')
  })
})

describe('every helper this patch calls actually exists', () => {
  /**
   * The regression this exists for, in full.
   *
   * The first cut of this patch wrote `resolveCatalogTtl()` inside
   * `remoteModelsStale` — a function that was never defined. `node --check` passed
   * (it is syntactically perfect), the module even loaded, and the failure only
   * appeared the moment a catalogue restored from disk carried `cachedAtMs`: that
   * line threw `ReferenceError`, `ensureRemoteModels` was by then synchronous and
   * on the `resolveModel` path, and the whole CodeArts channel went dead.
   *
   * So: every free function the patched regions call must have a definition
   * somewhere in the bundle. This is a cheap, whole-bundle check that would have
   * caught that bug before it ever reached the host.
   */
  function definedNames(source: string): Set<string> {
    const names = new Set<string>()
    for (const re of [
      /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
      /\bclass\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*=>/g,
    ]) {
      for (const match of source.matchAll(re)) names.add(match[1] as string)
    }
    for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
      for (const part of (match[1] as string).split(',')) {
        const named = part.trim().split(/\s+as\s+/).pop()
        if (named !== undefined && named !== '') names.add(named.trim())
      }
    }
    for (const match of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) {
      names.add(match[1] as string)
    }
    return names
  }

  it('resolves the catalogue TTL through a function that is defined', () => {
    expect(pack).toContain('function resolveCatalogTtlMs()')
    expect(definedNames(pack).has('resolveCatalogTtlMs')).toBe(true)
    // The undefined spelling must not survive anywhere, not even in the patched
    // window that used to call it.
    expect(pack.includes('resolveCatalogTtl()')).toBe(false)
  })

  it('defines every helper the patched regions name', () => {
    const defined = definedNames(pack)
    for (const helper of [
      'loadModelsCache', 'saveModelsCache', 'modelsCachePath', 'cacheDir',
      'resolveCatalogTtlMs', 'remoteModelsStale', 'probeDelayMs', 'queueDelayMs',
      'flushToolDeltas', 'hasUsableToolName',
    ]) {
      expect(defined.has(helper)).toBe(true)
    }
  })

  it('keeps the disk-cache freshness check from assuming a shape other adapters do not have', () => {
    // `remoteModelsStale` is shared by all thirteen adapters. Reading `cachedAtMs`
    // off a plain array yields undefined, which must fall through to the in-process
    // stamp rather than throw.
    const body = pack.slice(pack.indexOf('function remoteModelsStale(owner)'))
    expect(body.slice(0, 700)).toContain('var cachedAt = owner.remoteModels.cachedAtMs')
    expect(body.slice(0, 700)).toContain('typeof cachedAt === "number"')
  })
})

describe('tool-call arguments are emitted as they arrive', () => {
  /** Lift the self-contained pump out of the bundle and make its free names real. */
  function loadPump(): {
    pump: () => AsyncGenerator<Record<string, unknown>>
    state: { toolOrder: number[]; toolCalls: Map<number, Record<string, unknown>> }
  } {
    // `pack.js` is CRLF, so strip `\r` before matching a closing brace — a bare
    // `'    }'` comparison silently finds nothing and the slice swallows the rest
    // of the 69k-line bundle.
    const lines = pack.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    const started = lines.findIndex(line => line.includes('async function* flushToolDeltas()'))
    expect(started).toBeGreaterThan(-1)
    const ended = lines.findIndex((line, at) => at > started && line === '    }')
    expect(ended).toBeGreaterThan(started)
    const body = lines.slice(started, ended + 1).join('\n')
    expect(body.length).toBeLessThan(2_000)
    const module = { exports: {} as Record<string, unknown> }
    const factory = new Function('module', 'exports', `
      let streamedToolIndex = 0;
      const toolOrder = [];
      const toolCalls = new Map();
      const hasUsableToolName = n => typeof n === 'string' && n.trim().length > 0;
      const ToolCallId = v => v;
      ${body}
      module.exports.flushToolDeltas = flushToolDeltas;
      module.exports.toolOrder = toolOrder;
      module.exports.toolCalls = toolCalls;
    `)
    factory(module, module.exports)
    return { pump: module.exports.flushToolDeltas as never, state: module.exports as never }
  }

  it('emits every fragment, not merely the first one', async () => {
    const { pump, state } = loadPump()
    const block = { index: 0, text: '', name: 'write', callId: 'c1', announced: true }
    state.toolCalls.set(0, block)
    state.toolOrder.push(0)

    const fragments = ['{"path":"a.txt",', '"content":"line1\\n', 'line2\\n', 'line3"}']
    const emitted: Record<string, unknown>[] = []
    for (const fragment of fragments) {
      block.text += fragment
      for await (const delta of pump()) emitted.push(delta)
    }

    // Regression: the first cut advanced the loop cursor, so 4 fragments produced 1
    // delta and three quarters of the file never reached the caller.
    expect(emitted).toHaveLength(4)
    expect(emitted.map(delta => delta.argumentsDelta).join('')).toBe(block.text)
  })

  it('names the call on the first fragment only, and stamps every fragment with its id', async () => {
    const { pump, state } = loadPump()
    const block = { index: 0, text: '{"a":1}', name: 'write', callId: 'c1', announced: true }
    state.toolCalls.set(0, block)
    state.toolOrder.push(0)

    const first: Record<string, unknown>[] = []
    for await (const delta of pump()) first.push(delta)
    expect(first[0]?.name).toBe('write')
    expect(first[0]?.id).toBe('c1')

    block.text += ',"b":2'
    const second: Record<string, unknown>[] = []
    for await (const delta of pump()) second.push(delta)
    expect(second[0]?.name).toBeUndefined()
    expect(second[0]?.id).toBe('c1')
  })

  it('is idempotent when nothing new has arrived', async () => {
    // The pump runs once per SSE event plus once at end-of-stream; it must not
    // re-send the whole argument blob each time.
    const { pump, state } = loadPump()
    const block = { index: 0, text: '{"a":1}', name: 'write', callId: 'c1', announced: true }
    state.toolCalls.set(0, block)
    state.toolOrder.push(0)

    for await (const _ of pump()) void _
    const again: Record<string, unknown>[] = []
    for await (const delta of pump()) again.push(delta)
    expect(again).toHaveLength(0)
  })

  it('skips a call that was never announced, rather than emitting half a name', async () => {
    // `announced` is false until a usable name has been seen; forwarding such a
    // block would hand the caller an unnamed tool call, which is a format-v4
    // rejection downstream.
    const { pump, state } = loadPump()
    state.toolCalls.set(0, { index: 0, text: '{"a":1}', name: '', callId: 'c1', announced: false })
    state.toolOrder.push(0)
    const emitted: Record<string, unknown>[] = []
    for await (const delta of pump()) emitted.push(delta)
    expect(emitted).toHaveLength(0)
  })

  it('does not re-send a block that was already emitted whole', async () => {
    // The bug this pins: `emitDsmlFeed` yields a parsed DSML call in one piece and
    // the native `tool_calls` branch yields `block.text` on announce. Both then hit
    // the pump with `streamed` unset, so the pump replayed the same arguments from
    // offset 0 — the concatenation was
    // `{"path":"a.txt"}{"path":"a.txt"}`, invalid JSON, tool unusable.
    //
    // A block that has already been sent must carry `streamed` equal to its length.
    const { pump, state } = loadPump()
    const whole = '{"path":"a.txt"}'
    state.toolCalls.set(0, { index: 0, text: whole, name: 'write', callId: 'c1', announced: true, streamed: whole.length })
    state.toolOrder.push(0)
    const emitted: Record<string, unknown>[] = []
    for await (const delta of pump()) emitted.push(delta)
    expect(emitted).toHaveLength(0)
  })

  it('marks both whole-emission sites so the pump cannot replay them', () => {
    // Source-level, because those two sites live inside `consumeSse`'s event loop
    // and cannot be lifted out the way the pump can.
    const window = codeArtsWindow()
    expect(window).toContain('streamed: call.arguments.length')
    expect(window).toContain('block.streamed = block.text.length')
  })
})
