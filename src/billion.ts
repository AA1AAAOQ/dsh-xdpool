/**
 * Read-only observation of a locally running billion-context proxy.
 *
 * WHAT THIS IS, AND WHY IT IS NOT AN EMBEDDED COMPRESSOR
 *
 * billion-context is a separate DSH plugin that is very likely already
 * installed on this machine — on a stock desktop profile it is mounted by the
 * profile's bundle layer and runs its own loopback listener. This module never
 * implements compression and never proposes to: it finds that listener and
 * relays a few numbers so the card can show what the compressor is doing.
 * Re-implementing folding here would mean a second, divergent answer to the
 * same question and a second set of ways to get it wrong.
 *
 * HOW THE LISTENER IS FOUND
 *
 * The proxy picks an ephemeral port at spawn and records it in its own state
 * directory, which we read rather than guess. Guessing would mean scanning a
 * port range on every card poll, and a wrong guess is worse than no answer: it
 * could read some unrelated loopback service. The recorded file is
 * `<state>/billion-context/proxy-origin` and holds a JSON object with at least
 * an `origin`; `port-zone.json` is the same fact keyed by lane. Both are read,
 * and the origin file wins, because it is the one the proxy itself reads on
 * startup.
 *
 * `state` is resolved the same way the proxy resolves it: `XDG_STATE_HOME` when
 * set, else `<homedir>/.local/state` on every platform including Windows — not
 * `%LOCALAPPDATA%`, which is what a Windows developer would reach for first and
 * which would therefore be wrong.
 *
 * WHAT IS RELAYED
 *
 * Counts, sizes, timestamps. Not titles, not first-block hints, not any
 * conversation material. The proxy is happy to hand over more than that, and
 * taking it would put the user's own words into a document the card fetches
 * every 30 seconds and that lives in the plugin's HTTP log.
 *
 * The one addition to that list is the proxy's own origin, so the card can link
 * out to the dashboard the proxy already ships instead of redrawing it. That is
 * a service address rather than conversation material, and anyone who can read
 * this document can already reach that listener directly — which is why it is
 * safe to publish where a title would not be.
 *
 * The proxy also has NO AUTHENTICATION by its own documentation — the README
 * says so outright — so every request here is a hard local one, and the relay
 * only ever reads `/__bili/health` and `/__bili/sessions`. Both are GETs. This
 * module has no code path that could write to that proxy.
 *
 * @module dsh-workbuddy-xdpool/billion
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import type { PoolWebBillionSession, PoolWebBillionStatus } from './status-paths.ts'
/** The proxy's own management prefix. Never guess it; it is theirs. */
const BILI_PREFIX = '/__bili'
/** Loopback only. The proxy binds 127.0.0.1 and we refuse anything else. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]', '::1']
/**
 * How long one relay request may take.
 *
 * Short on purpose: this runs inside the card's status request, and a stalled
 * third-party proxy must degrade to a panel that says "no answer" rather than
 * hold the pool card hostage. The proxy answers these two endpoints in
 * milliseconds; the budget is for the case where it does not.
 */
const RELAY_TIMEOUT_MS = 1_500
/** How many sessions the card is shown. 50 rows is already past the fold. */
const MAX_SESSIONS = 50
/** A parsed `proxy-origin`, or undefined when absent/unreadable/malformed. */
interface ProxyOrigin {
  origin: string
}
/**
 * Where the proxy keeps its state directory.
 *
 * Mirrors the proxy's own resolution exactly: `XDG_STATE_HOME` when it holds an
 * absolute path, else `<homedir>/.local/state`. Deliberately NOT
 * `DSH_HOME ?? homedir()` — DSH_HOME is the profile root and a live value on a
 * real desktop install, so preferring it sent this reader to
 * `<profile>/.local/state/billion-context` and reported "missing" on a machine
 * where the proxy was running and answering. Probed against the live proxy,
 * which is the only way that mistake is visible: every unit test with a faked
 * state directory passes either way.
 *
 * Undefined when neither resolves, because inventing a path to probe would
 * turn "not installed" into a silent hunt through the filesystem.
 */
function stateRoot(): string | undefined {
  const xdg = env.XDG_STATE_HOME
  if (typeof xdg === 'string' && xdg !== '') {
    // The proxy only honours an absolute XDG value; matching that is what keeps
    // us looking where it actually wrote.
    if (xdg.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(xdg)) return join(xdg, 'billion-context')
    return undefined
  }
  const home = homedir()
  if (typeof home !== 'string' || home === '') return undefined
  return join(home, '.local', 'state', 'billion-context')
}
/** A loopback http(s) origin, or undefined for anything else. */
function parseLoopbackOrigin(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!LOOPBACK_HOSTS.includes(url.hostname.toLowerCase())) return undefined
  return url.origin
}
/**
 * The proxy origin, from the file the proxy itself reads on startup.
 *
 * `port-zone.json` is the fallback because it is keyed by lane and therefore
 * distinguishes the dsh proxy from, say, a concurrently running opencode one —
 * but `proxy-origin` is preferred because it is the single-writer record.
 */
async function readProxyOrigin(): Promise<string | undefined> {
  const root = stateRoot()
  if (root === undefined) return undefined
  for (const name of ['proxy-origin', 'port-zone.json']) {
    let raw: string
    try {
      raw = await readFile(join(root, name), 'utf8')
    } catch {
      continue
    }
    if (name === 'proxy-origin') {
      try {
        const parsed = JSON.parse(raw) as Partial<ProxyOrigin>
        const origin = typeof parsed.origin === 'string' ? parseLoopbackOrigin(parsed.origin) : undefined
        if (origin !== undefined) return origin
      } catch {
        // A half-written file is a real state here: the proxy rewrites it on
        // every respawn. Try the other record rather than reporting absence.
      }
      continue
    }
    try {
      const parsed = JSON.parse(raw) as { lanes?: Record<string, unknown> }
      const port = parsed.lanes?.dsh
      if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) {
        return `http://127.0.0.1:${port}`
      }
    } catch {
      continue
    }
  }
  return undefined
}
/** One GET against the proxy, with the relay budget on it. Never throws. */
async function fetchJson(origin: string, path: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, RELAY_TIMEOUT_MS)
  try {
    const response = await fetch(new URL(BILI_PREFIX + path, origin), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
/** A finite number, or undefined. Guards every relayed field. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
/** A string, or ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
/** A boolean, or false. */
function bool(value: unknown): boolean {
  return value === true
}
/**
 * One session row, reduced.
 *
 * Every field is defaulted rather than passed through: the proxy's document is
 * a moving target across versions, and an unreadable row should render as
 * zeroes we can explain, not as `undefined` reaching the card.
 */
function toSession(raw: unknown): PoolWebBillionSession | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const id = str(row.id)
  if (id === '') return undefined
  return {
    id,
    protocol: str(row.protocol),
    live: bool(row.live),
    requests: num(row.requests) ?? 0,
    contextTokens: num(row.contextTokens) ?? 0,
    contextTokensSource: str(row.contextTokensSource),
    tokensSaved: num(row.tokensSaved) ?? 0,
    inputTokens: num(row.inputTokens) ?? 0,
    cachedTokens: num(row.cachedTokens) ?? 0,
    outputTokens: num(row.outputTokens) ?? 0,
    cacheHitPct: num(row.cacheHitPct) ?? -1,
    blocks: num(row.blocks) ?? 0,
    contextWindow: num(row.contextWindow) ?? 0,
    lastSeen: str(row.lastSeen),
    lastModel: str(row.lastModel),
  }
}
/** The whole relay, safe to hand the card: it never rejects. */
export async function readBillionStatus(): Promise<PoolWebBillionStatus> {
  const origin = await readProxyOrigin()
  if (origin === undefined) {
    return {
      state: 'missing',
      reason:
        'billion-context is not running on this machine. Install it with "dsh plugin --profile <name> add billion-context" and this page fills in.',
      sessions: [],
      totalSessions: 0,
    }
  }
  // Health first: it is one tiny document, and it is what distinguishes "the
  // recorded proxy is gone" from "the proxy is alive and has no sessions". A
  // stale origin file after a crash otherwise reads as an empty dashboard,
  // which is a lie the user has no way to see through.
  const health = await fetchJson(origin, '/health')
  if (health === null || typeof health !== 'object') {
    return {
      state: 'unreachable',
      reason: `billion-context is recorded at ${origin} but did not answer. It may have just been restarted.`,
      // Kept on purpose: a proxy that recorded its port and went quiet is
      // exactly the case where the URL is the only handle the user has.
      origin,
      sessions: [],
      totalSessions: 0,
    }
  }
  const meta = health as Record<string, unknown>
  const sessionsDoc = await fetchJson(origin, '/sessions')
  const rawSessions =
    sessionsDoc !== null && typeof sessionsDoc === 'object'
      ? (sessionsDoc as { sessions?: unknown }).sessions
      : undefined
  const rows = Array.isArray(rawSessions) ? rawSessions.slice(0, MAX_SESSIONS) : []
  const sessions: PoolWebBillionSession[] = []
  for (const row of rows) {
    const session = toSession(row)
    if (session !== undefined) sessions.push(session)
  }
  const total =
    num(sessionsDoc !== null && typeof sessionsDoc === 'object' ? (sessionsDoc as { total?: unknown }).total : undefined) ?? sessions.length
  const version = str(meta.version)
  const startedAt = num(meta.startedAt)
  return {
    state: 'ready',
    origin,
    ...version === '' ? {} : { version },
    ...startedAt === undefined ? {} : { startedAt },
    sessions,
    totalSessions: total,
  }
}