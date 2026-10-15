import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { channelIcon, channelInitials } from '../src/client/channel-icons.ts'
import { REGISTERED_CHANNELS } from '../src/channels.ts'

const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const tile = readFileSync(new URL('../src/client/brand-tile.tsx', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../src/client/ChannelsPage.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../src/client/shell.tsx', import.meta.url), 'utf8')

/**
 * The tile is rendered by three pages, so its rules have to be in the sheet the
 * shell injects everywhere. Slicing `CHANNEL_CARD_CSS` here is what let the bug
 * through: it passed while the pool's region cards and the aggregate rows were
 * drawing an unstyled tile.
 */
function sharedCss(): string {
  return styles.slice(styles.indexOf('export const SHARED_CARD_CSS'))
}

/**
 * Five of the thirteen channels carry no logo in any build we ship, and until
 * this rule existed they all wore the same `login` key — so the user saw five
 * different vendors drawn identically and reported the icons as missing.
 *
 * These tests pin the three failures that fix has to keep not regressing into:
 * a shared generic glyph, two vendors sharing a monogram, and a one-letter tile
 * that reads as broken at 40px.
 */
describe('a channel with no logo wears its own letters', () => {
  it('gives every artwork-less channel a mark of its own', () => {
    // Derived, not listed: a hand-written roster goes stale the moment a
    // vendor's artwork lands or a channel is added, and a stale list is exactly
    // how five identical tiles got shipped in the first place.
    const noArtwork = REGISTERED_CHANNELS.filter((channel) => channelIcon(channel.id) === undefined)
    expect(noArtwork.length).toBeGreaterThanOrEqual(5)
    const marks = noArtwork.map((channel) => channelInitials(channel.name))
    for (const [index, mark] of marks.entries()) {
      expect(mark, `${noArtwork[index]?.id ?? ''} must wear letters, not a glyph`).toMatch(/^[0-9A-Z]{1,2}$/u)
    }
    // Distinctness is the whole point: a collision is what the user saw.
    expect(new Set(marks).size, `colliding marks: ${marks.join(' ')}`).toBe(marks.length)
  })

  it('separates vendors whose names start with the same letters', () => {
    // LobsterAI and Loomy both begin "Lo"; taking a plain first-two-letters
    // would draw them identically. Both of these are on the channel page.
    expect(channelInitials('Loomy')).not.toBe(channelInitials('LobsterAI'))
    expect(channelInitials('WorkBuddy 国内版')).toBe(channelInitials('WorkBuddy 国际版'))
  })

  it('never leaves a single letter alone in a 40px tile', () => {
    // TRAE is one uppercase run, so a first-letter rule renders "T" and the
    // tile looks half-empty next to the ones carrying two letters.
    expect(channelInitials('TRAE').length).toBeGreaterThanOrEqual(2)
    expect(channelInitials('ZCode')).toBe('ZC')
  })

  it('ignores non-Latin parts of a name', () => {
    // The reader recognises "WorkBuddy", not "国内版". Taking the first Latin
    // letter per word also keeps the mark stable if the CJK suffix is reworded.
    expect(channelInitials('Qoder 国内版')).toBe('QO')
    expect(channelInitials('Qoder 国际版')).toBe('QO')
    expect(channelInitials('')).toBe('')
  })

  it('drops the mask when letters are shown, so no glyph leaks through', () => {
    expect(tile).toContain("letters === undefined ? BRAND_TILE_GLYPHS[glyph] : 'none'")
    expect(tile).toContain('icon === undefined ? tileInitials(initials) : undefined')
    // Artwork still wins: a channel that has a logo must never get letters too.
    expect(tile).toContain('icon === undefined ? \'\' : \' dsm-xdpool-tile-art\'')
  })

  it('centres the letters on the gradient and sizes them for 40px', () => {
    const block = sharedCss()
    expect(block).toMatch(/\.dsm-xdpool-tile-letters\{[^}]*display:grid[^}]*place-items:center/u)
    expect(block).toMatch(/\.dsm-xdpool-tile-letters\{[^}]*font-weight:800/u)
    // The gradient tile's mask would otherwise paint a key glyph on top of the
    // letters; the letters variant has to switch it off.
    expect(block).toMatch(/\.dsm-xdpool-tile-letters::after\{content:none\}/u)
  })

  it('styles the tile for every page that renders one, not just the login page', () => {
    // The regression that matters: the pool page and the aggregate page both
    // render <BrandTile> but load neither CHANNEL_CARD_CSS nor anything else
    // that declared the tile, so their logos came out as blank 40px boxes. The
    // rule belongs in the shared sheet the shell injects once for every page.
    for (const selector of [
      '.dsm-xdpool-tile',
      '.dsm-xdpool-tile::after',
      '.dsm-xdpool-tile-art',
      '.dsm-xdpool-tile-letters',
    ]) {
      expect(sharedCss(), `${selector} must be styled in the shared sheet`).toContain(`${selector}{`)
    }
    // And the shell must actually inject that sheet, or the relocation is
    // merely a move from one unreachable place to another.
    expect(shell).toContain('SHARED_CARD_CSS')
  })

  it('passes the vendor name through on the card that needs it', () => {
    expect(channels).toContain('channelInitials(channel.name)')
    expect(channels).toContain("from './channel-icons.ts'")
  })
})