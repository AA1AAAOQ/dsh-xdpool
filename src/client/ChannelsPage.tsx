/**
 * The login-channel page: the thirteen vendors that sign you in with a browser
 * or a QR code, plus the four plumbing actions the vendored pack exposes for it.
 *
 * Split out of {@link ../client/PoolCard} for the same reason as
 * {@link ./AggregatePage}: it reads a different document and must not ride the
 * pool card's 30-second poll. There is a second reason too — its whole lifecycle
 * is push-driven. A login can take a minute of browser work, so this page owns
 * its own polling and stops it the moment the user leaves.
 *
 * @module dsh-workbuddy-xdpool/client/ChannelsPage
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  POOL_CHANNELS_PATH,
  POOL_CHANNEL_MODELS_PATH,
  POOL_MODEL_PROBE_PATH,
  ROUTE_OWNED_ELSEWHERE,
  type PoolWebChannel,
  type PoolWebChannelsStatus,
  type PoolWebModelProbeResult,
} from '../status-paths.ts'
import type { ChannelAccount, ChannelRpcEnvelope } from '../channels.ts'
import { accountsFrom, callPack, channelIdOf, createdFrom, modelListsFrom, pollFrom, type ChannelModel } from './channel-rpc.ts'
import { ModelFactsRow } from './model-facts-row.tsx'
import { modelFactsFor, type ModelProbeReading } from './model-facts.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'
import { CHANNEL_CARD_CSS } from './styles.ts'
import { BrandTile } from './brand-tile.tsx'
import { channelIcon, channelInitials } from './channel-icons.ts'
import { PageHero } from './shell.tsx'
type Translate = (key: WorkBuddyPoolSettingsKey, params?: Record<string, unknown>) => string
export interface ChannelsPageProps {
  t?: Translate | undefined
}
/** How often a login in flight is checked, in milliseconds. */
const POLL_INTERVAL_MS = 2_000
/**
 * How long to keep checking before giving up.
 *
 * A scan-and-confirm login is normally seconds; ten minutes covers a phone
 * delay, a wrong first account and a re-read of the terms. Beyond that the user
 * has almost certainly walked away, and polling forever would hold a pending
 * account open for a session nobody is watching.
 */
const POLL_TIMEOUT_MS = 10 * 60_000
/** Per-channel UI phase. `signing-in` carries the pending login while it waits. */
type ChannelPhase = 'idle' | 'signing-in' | 'done' | 'failed'
interface ChannelUiState {
  phase: ChannelPhase
  /** The pack's account id while a login is in flight. */
  accountId?: string | undefined
  /** Where to send the user, once the pack has minted a login page. */
  loginUrl?: string | undefined
  /** A line to print under the row. */
  message?: string | undefined
}
const IDLE: ChannelUiState = { phase: 'idle' }
export function ChannelsPage({ t }: ChannelsPageProps) {
  const [status, setStatus] = useState<PoolWebChannelsStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [ui, setUi] = useState<Record<string, ChannelUiState>>({})
  const [connected, setConnected] = useState<readonly ChannelAccount[]>([])
  /**
   * `channelId/modelId` -> the last connectivity reading for that pair.
   *
   * Keyed by both halves because a login channel exposes its models under the
   * host's own provider ids, and `gemini` the channel and `gemini` the vendor
   * are two different registrations of the same name.
   */
  const [probes, setProbes] = useState<Record<string, ModelProbeReading>>({})
  /** The pair currently being measured, so only one button shows a spinner. */
  const [probing, setProbing] = useState<string | undefined>(undefined)
  /**
   * Why a channel cannot show its model list, when that is the case.
   *
   * Printed instead of an empty list rather than left silent: a channel with no
   * catalogue and no explanation reads as a channel with no models, which is a
   * different claim and a wrong one.
   */
  const [modelsError, setModelsError] = useState<string | undefined>(undefined)
  const [modelLists, setModelLists] = useState<Record<string, readonly ChannelModel[]>>({})
  const mounted = useRef(true)
  /** Timers for in-flight logins, keyed by channel id. */
  const timers = useRef(new Map<string, number>())
  useEffect(() => () => {
    mounted.current = false
    for (const handle of timers.current.values()) window.clearInterval(handle)
    timers.current.clear()
  }, [])
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(POOL_CHANNELS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const detail = value as { error?: string } | undefined
        if (mounted.current) setError(detail?.error ?? `HTTP ${response.status}`)
        return
      }
      if (mounted.current && signal?.aborted !== true) {
        setStatus(value as PoolWebChannelsStatus)
        setError(undefined)
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  /**
   * Re-read which channels are connected.
   *
   * A failure is swallowed on purpose: this is a decoration on top of the login
   * list, and turning its failure into a panel-wide error would blank the page
   * for something the user did not ask about. The connected badges are the
   * first thing to go and the last to be missed.
   */
  const loadConnected = useCallback(async (): Promise<void> => {
    const envelope = await callPack('account.list', {})
    if (!mounted.current || !envelope.ok) return
    setConnected(accountsFrom(envelope))
  }, [])
  /**
   * Ask the host what models each signed-in channel contributes.
   *
   * Read from the host rather than from the pack because the pack's own
   * `model.list` throws away exactly the fields this page exists to show: it
   * keeps `id`, `name`, `disabled`, `dead` and a free flag, and drops the window,
   * the output ceiling and the modalities the host already resolved. The host's
   * catalogue is also the one the model picker reads, so the two agree by
   * construction instead of by luck.
   *
   * A channel that is not signed in is simply absent from the answer, so its
   * row shows no model line — which is the honest state, not a failure worth a
   * message on all thirteen rows.
   */
  const loadModelLists = useCallback(async (roster: readonly PoolWebChannel[]): Promise<void> => {
    const wanted = roster.filter(channel => !channel.ownedByPool).map(channel => channel.id)
    if (wanted.length === 0) {
      if (mounted.current) {
        setModelLists({})
        setModelsError(undefined)
      }
      return
    }
    try {
      const response = await fetch(POOL_CHANNEL_MODELS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ providers: wanted }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!mounted.current) return
      if (!response.ok) {
        const detail = value as { error?: string } | undefined
        setModelsError(detail?.error ?? `HTTP ${response.status}`)
        return
      }
      setModelLists(Object.fromEntries(modelListsFrom(value)))
      setModelsError(undefined)
    } catch (cause: unknown) {
      if (mounted.current) setModelsError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  /**
   * Send one real request to one of a channel's models and record what came back.
   *
   * One at a time, for the same reason the other two pages hold to one: every
   * call spends the user's quota, and a row that greys out on click would read as
   * a broken card rather than as a test already running.
   */
  const testModel = useCallback(async (provider: string, model: string): Promise<void> => {
    const key = `${provider}/${model}`
    if (probing !== undefined) return
    setProbing(key)
    try {
      const response = await fetch(POOL_MODEL_PROBE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider, model }),
      })
      const body = await response.json() as PoolWebModelProbeResult | { error?: unknown }
      if (!mounted.current) return
      setProbes(prev => ({
        ...prev,
        [key]: 'ok' in body
          ? {
              ok: body.ok,
              outputChars: typeof body.outputChars === 'number' ? body.outputChars : 0,
              ...typeof body.firstFrameMs === 'number' ? { firstFrameMs: body.firstFrameMs } : {},
              ...typeof body.error === 'string' ? { error: body.error } : {},
            }
          : {
              ok: false,
              outputChars: 0,
              error: typeof (body as { error?: string }).error === 'string'
                ? (body as { error: string }).error
                : `HTTP ${response.status}`,
            },
      }))
    } catch (cause: unknown) {
      if (!mounted.current) return
      setProbes(prev => ({
        ...prev,
        [key]: {
          ok: false,
          outputChars: 0,
          error: cause instanceof Error && cause.message !== '' ? cause.message : 'the probe could not be sent',
        },
      }))
    } finally {
      if (mounted.current) setProbing(undefined)
    }
  }, [probing])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    void loadConnected().catch(() => {})
    return () => { controller.abort() }
  }, [load, loadConnected])
  useEffect(() => {
    const roster = status?.channels ?? []
    if (roster.length === 0) return
    void loadModelLists(roster)
  }, [status?.channels, loadModelLists])
  const connectedFor = useCallback(
    (channel: PoolWebChannel): readonly ChannelAccount[] =>
      connected.filter((account) => account.provider === channel.id && account.enabled !== false),
    [connected],
  )
  const stopPolling = useCallback((channelId: string): void => {
    const handle = timers.current.get(channelId)
    if (handle !== undefined) window.clearInterval(handle)
    timers.current.delete(channelId)
  }, [])
  /**
   * Watch one login until it lands, gives up, or times out.
   *
   * The interval is scheduled inside a single function and re-arms itself, so
   * one slow response can never produce two collectors for the same account —
   * which would show the same channel twice and could claim its completion
   * twice.
   */
  const watch = useCallback(
    (channel: PoolWebChannel, accountId: string, startedAt: number): void => {
      stopPolling(channel.id)
      const tick = async (): Promise<void> => {
        if (!mounted.current) return stopPolling(channel.id)
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          stopPolling(channel.id)
          setUi(prev => ({
            ...prev,
            [channel.id]: { phase: 'failed', accountId, message: t?.('chan.failed') ?? 'Sign-in failed' },
          }))
          return
        }
        let envelope: ChannelRpcEnvelope
        try {
          envelope = await callPack('login.poll', { provider: channel.id, accountId })
        } catch (cause: unknown) {
          // A single unreachable poll is not a failed login: keep watching.
          void cause
          return
        }
        if (!mounted.current) return
        if (!envelope.ok) return
        const answer = pollFrom(envelope)
        if (!answer.done) return
        stopPolling(channel.id)
        if (answer.success === false) {
          setUi(prev => ({
            ...prev,
            [channel.id]: { phase: 'failed', accountId, message: answer.error ?? t?.('chan.failed') ?? 'Sign-in failed' },
          }))
          return
        }
        setUi(prev => ({ ...prev, [channel.id]: { phase: 'done', accountId } }))
        void loadConnected().catch(() => {})
      }
      timers.current.set(channel.id, window.setInterval(() => { void tick() }, POLL_INTERVAL_MS))
    },
    [loadConnected, stopPolling, t],
  )
  const signIn = useCallback(
    async (channel: PoolWebChannel): Promise<void> => {
      setUi(prev => ({ ...prev, [channel.id]: { phase: 'signing-in' } }))
      let envelope: ChannelRpcEnvelope
      try {
        envelope = await callPack('account.create', { provider: channel.id })
      } catch (cause: unknown) {
        if (!mounted.current) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setUi(prev => ({ ...prev, [channel.id]: { phase: 'failed', message } }))
        return
      }
      if (!mounted.current) return
      if (!envelope.ok) {
        setUi(prev => ({
          ...prev,
          [channel.id]: {
            phase: 'failed',
            message: envelope.error?.message ?? t?.('chan.failed') ?? 'Sign-in failed',
          },
        }))
        return
      }
      const created = createdFrom(envelope)
      if (created === undefined) {
        setUi(prev => ({
          ...prev,
          [channel.id]: { phase: 'failed', message: t?.('chan.failed') ?? 'Sign-in failed' },
        }))
        return
      }
      // Open the login page in a new tab rather than this one: the pack's flow
      // ends back on the host origin, and navigating the settings panel away
      // mid-login would leave the user with no way back to the poll.
      window.open(created.loginUrl, '_blank', 'noopener')
      setUi(prev => ({
        ...prev,
        [channel.id]: {
          phase: 'signing-in',
          accountId: created.accountId,
          loginUrl: created.loginUrl,
          message: t?.('chan.waiting'),
        },
      }))
      watch(channel, created.accountId, Date.now())
    },
    [t, watch],
  )
  const cancel = useCallback((channelId: string): void => {
    stopPolling(channelId)
    setUi(prev => ({ ...prev, [channelId]: IDLE }))
  }, [stopPolling])
  const connectedCount = useMemo(
    () => new Set(connected.map((account) => account.provider)).size,
    [connected],
  )
  const state = status?.state ?? 'pending'
  const channels = status?.channels ?? []
  return (
    <div className="dsm-workbuddy-xdpool-channels">
      <style>{CHANNEL_CARD_CSS}</style>
      <PageHero
        title={t?.('chan.title') ?? 'Login channels'}
        sub={t?.('chan.sub') ?? ''}
        // The hero's pill slot, not the big total card. `.panel-total` is a
        // full-width banner: centred text, a 3px bar across its top edge, meant
        // to be read across a section. Dropped into a row of 11px capsules it
        // rendered at the size of a title inside a box the size of a chip, and
        // the user read the mismatch as "this one never got styled".
        pills={<span
          className="dsm-workbuddy-xdpool-pill"
          data-tone={connectedCount > 0 ? 'ok' : 'off'}
        >
          {t?.('chan.connectedCount', { count: connectedCount }) ?? `${connectedCount} connected`}
        </span>}
      />
      {error !== undefined && (
        <p className="dsm-workbuddy-xdpool-panel-error">{error}</p>
      )}
      {state === 'pending' && (
        <p className="dsm-workbuddy-xdpool-panel-empty">{t?.('chan.pending')}</p>
      )}
      {/*
        Two different failures, two different sentences. A pack that is already
        mounted by the sibling login-channel build is not a failure at all — the
        same thirteen channels are one click away on that build's own page — and
        printing the host's "could not start" line for it told the user
        something was broken when nothing was.
      */}
      {state === 'unavailable' && status?.reason === ROUTE_OWNED_ELSEWHERE && (
        <p className="dsm-workbuddy-xdpool-panel-empty">
          {t?.('chan.ownedElsewhere') ?? 'Another plugin already serves these login channels.'}
        </p>
      )}
      {state === 'unavailable' && status?.reason !== ROUTE_OWNED_ELSEWHERE && (
        <p className="dsm-workbuddy-xdpool-panel-error">
          {t?.('chan.unavailable')}{status?.reason !== undefined ? ` (${status.reason})` : ''}
        </p>
      )}
      {state === 'ready' && channels.length === 0 && (
        <p className="dsm-workbuddy-xdpool-panel-empty">{t?.('chan.empty')}</p>
      )}
      {channels.map((channel) => (
        <ChannelRow
          key={channel.id}
          channel={channel}
          t={t}
          ui={ui[channel.id] ?? IDLE}
          connectedCount={connectedFor(channel).length}
          models={modelLists[channel.id] ?? []}
          modelsError={modelsError}
          probes={probes}
          probing={probing}
          onSignIn={() => { void signIn(channel) }}
          onCancel={() => cancel(channel.id)}
          onTestModel={(model) => { void testModel(channel.id, model) }}
        />
      ))}
    </div>
  )
}
interface ChannelRowProps {
  channel: PoolWebChannel
  t?: Translate | undefined
  ui: ChannelUiState
  connectedCount: number
  /**
   * What the host's catalogue says this channel contributes.
   *
   * Empty for a channel nobody has signed in to, which is the ordinary state
   * for twelve of the thirteen and must not be dressed up as a fault.
   */
  models: readonly ChannelModel[]
  /** Why the catalogue could not be read, if it could not. */
  modelsError?: string | undefined
  /** `"<channelId>/<modelId>"` -> the last reading for that pair. */
  probes: Readonly<Record<string, ModelProbeReading>>
  /** The pair currently being measured, in the same key shape. */
  probing: string | undefined
  onSignIn: () => void
  onCancel: () => void
  onTestModel: (modelId: string) => void
}
function ChannelRow({
  channel,
  t,
  ui,
  connectedCount,
  models,
  modelsError,
  probes,
  probing,
  onSignIn,
  onCancel,
  onTestModel,
}: ChannelRowProps) {
  const busy = ui.phase === 'signing-in'
  const icon = channelIcon(channel.id)
  /* Eight of the thirteen channels carry real artwork in this build; the other
     five have none anywhere, so they wear their own initials on their own
     accent. Both paths are the tile working as designed - see the decision
     list at the top of brand-tile.tsx. Note the spread is keyed on `icon`
     being ABSENT: a channel that has a logo must never also get letters, and
     artwork always wins inside the tile as well. */
  const tileMark = icon === undefined ? { initials: channelInitials(channel.name) } : { icon }
  return (
    <div
      className="dsm-workbuddy-xdpool-channel"
      style={{ '--dsm-workbuddy-xdpool-channel-accent': channel.accent } as Record<string, string>}
    >
      <div className="dsm-workbuddy-xdpool-channel-head">
        <BrandTile accent={channel.accent} glyph="login" {...tileMark} />
        <span className="dsm-workbuddy-xdpool-channel-name">{channel.name}</span>
        <span className="dsm-workbuddy-xdpool-channel-org">{channel.org}</span>
        {connectedCount > 0 && (
          <span className="dsm-workbuddy-xdpool-channel-tag">
            {t?.('chan.connected', { count: connectedCount }) ?? 'Connected'}
          </span>
        )}
      </div>
      <p className="dsm-workbuddy-xdpool-channel-note">{channel.note}</p>
      {/* The per-model facts and the test button, from the shared component every
          model page uses — see the module header for why a channel that reports
          nothing is left silent rather than given an empty line. */}
      {models.length > 0
        ? <ul className="dsm-workbuddy-xdpool-channel-models">
            {models.map(model => {
              const key = `${channel.id}/${model.id}`
              return (
                <li key={model.id} className="dsm-workbuddy-xdpool-channel-model">
                  <span className="dsm-workbuddy-xdpool-channel-model-name">{model.name}</span>
                  <ModelFactsRow
                    t={t}
                    facts={modelFactsFor(model)}
                    {...probes[key] === undefined
                      ? { onTest: () => { onTestModel(model.id) } }
                      : { probe: probes[key], probing: probing === key }}
                  />
                </li>
              )
            })}
          </ul>
        : null}
      {modelsError !== undefined && (
        <p className="dsm-workbuddy-xdpool-channel-error" title={modelsError}>
          {t?.('chan.modelsUnavailable') ?? 'The model list could not be read'}
        </p>
      )}
      {channel.ownedByPool ? (
        <p className="dsm-workbuddy-xdpool-channel-owned">
          {t?.('chan.ownedByPool') ?? 'Managed by the pool above'}
        </p>
      ) : (
        <div className="dsm-workbuddy-xdpool-channel-actions">
          {busy ? (
            <>
              <span className="dsm-workbuddy-xdpool-channel-waiting">
                {ui.message ?? t?.('chan.signingIn') ?? 'Waiting for sign-in…'}
              </span>
              {ui.loginUrl !== undefined && (
                <a
                  className="dsm-workbuddy-xdpool-btn"
                  href={ui.loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t?.('chan.openLogin') ?? 'Open the sign-in page'}
                </a>
              )}
              <button type="button" className="dsm-workbuddy-xdpool-btn" onClick={onCancel}>
                {t?.('agg.clear') ?? 'Cancel'}
              </button>
            </>
          ) : ui.phase === 'done' ? (
            <span className="dsm-workbuddy-xdpool-channel-ok">{t?.('chan.done') ?? 'Signed in'}</span>
          ) : (
            <>
              <button type="button" className="dsm-workbuddy-xdpool-btn" onClick={onSignIn}>
                {t?.('chan.login') ?? 'Sign in'}
              </button>
              {ui.phase === 'failed' && (
                <span className="dsm-workbuddy-xdpool-channel-error">
                  {ui.message ?? t?.('chan.failed') ?? 'Sign-in failed'}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}