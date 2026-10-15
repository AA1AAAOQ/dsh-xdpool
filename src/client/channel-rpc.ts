/**
 * The pack's management RPC, spoken once for the login page's cards.
 *
 * This used to live inside {@link ./ChannelsPage} as a private function. It
 * stopped being private when the account pool asked the same question the login
 * page already asks — "how many accounts and models does each channel have
 * right now" — because two copies of an envelope parser is one copy too many:
 * they drift, and the drift shows up as a card that reads zero.
 *
 * Everything here is presentation-safe. No method in {@link CHANNEL_PACK_METHODS}
 * returns a credential, and none of these parsers invent a field the pack did not
 * send: an answer we cannot read becomes "not connected", never a guessed zero.
 *
 * @module dsh-xdpool/client/channel-rpc
 */
import { CHANNEL_PACK_RPC_PATH } from '../status-paths.ts'
import type {
  ChannelAccount,
  ChannelAccountCreated,
  ChannelLoginPoll,
  ChannelRpcEnvelope,
} from '../channels.ts'

/**
 * Call the pack's own management route.
 *
 * The bundle registers `/api/channel-pack` itself and speaks a two-field RPC
 * envelope, so this speaks that envelope rather than inventing a shape and
 * unwrapping it on the way back. Every return is an `ok`/`error` decision the
 * caller must make explicitly: a failed login is a normal outcome here, not an
 * exception, and turning it into a thrown error would lose the pack's own
 * message.
 */
export async function callPack(method: string, payload: Record<string, unknown>): Promise<ChannelRpcEnvelope> {
  const response = await fetch(CHANNEL_PACK_RPC_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `xdpool-${Date.now().toString(36)}`,
      method: 'channel-pack',
      payload: { method, payload },
    }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: { message: `HTTP ${response.status}` } }
  }
  const message = (body as { result?: unknown }).result
  if (message === null || typeof message !== 'object') {
    return { ok: false, error: { message: `HTTP ${response.status}` } }
  }
  return message as ChannelRpcEnvelope
}

/** The pack's account id, read defensively — an unidentifiable entry is skipped. */
export function channelIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function createdFrom(envelope: ChannelRpcEnvelope): ChannelAccountCreated | undefined {
  const value = envelope.value
  if (value === null || typeof value !== 'object') return undefined
  const accountId = (value as { accountId?: unknown }).accountId
  const loginUrl = (value as { loginUrl?: unknown }).loginUrl
  // A login URL is mandatory here. `account.create` can legitimately answer
  // without one (some channels poll a device the user is already holding), and
  // inventing a link to show would send them nowhere.
  if (typeof accountId !== 'string' || typeof loginUrl !== 'string' || loginUrl.length === 0) {
    return undefined
  }
  return { accountId, loginUrl }
}

export function pollFrom(envelope: ChannelRpcEnvelope): ChannelLoginPoll {
  const value = envelope.value
  if (value === null || typeof value !== 'object') return { done: false }
  const done = (value as { done?: unknown }).done === true
  const success = (value as { success?: unknown }).success
  const error = (value as { error?: unknown }).error
  return {
    done,
    ...typeof success === 'boolean' ? { success } : {},
    ...typeof error === 'string' && error.length > 0 ? { error } : {},
  }
}

export function accountsFrom(envelope: ChannelRpcEnvelope): ChannelAccount[] {
  const value = envelope.value
  if (value === null || typeof value !== 'object') return []
  const accounts = (value as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return []
  const rows: ChannelAccount[] = []
  for (const entry of accounts) {
    const id = channelIdOf(entry)
    if (id === undefined) continue
    const provider = (entry as { provider?: unknown }).provider
    rows.push({
      id,
      provider: typeof provider === 'string' ? provider : '',
      ...(entry as { nickname?: unknown }).nickname !== undefined
        ? { nickname: String((entry as { nickname?: unknown }).nickname) }
        : {},
      ...(entry as { enabled?: unknown }).enabled !== undefined
        ? { enabled: (entry as { enabled?: unknown }).enabled === true }
        : {},
    })
  }
  return rows
}

/**
 * One model as the host's catalogue spells it, narrowed to what this page shows.
 *
 * The window, the ceiling and the modalities are all optional because the host
 * omits any it does not know, and omitting is the honest answer here: a filled-in
 * guess would be a number the user cannot check and we cannot defend.
 */
export interface ChannelModel {
  id: string
  name: string
  contextWindow?: number | undefined
  maxTokens?: number | undefined
  /** `'text'` and `'image'` are the host's two modalities. */
  inputModalities?: readonly string[] | undefined
  description?: string | undefined
}

function modelFrom(value: unknown): ChannelModel | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') return undefined
  const name = (value as { name?: unknown }).name
  const contextWindow = (value as { contextWindow?: unknown }).contextWindow
  const maxTokens = (value as { maxTokens?: unknown }).maxTokens
  const modalities = (value as { inputModalities?: unknown }).inputModalities
  const description = (value as { description?: unknown }).description
  return {
    id,
    // A nameless model still has to be clickable, and the id is what the host
    // addresses it by — so the id stands in rather than the row vanishing.
    name: typeof name === 'string' && name !== '' ? name : id,
    ...typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {},
    ...typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
      ? { maxTokens }
      : {},
    ...Array.isArray(modalities)
      ? { inputModalities: modalities.filter((item): item is string => typeof item === 'string') }
      : {},
    ...typeof description === 'string' && description !== '' ? { description } : {},
  }
}

/**
 * Read the route's per-provider model lists.
 *
 * A provider the host could not answer for is left out of the map rather than
 * mapped to an empty array, so the caller can tell "this channel is not
 * signed in" from "this channel is signed in and contributes nothing". Those are
 * different rows in a user's head and collapsing them would be a lie by layout.
 */
export function modelListsFrom(value: unknown): ReadonlyMap<string, readonly ChannelModel[]> {
  const out = new Map<string, ChannelModel[]>()
  if (value === null || typeof value !== 'object') return out
  const lists = (value as { models?: unknown }).models
  if (lists === null || typeof lists !== 'object') return out
  for (const [provider, rows] of Object.entries(lists)) {
    if (!Array.isArray(rows)) continue
    const models = rows
      .map(modelFrom)
      .filter((model): model is ChannelModel => model !== undefined)
    out.set(provider, models)
  }
  return out
}

/** One channel's counts, as the pack reports them. */
export interface ChannelProviderStatus {
  /** Models the vendor publishes, enabled or not. */
  modelsTotal: number
  /** How many of those the user has switched off. */
  modelsDisabled: number
  /** Accounts connected, enabled or not. */
  accountsTotal: number
  /** How many of those are actually usable. */
  accountsEnabled: number
  /**
   * True when every published model is switched off.
   *
   * The pack reports this rather than letting the card derive it, because a
   * channel with *no* models at all is not closed — it simply has not published
   * yet, and calling that "closed" would tell the user to go and find a setting
   * that does not exist.
   */
  closed: boolean
}
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}
function statusFrom(value: unknown): ChannelProviderStatus | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const models = (value as { models?: unknown }).models
  const accounts = (value as { accounts?: unknown }).accounts
  if (models === null || typeof models !== 'object' || accounts === null || typeof accounts !== 'object') {
    return undefined
  }
  const modelsTotal = countOf((models as { total?: unknown }).total)
  // `disabled` can never exceed `total` from an honest pack; clamping means a
  // card can never print "18/12 models", which reads as a bug in the plugin.
  const modelsDisabled = Math.min(countOf((models as { disabled?: unknown }).disabled), modelsTotal)
  return {
    modelsTotal,
    modelsDisabled,
    accountsTotal: countOf((accounts as { total?: unknown }).total),
    accountsEnabled: countOf((accounts as { enabled?: unknown }).enabled),
    closed: (value as { closed?: unknown }).closed === true,
  }
}

/**
 * Read every channel's counts in one round trip.
 *
 * `provider.status` takes a list and answers a map, so the account pool asks
 * about all thirteen at once rather than thirteen times. A channel the pack
 * omits from the answer is simply absent from the map — the caller then has to
 * decide what "absent" means, and for counts it must not mean zero.
 */
export function providerStatusesFrom(
  envelope: ChannelRpcEnvelope,
): ReadonlyMap<string, ChannelProviderStatus> {
  const statuses = new Map<string, ChannelProviderStatus>()
  if (!envelope.ok) return statuses
  const value = envelope.value
  if (value === null || typeof value !== 'object') return statuses
  const table = (value as { statuses?: unknown }).statuses
  if (table === null || typeof table !== 'object') return statuses
  for (const [provider, raw] of Object.entries(table)) {
    const status = statusFrom(raw)
    if (status !== undefined) statuses.set(provider, status)
  }
  return statuses
}