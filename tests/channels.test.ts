import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  POOL_CHANNELS_PATH,
  CHANNEL_PACK_RPC_PATH,
  CHANNEL_PACK_METHODS,
} from '../src/status-paths.ts'
import {
  REGISTERED_CHANNELS,
  POOL_OWNED_CHANNELS,
  isChannelProviderId,
} from '../src/channels.ts'
/**
 * The channel list is the one card page whose behaviour lives in a vendored
 * bundle we do not control, so these tests assert the parts we DO own: that our
 * roster matches what the pack registers, and that the card's route names and
 * method allowlist cannot quietly drift from the pack's own HTTP surface.
 */
describe('login channel roster', () => {
  it('lists thirteen channels', () => {
    expect(REGISTERED_CHANNELS).toHaveLength(13)
  })
  it('gives every channel a unique id', () => {
    const ids = REGISTERED_CHANNELS.map((channel) => channel.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('marks exactly the two channels the pool already serves', () => {
    // The pack registers `buddy` and `workbuddy` adapters too. Our own
    // registration happens first and the pack's duplicate is skipped, so
    // offering a login for them would start a second, unmanaged account for a
    // channel the user is already rotating through above.
    expect([...POOL_OWNED_CHANNELS].sort()).toEqual(['buddy', 'workbuddy'])
    const owned = REGISTERED_CHANNELS.filter((channel) => POOL_OWNED_CHANNELS.has(channel.id))
    expect(owned.map((channel) => channel.id).sort()).toEqual(['buddy', 'workbuddy'])
  })
  it('recognises every channel it lists, and nothing else', () => {
    for (const channel of REGISTERED_CHANNELS) {
      expect(isChannelProviderId(channel.id)).toBe(true)
    }
    expect(isChannelProviderId('opencode')).toBe(false)
  })
  it('carries an accent for every channel, so a row is never colourless', () => {
    for (const channel of REGISTERED_CHANNELS) {
      expect(channel.accent).toMatch(/^#[0-9A-Fa-f]{6}$/u)
    }
  })
  it('offers every channel the same one button', () => {
    // The user asked why Loomy alone offered "登录（短信）". It came from the
    // reference build's roster, where the pack itself decides whether a phone
    // code is offered — this card only ever opens the vendor's page. So there is
    // now exactly one login kind, and a channel that needs something else fails
    // to typecheck rather than inventing a button for it.
    expect([...new Set(REGISTERED_CHANNELS.map((channel) => channel.login))]).toEqual(['browser'])
  })
  it('states the free allowance in Chinese on every card', () => {
    for (const channel of REGISTERED_CHANNELS) {
      // The old copy was 每日免费额度 on eleven of thirteen rows: it named the
      // existence of a free allowance without ever saying what it was.
      expect(channel.note, channel.id).not.toBe('每日免费额度')
      expect(channel.note, channel.id).toMatch(/[一-鿿]/u)
    }
  })
})
describe('channel route contract', () => {
  it('addresses the list and the pack RPC on separate paths', () => {
    expect(POOL_CHANNELS_PATH).toBe('/plugins/dsh-xdpool/channels')
    expect(CHANNEL_PACK_RPC_PATH).toBe('/api/channel-pack')
  })
  it('forwards only the three methods the UI actually calls', () => {
    // The pack answers far more (credits.claim, opencode.*, model management).
    // Anything wider puts its whole surface on the card's loopback origin for
    // no benefit, so the allowlist is asserted rather than left to review.
    expect([...CHANNEL_PACK_METHODS].sort()).toEqual(['account.create', 'account.list', 'login.poll'])
  })
  it('is not widened by a call site behind the route doc comment', () => {
    // The route doc claims three methods; if someone adds a fourth call without
    // adding it here, this fails and the comment stops being a claim. Every
    // page that talks to the pack is scanned, not just the first one — the
    // pool page used to read per-vendor counts here too, and that call site is
    // exactly the kind of thing a single-file scan would have missed.
    const called = ['ChannelsPage.tsx', 'PoolCard.tsx'].flatMap((name) => [
      ...readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
        .matchAll(/callPack\('([^']+)'/gu),
    ]).map((match) => match[1] as string)
    expect(called.length).toBeGreaterThan(0)
    for (const method of called) expect(CHANNEL_PACK_METHODS.has(method)).toBe(true)
  })
})