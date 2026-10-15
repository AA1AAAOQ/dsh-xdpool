/**
 * The billion-context page: what the compressor on this machine is doing.
 *
 * This page observes; it does not compress. billion-context is a separate
 * plugin that very likely already runs here — on a stock desktop profile it is
 * mounted by the profile's bundle layer and listens on its own loopback port.
 * Everything below is read from that proxy's own JSON, relayed through
 * `src/billion.ts`, and nothing on this page can change what the proxy does.
 *
 * Three states, three different things to say, and the difference matters more
 * than it looks:
 *
 * - **missing** — no proxy recorded. Normal on a machine that never installed
 *   it. The page shows the install command instead of an empty table, because
 *   an empty table here would be indistinguishable from "compression ran and
 *   saved nothing".
 * - **unreachable** — a proxy IS recorded but did not answer. Most often a
 *   restart in progress: the origin file is rewritten on every respawn. This
 *   must not read as an empty dashboard.
 * - **ready** — the numbers.
 *
 * Every figure is the proxy's own. Nothing is re-derived, and in particular the
 * cache hit rate below is weighted by the sessions actually shown rather than
 * averaged across them: a page that averaged a 200-request session with a
 * 1-request one would report a number that describes neither.
 *
 * WHAT THIS PAGE DOES NOT REDRAW
 *
 * billion-context ships its own dashboard, including a per-session detail view.
 * The rows below therefore link out to it rather than re-implementing those
 * screens, and the table itself starts collapsed: a fleet number is what this
 * page is for, and 50 rows of session ids is a wall the user did not ask for.
 * Both are deliberate — one answer, and the summary stays the summary.
 *
 * @module dsh-workbuddy-xdpool/client/BillionPage
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { POOL_BILLION_PATH } from '../status-paths.ts'
import type { PoolWebBillionSession, PoolWebBillionStatus } from '../status-paths.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'
import { BILLION_CARD_CSS } from './styles.ts'
import { KpiCard, PageHero } from './shell.tsx'
/** The translator the settings section injects. */
type Translate = (key: WorkBuddyPoolSettingsKey, params?: Record<string, unknown>) => string
export interface BillionPageProps {
  t?: Translate | undefined
}
/** Poll cadence, matching the other pages that watch a live process. */
const POLL_MS = 15_000
function fmtInt(value: number): string {
  return value.toLocaleString('en-US')
}
/** A token count in millions or billions, because 486,201,338 stops being a number. */
function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}
/** `288.6K tokens`, or an em dash when the proxy has no measurement. */
function tokens(value: number): string {
  return value === 0 ? '—' : `${compact(value)} tokens`
}
/** Local clock, or an em dash when the proxy never saw a request. */
function fmtLastSeen(iso: string): string {
  if (iso === '') return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
/**
 * Fleet cache hit rate, or null when nothing was measured.
 *
 * Weighted by input tokens rather than averaged per session, and null — never
 * zero — when no input was counted at all. The proxy reports `cacheHitPct: -1`
 * for exactly that case, and rendering it as `0%` would claim the cache never
 * helped, which is the opposite of what "not measured" means.
 */
function fleetHitRate(sessions: readonly PoolWebBillionSession[]): number | null {
  let input = 0
  let cached = 0
  for (const row of sessions) {
    if (row.cacheHitPct < 0) continue
    input += row.inputTokens + row.cachedTokens
    cached += row.cachedTokens
  }
  return input === 0 ? null : cached / input
}
/**
 * A link into the proxy's own dashboard, or undefined when there is nothing to
 * link to.
 *
 * Two things are checked here rather than trusted. The origin has to be an
 * absolute http(s) URL, because a relative one would resolve against the HOST
 * and silently open the wrong page; and the session id is percent-encoded,
 * because these are proxy-chosen identifiers that may contain characters a
 * hash route cannot carry raw.
 *
 * The hash is the proxy's own route shape (`#/sessions/<id>`), read from its
 * shipped router — a deep link into someone else's UI, which is the whole
 * reason the table links instead of redrawing.
 */
export function proxyLink(origin: string | undefined, hash: string): string | undefined {
  if (typeof origin !== 'string' || origin === '') return undefined
  let base: URL
  try {
    base = new URL(origin)
  } catch {
    return undefined
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined
  const url = new URL('/__bili/', base)
  url.hash = hash
  return url.toString()
}
/**
 * Open the proxy's dashboard in a new tab.
 *
 * `_blank` with `noopener` for the same reason the channels page does it: the
 * proxy owns that tab afterwards, and this page must not be able to reach back
 * into it. The settings panel itself is never navigated away from.
 */
function openProxyDashboard(url: string): void {
  window.open(url, '_blank', 'noopener')
}
export function BillionPage({ t }: BillionPageProps) {
  const [doc, setDoc] = useState<PoolWebBillionStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(POOL_BILLION_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        if (mounted.current) setFailed(true)
        return
      }
      const value = await response.json().catch(() => undefined)
      if (mounted.current && signal?.aborted !== true) {
        setDoc(value as PoolWebBillionStatus)
        setFailed(false)
      }
    } catch {
      if (mounted.current && signal?.aborted !== true) setFailed(true)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => { void load(controller.signal) }, POLL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [load])
  /**
   * Fleet totals over the rows on screen.
   *
   * Summing the rows this page will render is what keeps the KPI row from
   * disagreeing with the table under it — the same rule the pool dashboard
   * follows, and for the same reason: a dashboard that gets trusted must not be
   * able to contradict itself.
   */
  const totals = useMemo(() => {
    const sessions = doc?.sessions ?? []
    let requests = 0
    let input = 0
    let cached = 0
    let output = 0
    let saved = 0
    let live = 0
    for (const row of sessions) {
      requests += row.requests
      input += row.inputTokens
      cached += row.cachedTokens
      output += row.outputTokens
      saved += row.tokensSaved
      if (row.live) live += 1
    }
    return { sessions, requests, input, cached, output, saved, live }
  }, [doc])
  const hitRate = useMemo(() => fleetHitRate(totals.sessions), [totals.sessions])
  const ready = doc?.state === 'ready'
  /**
   * The rows start hidden, and the user opens them on purpose.
   *
   * The summary above is what this page is for; the fleet table is the
   * detail behind it. Collapsed is also the honest default on a machine with 50
   * sessions, where an expanded table pushes every other control off screen.
   */
  const [rowsOpen, setRowsOpen] = useState(false)
  const dashboard = proxyLink(doc?.origin, '#/overview')
  return (
    <>
      <style>{BILLION_CARD_CSS}</style>
      <PageHero
        title={t?.('billion.title') ?? 'billion-context'}
        sub={t?.('billion.sub') ?? 'Read-only view of the compressor running on this machine. This plugin never configures it.'}
        actions={dashboard === undefined
          ? undefined
          : <button
              type="button"
              className="dsm-btn dsm-btn-ghost"
              onClick={() => { openProxyDashboard(dashboard) }}
            >
              {t?.('billion.openDashboard') ?? 'Open its dashboard'}
            </button>}
        pills={(
          <>
            <span className="dsm-workbuddy-xdpool-pill" data-tone={ready ? 'on' : 'off'}>
              {ready
                ? (t?.('billion.pillRunning', { version: doc?.version ?? '?' }) ?? `running · v${doc?.version ?? '?'}`)
                : (t?.('billion.pillNotRunning') ?? 'not running')}
            </span>
            {ready
              ? <span className="dsm-workbuddy-xdpool-pill" data-tone="off">
                  {t?.('billion.pillReadOnly') ?? 'read-only'}
                </span>
              : null}
          </>
        )}
      />
      {failed
        ? <p className="dsm-workbuddy-xdpool-note" role="alert">
            {t?.('billion.failed') ?? 'Could not reach the pool relay. The pool itself is unaffected.'}
          </p>
        : null}
      {doc === undefined
        ? <p className="dsm-workbuddy-xdpool-note">
            {t?.('billion.loading') ?? 'Looking for a billion-context proxy on this machine…'}
          </p>
        : <>
            {doc.state !== 'ready'
        ? <section className="dsm-workbuddy-xdpool-sec">
            <h3 className="dsm-workbuddy-xdpool-sectitle">
              {doc.state === 'missing'
                ? (t?.('billion.notInstalled') ?? 'billion-context is not installed here')
                : (t?.('billion.notAnswering') ?? 'billion-context did not answer')}
            </h3>
            <p className="dsm-workbuddy-xdpool-note">
              {doc.reason ?? ''}
            </p>
            {doc.state === 'missing'
              ? <ol className="dsm-workbuddy-xdpool-steps">
                  <li>
                    <code>dsh plugin --profile {dshProfileHint(t)} add billion-context</code>
                  </li>
                  <li>{t?.('billion.stepRestart') ?? 'Restart DSH so the profile bundle layer mounts it.'}</li>
                  <li>{t?.('billion.stepBack') ?? 'Come back to this page; it fills in on its own.'}</li>
                </ol>
              : null}
          </section>
        : null}
            {ready
              ? <>
                  <div className="dsm-workbuddy-xdpool-kpis">
                    <KpiCard
                      label={t?.('billion.sessions') ?? 'Sessions'}
                      value={fmtInt(doc.totalSessions)}
                      sub={totals.live === 0
                        ? (t?.('billion.noLive') ?? 'none active right now')
                        : (t?.('billion.liveSub', { count: totals.live })
                          ?? `${totals.live} active right now`)}
                    />
                    <KpiCard
                      label={t?.('billion.requests') ?? 'Requests'}
                      value={fmtInt(totals.requests)}
                      sub={t?.('billion.requestsSub') ?? 'through the proxy, all lanes'}
                    />
                    <KpiCard
                      label={t?.('billion.saved') ?? 'Tokens saved'}
                      value={compact(totals.saved)}
                      sub={t?.('billion.savedSub') ?? 'by compression, net of what it cost'}
                    />
                    <KpiCard
                      label={t?.('billion.tokens') ?? 'Tokens'}
                      value={compact(totals.input)}
                      sub={t?.('billion.tokensSub', {
                        cached: compact(totals.cached),
                        out: compact(totals.output),
                      }) ?? `${compact(totals.cached)} cached · ${compact(totals.output)} out`}
                    />
                    <KpiCard
                      label={t?.('billion.cache') ?? 'Cache hit'}
                      value={hitRate === null ? '—' : `${Math.round(hitRate * 100)}%`}
                      sub={hitRate === null
                        ? (t?.('billion.cacheNone') ?? 'nothing measured yet')
                        : (t?.('billion.cacheSub') ?? 'of everything sent')}
                    />
                  </div>
                  {totals.sessions.length === 0
                    ? <p className="dsm-workbuddy-xdpool-note">
                        {t?.('billion.empty') ?? 'The proxy is up but has seen no requests yet. Chat and this fills in.'}
                      </p>
                    : <section className="dsm-workbuddy-xdpool-sec">
                        <div className="dsm-workbuddy-xdpool-sechead">
                          <h3 className="dsm-workbuddy-xdpool-sectitle">
                            {t?.('billion.perSession') ?? 'Per session'}
                          </h3>
                          <div className="dsm-workbuddy-xdpool-secbtns">
                            <button
                              type="button"
                              className="dsm-workbuddy-xdpool-secghost"
                              aria-expanded={rowsOpen}
                              onClick={() => { setRowsOpen(open => !open) }}
                            >
                              {rowsOpen
                                ? (t?.('billion.hideRows') ?? 'Hide rows')
                                : (t?.('billion.showRows', { count: totals.sessions.length })
                                  ?? `Show ${totals.sessions.length} rows`)}
                            </button>
                            {dashboard === undefined
                              ? null
                              : <a
                                  className="dsm-workbuddy-xdpool-secghost"
                                  href={dashboard}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {t?.('billion.openDashboard') ?? "Open the proxy's own dashboard"}
                                </a>}
                          </div>
                        </div>
                        {rowsOpen
                          ? <div className="dsm-workbuddy-xdpool-tablewrap">
                              <table className="dsm-workbuddy-xdpool-table">
                                <thead>
                                  <tr>
                                    <th>{t?.('billion.colSession') ?? 'Session'}</th>
                                    <th>{t?.('billion.colLast') ?? 'Last seen'}</th>
                                    <th>{t?.('billion.colModel') ?? 'Model'}</th>
                                    <th className="dsm-workbuddy-xdpool-num">{t?.('billion.colRequests') ?? 'Requests'}</th>
                                    <th className="dsm-workbuddy-xdpool-num">{t?.('billion.colContext') ?? 'Context'}</th>
                                    <th className="dsm-workbuddy-xdpool-num">{t?.('billion.colBlocks') ?? 'Blocks'}</th>
                                    <th className="dsm-workbuddy-xdpool-num">{t?.('billion.colSaved') ?? 'Saved'}</th>
                                    <th className="dsm-workbuddy-xdpool-num">{t?.('billion.colCache') ?? 'Cache'}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {totals.sessions.map(row => {
                                    const detail = proxyLink(doc?.origin, `#/sessions/${encodeURIComponent(row.id)}`)
                                    return (
                                      <tr key={row.id} data-live={row.live}>
                                        <td className="dsm-workbuddy-xdpool-ellipsis" title={row.id}>
                                          {detail === undefined
                                            ? <>{row.id}</>
                                            : <a
                                                className="dsm-workbuddy-xdpool-sesslink"
                                                href={detail}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={row.id}
                                              >
                                                {row.id}
                                              </a>}
                                          {row.live
                                            ? <span className="dsm-workbuddy-xdpool-live" aria-label="live" />
                                            : null}
                                        </td>
                                        <td>{fmtLastSeen(row.lastSeen)}</td>
                                        <td className="dsm-workbuddy-xdpool-ellipsis" title={row.lastModel}>
                                          {row.lastModel === '' ? '—' : row.lastModel}
                                        </td>
                                        <td className="dsm-workbuddy-xdpool-num">{fmtInt(row.requests)}</td>
                                        <td className="dsm-workbuddy-xdpool-num" title={t?.('billion.contextTitle', {
                                          source: row.contextTokensSource,
                                          window: row.contextWindow,
                                        }) ?? `source ${row.contextTokensSource} · window ${row.contextWindow}`}>
                                          {tokens(row.contextTokens)}
                                        </td>
                                        <td className="dsm-workbuddy-xdpool-num">{fmtInt(row.blocks)}</td>
                                        <td className="dsm-workbuddy-xdpool-num">{compact(row.tokensSaved)}</td>
                                        <td className="dsm-workbuddy-xdpool-num">
                                          {row.cacheHitPct < 0 ? '—' : `${row.cacheHitPct}%`}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          : <p className="dsm-workbuddy-xdpool-note">
                              {t?.('billion.rowsHint') ?? 'Hidden by default. The summary above is the whole fleet; open the rows or the proxy’s own dashboard when you need a specific session.'}
                            </p>}
                        <p className="dsm-workbuddy-xdpool-note">
                          {t?.('billion.note') ?? 'These numbers are the proxy’s own. Nothing here is an estimate, and this page never changes a setting.'}
                        </p>
                      </section>}
                </>
              : null}
          </>}
    </>
  )
}
/**
 * The profile name for the install command.
 *
 * The host publishes it as an env var; when that is absent the command still
 * works with `--profile` omitted on a single-profile install, so the hint says
 * so rather than printing an empty flag.
 */
function dshProfileHint(t?: Translate): string {
  const profile = typeof process === 'undefined' ? undefined : process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile !== '') return profile
  return (t?.('billion.defaultProfile') ?? '<profile>')
}