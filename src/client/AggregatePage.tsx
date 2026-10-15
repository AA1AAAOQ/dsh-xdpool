/**
 * The aggregate provider page: every vendor in the roster as a compact row the
 * user opens before configuring.
 *
 * WHY THE ROWS ARE COLLAPSED
 *
 * The roster is seventy-six vendors and, on a fresh install, none of them is
 * configured. The first version drew every row with its key field, endpoint
 * field and seven buttons already on screen and its switch already flipped, so
 * the page opened on a wall of empty inputs that read as "everything is
 * already in the pool, and also everything is broken". Nothing here is in the
 * pool until the user says so: the row shows what the vendor IS, and the fields
 * appear when the row is opened.
 *
 * Split out of {@link ../client/PoolCard} because the pool card is already a
 * long file and this page has its own fetch/state lifecycle — it reads a
 * different document (`POOL_AGGREGATE_PATH`) and must not be mounted on the
 * pool card's 30-second poll.
 *
 * @module dsh-workbuddy-xdpool/client/AggregatePage
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  POOL_AGGREGATE_DISCOVER_PATH,
  POOL_AGGREGATE_PATH,
  POOL_AGGREGATE_SAVE_PATH,
  POOL_AGGREGATE_TEST_PATH,
  POOL_MODEL_PROBE_PATH,
  type PoolWebAggregatePatch,
  type PoolWebAggregateProbe,
  type PoolWebAggregateProvider,
  type PoolWebAggregateStatus,
  type PoolWebModelProbeResult,
} from '../status-paths.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'
import { AGGREGATE_CARD_CSS } from './styles.ts'
import { BrandTile } from './brand-tile.tsx'
import { channelIcon, channelInitials } from './channel-icons.ts'
import { providerIcon } from './provider-icons.ts'
import { ModelFactsRow } from './model-facts-row.tsx'
import { modelFactsFor, type ModelProbeReading } from './model-facts.ts'
import { PageHero } from './shell.tsx'
/** The translator the settings section injects; the page renders every string through it. */
type Translate = (key: WorkBuddyPoolSettingsKey, params?: Record<string, unknown>) => string
/** Props delivered by the slot wrapper in {@link ./PoolCard}. */
export interface AggregatePageProps {
  t?: Translate | undefined
}
/** Category order in the filter row, matching the registry's own vocabulary. */
const CATEGORIES = ['apikey', 'free', 'free-tier', 'local', 'oauth'] as const
type Category = (typeof CATEGORIES)[number]
const CATEGORY_LABEL: Readonly<Record<Category, WorkBuddyPoolSettingsKey>> = Object.freeze({
  apikey: 'agg.catApikey',
  free: 'agg.catFree',
  'free-tier': 'agg.catFreeTier',
  local: 'agg.catLocal',
  oauth: 'agg.catOauth',
})
/**
 * Tile accents for the roster.
 *
 * The registry carries no colour of its own — it has no accent, icon or hex
 * field at all — so a vendor's tint is derived from its id. That is a weaker
 * claim than the login channels' hand-picked accents, and deliberately so: it
 * exists to keep seventy-six tiles from looking like one grey column, not to
 * assert a brand colour nobody published. A derived tint is stable across
 * reloads, which is the property that actually matters for recognition.
 */
const VENDOR_ACCENTS = [
  '#5686fe',
  '#7a5cf0',
  '#10a5a0',
  '#e8843d',
  '#d9578a',
  '#4aa3e8',
  '#6aa84f',
  '#c05ce0',
] as const
/** A stable tint for one vendor id. */
function accentFor(id: string): string {
  let hash = 0
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) >>> 0
  return VENDOR_ACCENTS[hash % VENDOR_ACCENTS.length] as string
}
/** How many model ids a row may print before it collapses into "and N more". */
const MODEL_PREVIEW = 4
/**
 * Per-provider edit buffer.
 *
 * The key is never echoed back by the read route — `aggregateStatusOf` reports
 * only whether one is present — so the field starts empty and an empty field on
 * save means "leave the stored key alone". Clearing is its own action, because
 * silently overwriting a key with nothing is the one mistake here that loses
 * work the user cannot retype.
 */
interface ProviderDraft {
  apiKey: string
  baseUrl: string
}
export function AggregatePage({ t }: AggregatePageProps) {
  const [status, setStatus] = useState<PoolWebAggregateStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Provider ids with an in-flight action, so only that row shows a spinner. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  /** providerId -> the flash line shown under that row. */
  const [flash, setFlash] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  /**
   * Which rows are open.
   *
   * Kept here rather than in the row so it survives the `load()` that follows
   * every save: a row that collapsed itself the moment the user pressed Save
   * would hide the confirmation line it just produced.
   */
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  /**
   * providerId/modelId -> the last connectivity reading for that pair.
   *
   * Keyed by both because a model id is only unique within its provider: two
   * vendors may well both publish something called `flash`, and a reading taken
   * against one of them must never be shown on the other's row.
   */
  const [probes, setProbes] = useState<Record<string, ModelProbeReading>>({})
  /** The pair currently being measured, so only one button shows a spinner. */
  const [probing, setProbing] = useState<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  /**
   * Ask the host to run one real request against a model, and keep the reading.
   *
   * The pair goes to the route exactly as the row spells it, because the host's
   * adapter registry is the only thing that knows which credential and endpoint
   * a given provider id resolves to. A transport failure is turned into a
   * reading rather than thrown, because "the test did not run" and "the test
   * failed" are both things this row should be able to print.
   */
  const testModel = useCallback(async (provider: string, model: string): Promise<void> => {
    const key = `${provider}/${model}`
    if (probing !== undefined) return
    setProbing(key)
    try {
      const response = await fetch(POOL_MODEL_PROBE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider, model }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      const reading = value as PoolWebModelProbeResult | undefined
      if (mounted.current) {
        setProbes(prev => ({
          ...prev,
          [key]: response.ok && reading !== undefined && reading.ok === true
            ? reading
            : {
                ok: false,
                outputChars: 0,
                error: reading?.error ?? `HTTP ${response.status}`,
              },
        }))
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        setProbes(prev => ({
          ...prev,
          [key]: {
            ok: false,
            outputChars: 0,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        }))
      }
    } finally {
      if (mounted.current) setProbing(undefined)
    }
  }, [probing])
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(POOL_AGGREGATE_PATH, {
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
        setStatus(value as PoolWebAggregateStatus)
        setError(undefined)
      }
    } catch (cause: unknown) {
      // A dead panel is an absence of information, not a broken pool: say so
      // in place and let the next click retry.
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])
  /** Post one patch, then re-read the document so the row shows what stuck. */
  const patch = useCallback(async (body: PoolWebAggregatePatch): Promise<boolean> => {
    const key = body.kind === 'provider' ? body.providerId : body.kind
    setBusyIds(prev => new Set(prev).add(key))
    try {
      const response = await fetch(POOL_AGGREGATE_SAVE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `HTTP ${response.status}`)
      }
      await load()
      return true
    } catch (cause: unknown) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setFlash(prev => ({ ...prev, [key]: `${t?.('agg.actionFailed') ?? 'Action failed'}: ${message}` }))
      }
      return false
    } finally {
      if (mounted.current) {
        setBusyIds(prev => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    }
  }, [load, t])
  const test = useCallback(async (providerId: string): Promise<void> => {
    setBusyIds(prev => new Set(prev).add(providerId))
    try {
      const response = await fetch(POOL_AGGREGATE_TEST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ providerId }),
      })
      const probe = await response.json().catch(() => undefined) as PoolWebAggregateProbe | undefined
      if (mounted.current && probe !== undefined) {
        const ok = response.ok && probe.ok
        const head = ok
          ? (t?.('agg.probeOk') ?? 'Connected')
          : (t?.('agg.probeFail') ?? 'Connection failed')
        setFlash(prev => ({ ...prev, [providerId]: `${head} (HTTP ${probe.status}) ${probe.message}` }))
      }
    } finally {
      if (mounted.current) {
        setBusyIds(prev => {
          const next = new Set(prev)
          next.delete(providerId)
          return next
        })
      }
    }
  }, [t])
  const discover = useCallback(async (providerId: string): Promise<void> => {
    setBusyIds(prev => new Set(prev).add(providerId))
    try {
      const response = await fetch(POOL_AGGREGATE_DISCOVER_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ providerId }),
      })
      const probe = await response.json().catch(() => undefined) as PoolWebAggregateProbe | undefined
      if (mounted.current && probe !== undefined) {
        const committed = probe.committed ?? 0
        const line = response.ok && probe.ok
          ? committed > 0
            ? (t?.('agg.discovered', { count: committed }) ?? `Wrote ${committed} models`)
            : (t?.('agg.discoverEmpty') ?? 'That vendor listed no models.')
          : `${t?.('agg.probeFail') ?? 'Connection failed'}: ${probe.message}`
        setFlash(prev => ({ ...prev, [providerId]: line }))
        if (response.ok && probe.ok) await load()
      }
    } finally {
      if (mounted.current) {
        setBusyIds(prev => {
          const next = new Set(prev)
          next.delete(providerId)
          return next
        })
      }
    }
  }, [load, t])
  const laneBusy = busyIds.has('lane')
  const providers = status?.providers ?? []
  const laneEnabled = status?.enabled !== false
  /**
   * How many vendors each filter would show.
   *
   * Counted from the whole roster rather than from the current search, because
   * the buttons ARE the filter: a count that shrank as the user typed would
   * answer a question they did not ask ("how many match what I typed?") instead
   * of the one they did ("how much is in this category?").
   */
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const provider of providers) {
      counts.set(provider.category, (counts.get(provider.category) ?? 0) + 1)
    }
    return counts
  }, [providers])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return providers.filter(provider => {
      if (category !== 'all' && provider.category !== category) return false
      if (needle === '') return true
      if (provider.name.toLowerCase().includes(needle)) return true
      if (provider.id.includes(needle)) return true
      if (provider.notes?.toLowerCase().includes(needle) === true) return true
      return provider.models.some(model => model.toLowerCase().includes(needle))
    })
  }, [providers, query, category])
  /** Model ids contributed right now, so a row can say what it is worth. */
  const contributionByProvider = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of status?.models ?? []) {
      counts.set(row.providerId, (counts.get(row.providerId) ?? 0) + 1)
    }
    return counts
  }, [status?.models])
  /**
   * The full model rows each provider contributes, grouped by provider id.
   *
   * The row's model list is a flat id array, so the per-model facts the status
   * document already carries (window, output ceiling, image support) have to be
   * joined back on here. Providers with no rows get an empty list rather than
   * being skipped, so "this vendor is configured but contributes nothing" stays
   * distinguishable from "this vendor is not in the document at all".
   */
  const modelRowsByProvider = useMemo(() => {
    const grouped = new Map<string, PoolWebAggregateStatus['models'][number][]>()
    for (const row of status?.models ?? []) {
      const bucket = grouped.get(row.providerId)
      if (bucket === undefined) grouped.set(row.providerId, [row])
      else bucket.push(row)
    }
    return grouped
  }, [status?.models])
  return (
    <div className="dsm-workbuddy-xdpool-agg">
      <style>{AGGREGATE_CARD_CSS}</style>
      <PageHero
        title={t?.('agg.title') ?? 'Providers'}
        sub={t?.('agg.sub') ?? ''}
        pills={<>
          <span className="dsm-workbuddy-xdpool-agg-pill" data-tone={laneEnabled ? 'ok' : 'off'}>
            {t?.('agg.laneOn') ?? 'Aggregate lane'}
          </span>
          <span className="dsm-workbuddy-xdpool-agg-pill" data-tone="info">
            {t?.('agg.count', { providers: status?.configured ?? 0, models: status?.modelCount ?? 0 })
              ?? `${status?.configured ?? 0} configured · ${status?.modelCount ?? 0} models`}
          </span>
        </>}
      />
      <div className="dsm-workbuddy-xdpool-agg-lanebar">
        <label className="dsm-workbuddy-xdpool-switch">
          <input
            type="checkbox"
            checked={laneEnabled}
            disabled={laneBusy || status === undefined}
            onChange={event => { void patch({ kind: 'lane', enabled: event.target.checked }) }}
          />
          <span>{t?.('agg.laneOn') ?? 'Aggregate lane'}</span>
        </label>
        {!laneEnabled
          ? <span className="dsm-workbuddy-xdpool-agg-hint">{t?.('agg.laneOffHint') ?? ''}</span>
          : null}
      </div>
      <div className="dsm-workbuddy-xdpool-agg-filter">
        <input
          className="dsm-workbuddy-xdpool-agg-search"
          type="search"
          value={query}
          placeholder={t?.('agg.search') ?? 'Search…'}
          onChange={event => { setQuery(event.target.value) }}
        />
        <div className="dsm-workbuddy-xdpool-agg-cats" role="group">
          <button
            type="button"
            className="dsm-workbuddy-xdpool-agg-cat"
            data-on={category === 'all' ? 'true' : 'false'}
            onClick={() => { setCategory('all') }}
          >
            {t?.('agg.catAll', { count: providers.length }) ?? `All categories (${providers.length})`}
          </button>
          {CATEGORIES.map(value => (
            <button
              key={value}
              type="button"
              className="dsm-workbuddy-xdpool-agg-cat"
              data-on={category === value ? 'true' : 'false'}
              onClick={() => { setCategory(value) }}
            >
              {/* The count rides in the label's own parentheses rather than in a
                  separate chip: "API key (60)" is one control to read, and a
                  bare number floating next to a filter is one more thing to
                  decode before the user can press it. */}
              {t?.(CATEGORY_LABEL[value], { count: categoryCounts.get(value) ?? 0 })
                ?? `${value} (${categoryCounts.get(value) ?? 0})`}
            </button>
          ))}
        </div>
      </div>
      {error !== undefined
        ? <p className="dsm-workbuddy-xdpool-panel-error">{error}</p>
        : null}
      {status === undefined && error === undefined
        ? <p className="dsm-workbuddy-xdpool-panel-empty">…</p>
        : visible.length === 0
          ? <p className="dsm-workbuddy-xdpool-panel-empty">{t?.('agg.empty') ?? 'No vendor matches.'}</p>
          : <div className="dsm-workbuddy-xdpool-agg-list">
              {visible.map(provider => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  contributed={contributionByProvider.get(provider.id) ?? 0}
                  modelRows={modelRowsByProvider.get(provider.id) ?? []}
                  probes={probes}
                  probing={probing}
                  busy={busyIds.has(provider.id)}
                  flash={flash[provider.id]}
                  draft={drafts[provider.id]}
                  open={opened[provider.id] === true}
                  laneEnabled={laneEnabled}
                  t={t}
                  onOpen={() => {
                    setOpened(prev => ({ ...prev, [provider.id]: prev[provider.id] !== true }))
                  }}
                  onDraft={(next) => { setDrafts(prev => ({ ...prev, [provider.id]: next })) }}
                  onSave={async () => {
                    const draft = drafts[provider.id]
                    if (draft === undefined) return
                    const ok = await patch({
                      kind: 'provider',
                      providerId: provider.id,
                      // An empty field means "leave what is stored alone", never
                      // "store an empty key" — clearing has its own action.
                      ...draft.apiKey === '' ? {} : { apiKey: draft.apiKey },
                      ...draft.baseUrl === '' ? {} : { baseUrl: draft.baseUrl },
                    })
                    if (ok) {
                      setDrafts(prev => {
                        const next = { ...prev }
                        delete next[provider.id]
                        return next
                      })
                      setFlash(prev => ({ ...prev, [provider.id]: t?.('agg.saved') ?? 'Saved' }))
                    }
                  }}
                  onClear={async () => {
                    const ok = await patch({ kind: 'clear', providerId: provider.id })
                    if (ok) {
                      setDrafts(prev => {
                        const next = { ...prev }
                        delete next[provider.id]
                        return next
                      })
                      setFlash(prev => ({ ...prev, [provider.id]: t?.('agg.cleared') ?? 'Cleared' }))
                    }
                  }}
                  onToggle={enabled => { void patch({ kind: 'provider', providerId: provider.id, enabled }) }}
                  onTest={() => { void test(provider.id) }}
                  onDiscover={() => { void discover(provider.id) }}
                  onTestModel={(model) => { void testModel(provider.id, model) }}
                />
              ))}
            </div>}
    </div>
  )
}
function ProviderRow({
  provider,
  contributed,
  modelRows,
  probes,
  probing,
  busy,
  flash,
  draft,
  open,
  laneEnabled,
  t,
  onOpen,
  onDraft,
  onSave,
  onClear,
  onToggle,
  onTest,
  onDiscover,
  onTestModel,
}: {
  provider: PoolWebAggregateProvider
  /** How many model rows this provider contributes to the picker right now. */
  contributed: number
  /**
   * The full model rows this provider contributes, for the facts and the test
   * button.
   *
   * Only the enabled ones are here, so a row never offers to test a model the
   * lane would not serve. An empty list is meaningful — it is a configured
   * vendor contributing nothing — so the caller passes `[]` rather than
   * omitting the prop.
   */
  modelRows: readonly PoolWebAggregateStatus['models'][number][]
  /** `"<providerId>/<modelId>"` -> the last reading for that pair. */
  probes: Readonly<Record<string, ModelProbeReading>>
  /** The pair currently being measured, as the same `"<provider>/<model>"` key. */
  probing: string | undefined
  busy: boolean
  flash?: string | undefined
  draft?: ProviderDraft | undefined
  open: boolean
  laneEnabled: boolean
  t?: Translate | undefined
  onOpen: () => void
  onDraft: (next: ProviderDraft) => void
  onSave: () => Promise<void>
  onClear: () => Promise<void>
  onToggle: (enabled: boolean) => void
  onTest: () => void
  onDiscover: () => void
  /** Run one connectivity test against one of this vendor's models. */
  onTestModel: (modelId: string) => void
}) {
  const enabled = provider.enabled
  const effective = enabled && laneEnabled
  const keyState = provider.authKind === 'none'
    ? (t?.('agg.noKeyNeeded') ?? 'No key needed')
    : provider.configured
      ? (t?.('agg.keySet') ?? 'Key set')
      : (t?.('agg.noKey') ?? 'No key')
  const preview = provider.models.slice(0, MODEL_PREVIEW)
  const rest = provider.models.length - preview.length
  const category = CATEGORY_LABEL[provider.category as Category]
  // Sign-in channel artwork first: where a vendor is both (minimax, gemini) that
  // icon is already worn by the other two pages, and showing two different marks
  // for one company would read as a bug. Then the vendor table. Three of the
  // seventy-six have neither and fall through to initials, which is honest in a
  // way a borrowed logo is not.
  const icon = channelIcon(provider.id) ?? providerIcon(provider.id)
  const tileMark =
    icon === undefined ? { initials: channelInitials(provider.name) } : { icon }
  const paneId = `dsm-xdpool-agg-${provider.id}`
  return (
    <article
      className="dsm-workbuddy-xdpool-agg-row"
      data-off={effective ? 'false' : 'true'}
      data-open={open ? 'true' : 'false'}
      style={{ '--dsm-workbuddy-xdpool-agg-accent': accentFor(provider.id) } as Record<string, string>}
    >
      <div className="dsm-workbuddy-xdpool-agg-rowhead">
        {/* The same 40px tile the sign-in page and the pool cards wear, so the
            three lists read as one product. */}
        <BrandTile accent={accentFor(provider.id)} glyph="globe" {...tileMark} />
        <div className="dsm-workbuddy-xdpool-agg-titles">
          <span className="dsm-workbuddy-xdpool-agg-name">{provider.name}</span>
          <span className="dsm-workbuddy-xdpool-agg-org">
            {category === undefined ? provider.category : (t?.(category) ?? provider.category)}
            {` · ${provider.format}`}
          </span>
        </div>
        <span className="dsm-workbuddy-xdpool-agg-state" data-tone={enabled ? 'ok' : 'off'}>
          {enabled
            ? (t?.('agg.stateOn') ?? 'In the pool')
            : (t?.('agg.stateOff') ?? 'Not in the pool')}
        </span>
      </div>
      {/* The vendor's own description, straight from the registry. There is no
          per-model blurb to show — the registry's model rows carry an id, a
          name and three capability flags and nothing else — so this is the
          vendor's line and the row must not pretend it describes a model. */}
      {provider.notes === undefined
        ? null
        : <p className="dsm-workbuddy-xdpool-agg-note">{provider.notes}</p>}
      <div className="dsm-workbuddy-xdpool-agg-foot">
        <div className="dsm-workbuddy-xdpool-agg-tags">
          <span className="dsm-workbuddy-xdpool-agg-tag" data-tone={provider.configured ? 'ok' : 'off'}>
            {keyState}
          </span>
          <span className="dsm-workbuddy-xdpool-agg-tag" data-tone="info">
            {t?.('agg.models', { count: provider.models.length }) ?? `${provider.models.length} models`}
          </span>
          {contributed > 0
            ? <span className="dsm-workbuddy-xdpool-agg-tag" data-tone="busy">
                {t?.('agg.contributed', { count: contributed })
                  ?? `contributes ${contributed} models`}
              </span>
            : null}
          {provider.discovered
            ? <span className="dsm-workbuddy-xdpool-agg-tag" data-tone="live">
                {t?.('agg.discoveredTag') ?? 'live'}
              </span>
            : null}
          {/* Kept in the collapsed row rather than left inside the pane: it is
              what tells the user the "Fetch models" button is worth opening the
              row for in the first place. */}
          {provider.hasListing
            ? <span className="dsm-workbuddy-xdpool-agg-tag" data-tone="info">
                {t?.('agg.listingYes') ?? 'Model list available'}
              </span>
            : null}
        </div>
        <button
          type="button"
          className="dsm-workbuddy-xdpool-agg-open"
          aria-expanded={open}
          aria-controls={paneId}
          onClick={onOpen}
        >
          <span className="dsm-workbuddy-xdpool-agg-open-caret" aria-hidden="true" />
          {open
            ? (t?.('row.collapse') ?? 'Collapse')
            : (t?.('agg.setup') ?? 'Set up')}
        </button>
      </div>
      <div
        className="dsm-workbuddy-xdpool-agg-pane"
        id={paneId}
        role="group"
        hidden={!open}
      >
        {!provider.supported
          ? <p className="dsm-workbuddy-xdpool-agg-warn">
              {t?.('agg.unsupported') ?? 'This vendor signs in via OAuth/ADC.'}
            </p>
          : null}
        {provider.authKind !== 'none'
          ? <div className="dsm-workbuddy-xdpool-agg-fields">
              <label className="dsm-workbuddy-xdpool-agg-field">
                <span>{t?.('agg.key') ?? 'API key'}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={draft?.apiKey ?? ''}
                  placeholder={t?.('agg.keyPlaceholder') ?? 'Paste the key'}
                  onChange={event => { onDraft({ apiKey: event.target.value, baseUrl: draft?.baseUrl ?? '' }) }}
                />
              </label>
              <label className="dsm-workbuddy-xdpool-agg-field">
                <span>{t?.('agg.baseUrl') ?? 'Endpoint'}</span>
                <input
                  type="text"
                  value={draft?.baseUrl ?? provider.baseUrl ?? ''}
                  placeholder={t?.('agg.baseUrlPlaceholder') ?? 'Blank uses the default'}
                  onChange={event => { onDraft({ apiKey: draft?.apiKey ?? '', baseUrl: event.target.value }) }}
                />
              </label>
            </div>
          : null}
        {/* The switch is separate from Save on purpose. Saving a key is what puts
            a vendor in the pool — that is the whole point of pasting one — but
            taking a vendor back OUT without throwing the key away is a different
            decision, and it needs its own control. */}
        <label className="dsm-workbuddy-xdpool-switch dsm-workbuddy-xdpool-agg-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={event => { onToggle(event.target.checked) }}
          />
          <span>{t?.('agg.enable') ?? 'Add to the pool'}</span>
        </label>
        <span className="dsm-workbuddy-xdpool-agg-hint">{t?.('agg.enableHint') ?? ''}</span>
        <div className="dsm-workbuddy-xdpool-agg-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-primary"
            disabled={busy || !provider.supported}
            onClick={() => { void onSave() }}
          >
            {busy ? (t?.('agg.saving') ?? 'Saving…') : (t?.('agg.save') ?? 'Save')}
          </button>
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={busy || !provider.supported}
            onClick={() => { void onTest() }}
          >
            {t?.('agg.test') ?? 'Test'}
          </button>
          {provider.hasListing
            ? <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={busy || !provider.supported || !provider.configured}
                onClick={() => { void onDiscover() }}
              >
                {t?.('agg.discover') ?? 'Fetch models'}
              </button>
            : null}
          {provider.authUrl !== undefined
            ? <a className="dsm-btn dsm-btn-ghost" href={provider.authUrl} target="_blank" rel="noreferrer noopener">
                {t?.('agg.getKey') ?? 'Get a key'}
              </a>
            : null}
          {provider.website !== undefined && provider.website !== provider.authUrl
            ? <a className="dsm-btn dsm-btn-ghost" href={provider.website} target="_blank" rel="noreferrer noopener">
                {t?.('agg.website') ?? 'Website'}
              </a>
            : null}
          <button
            type="button"
            className="dsm-btn dsm-btn-ghost"
            disabled={busy}
            onClick={() => { void onClear() }}
          >
            {t?.('agg.clear') ?? 'Clear'}
          </button>
        </div>
        {preview.length > 0
          ? <p className="dsm-workbuddy-xdpool-agg-models">
              {preview.join(' · ')}
              {rest > 0 ? ` +${rest}` : ''}
            </p>
          : null}
        {/* The preview line above is ids only, so it cannot answer "how big a
            context does that model have, and can it see a screenshot" — the two
            questions a user actually opens a provider page to ask. The full
            rows are already in the document; they are joined on here rather
            than re-fetched, so what is printed is the same numbers the lane
            serves from. */}
        {modelRows.length > 0
          ? <ul className="dsm-workbuddy-xdpool-agg-facts">
              {modelRows.map(row => {
                const key = `${provider.id}/${row.modelId}`
                return (
                  <li
                    key={row.id}
                    className="dsm-workbuddy-xdpool-agg-fact"
                    data-live={row.source === 'discovered' ? 'true' : undefined}
                  >
                    <span className="dsm-workbuddy-xdpool-agg-fact-name">{row.name}</span>
                    <ModelFactsRow
                      t={t}
                      facts={modelFactsFor(row)}
                      {...probes[key] === undefined
                        ? { onTest: () => { onTestModel(row.modelId) } }
                        : { probe: probes[key], probing: probing === key }}
                    />
                  </li>
                )
              })}
            </ul>
          : null}
        {flash !== undefined
          ? <p className="dsm-workbuddy-xdpool-agg-flash">{flash}</p>
          : null}
      </div>
    </article>
  )
}
