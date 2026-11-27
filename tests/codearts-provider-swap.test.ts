/**
 * The CodeArts provider swap, pinned at the wiring level.
 *
 * `tests/codearts-adapter.test.ts` proves the replacement behaves; this file
 * proves the plugin actually *uses* it. The two failure modes it guards are
 * ordering and drift:
 *
 * - the pack reads `DSH_XDPOOL_OWNS_POOL_LANES` while it registers adapters, so
 *   the replacement must be registered and the lane list passed **before**
 *   `mountChannelPack` runs. A later registration would lose the `codearts`
 *   route to the pack's own adapter and quietly restore the queue behaviour;
 * - the replacement must not grow a queue-status poll. That endpoint is the
 *   exact defect this provider exists to remove, and a future "helpful" retry
 *   addition is the kind of change that reads fine and reintroduces the wait.
 *
 * Source assertions rather than an import: `src/index.ts` needs the whole host
 * (settings, webServer, credentials, LLM registry) to mount, which no unit test
 * should stand up just to observe one registration order.
 *
 * @module dsh-xdpool/tests/codearts-provider-swap
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../src/channels.ts', import.meta.url), 'utf8')
const upstream = readFileSync(new URL('../src/codearts-upstream.ts', import.meta.url), 'utf8')

describe('the CodeArts route is served by the replacement adapter', () => {
  it('registers the replacement inside the same fiber that mounts the pack', () => {
    const registration = index.indexOf('releaseAdapterCodearts = ctx.llm.registerAdapter')
    const mount = index.indexOf('mountChannelPack(scoped, ctx.logger, {')
    expect(registration).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(-1)
    // Ordering is the contract: the pack reads the lane list during apply, so a
    // registration after the mount would arrive too late.
    expect(registration).toBeLessThan(mount)
    expect(index).toContain('new CodeartsHostAdapter(')
    expect(index).toContain('scope: () => scoped')
  })

  it('tells the pack to stand aside only when the replacement registered', () => {
    expect(index).toContain('ownsLanes: releaseAdapterCodearts === undefined ? [] : [CODEARTS_PROVIDER_ID]')
    // The env handoff itself lives in channels.ts, where every lane decision is
    // made; it must accept the caller's list instead of hard-coding two ids.
    expect(channels).toContain('options.ownsLanes')
    expect(channels).toContain('owns.add(lane)')
    expect(channels).not.toContain("process.env['DSH_XDPOOL_OWNS_POOL_LANES'] = 'buddy,workbuddy'")
  })

  it('releases the route with the rest of the plugin', () => {
    const releases = index.match(/releaseAdapterCodearts\?\.\(\)/gu) ?? []
    expect(releases.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the replacement transport keeps the CodeArts2API fixes', () => {
  it('derives one stable session id instead of minting one per request', () => {
    expect(upstream).toContain('upstreamSessionId(fresh)')
    // The id must come from the credential, not from the adapter instance.
    const protocol = readFileSync(new URL('../src/codearts-protocol.ts', import.meta.url), 'utf8')
    expect(protocol).toContain('createHash(\'sha256\').update(key')
    expect(protocol).toContain("'x-ot-session-id'")
    expect(protocol).toContain("'user-session-id'")
  })

  it('never polls the queue-status endpoint', () => {
    // The prose may name the endpoint to explain the defect; the code must not
    // contain the poll or its result vocabulary.
    expect(upstream).not.toContain('queryQueueStatus')
    expect(upstream).not.toContain('QUEUE_STATUS_BASE')
    expect(upstream).not.toContain('QUEUE_RETRY_DELAY_MS')
    // The transient path is a short backoff instead.
    expect(upstream).toContain('codeartsBackoffMs')
    expect(upstream).toContain('attempt * 1000')
  })

  it('classifies request errors separately from account failures', () => {
    const protocol = readFileSync(new URL('../src/codearts-protocol.ts', import.meta.url), 'utf8')
    for (const kind of ['auth', 'quota', 'transient', 'invalid', 'context', 'server']) {
      expect(protocol, kind).toContain(`'${kind}'`)
    }
    // The codes are written as regex sources, so match the digits rather than a
    // literal that would only exist in the comment.
    expect(protocol).toContain('00001041')
    expect(protocol).toContain('00001050')
    expect(protocol).toContain('CONTEXT_TEXT')
  })
})