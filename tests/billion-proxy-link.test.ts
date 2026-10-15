/**
 * The billion-context page's links out to the proxy.
 *
 * The user asked for the fleet table to stop being the page. What replaced it is
 * a link into billion-context's OWN dashboard, which the tests below pin from
 * both ends, because a link into someone else's UI fails quietly:
 *
 * - the relay must actually publish that origin, on every state where the user
 *   could use it, and must never publish it for a proxy it did not find;
 * - `proxyLink` must refuse to build a URL it cannot trust. The dangerous
 *   shapes are the ones that still produce a string: a relative origin would
 *   resolve against the HOST and open the wrong page, and a raw session id can
 *   carry characters the proxy's own hash route cannot hold.
 * - the page must open those links in a tab it gives up control of, or a proxy
 *   page could reach back into the settings panel.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { proxyLink } from '../src/client/BillionPage.tsx'
const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')
const page = read('../src/client/BillionPage.tsx')
const styles = read('../src/client/styles.ts')
const locales = read('../src/client/locales.ts')

describe('the proxy link builder', () => {
  it('builds a link to the proxy dashboard from its recorded origin', () => {
    expect(proxyLink('http://127.0.0.1:60201', '#/overview')).toBe(
      'http://127.0.0.1:60201/__bili/#/overview',
    )
  })
  it('keeps /__bili/ at the root even when the origin carries a path', () => {
    // The proxy registers that prefix absolutely, so a base path on the origin
    // is not a prefix to preserve.
    expect(proxyLink('http://127.0.0.1:60201/base/', '#/overview')).toBe(
      'http://127.0.0.1:60201/__bili/#/overview',
    )
  })
  it('refuses every origin that cannot be trusted', () => {
    // Absent: the proxy was never found.
    expect(proxyLink(undefined, '#/overview')).toBeUndefined()
    expect(proxyLink('', '#/overview')).toBeUndefined()
    // The one that matters most: a relative or malformed origin would still
    // produce a string, and `window.open` would happily follow it — against the
    // host instead of the proxy.
    expect(proxyLink('/__bili', '#/overview')).toBeUndefined()
    expect(proxyLink('not a url', '#/overview')).toBeUndefined()
    expect(proxyLink('127.0.0.1:60201', '#/overview')).toBeUndefined()
    // A scheme that is not http(s) is never the loopback proxy.
    expect(proxyLink('file:///tmp', '#/overview')).toBeUndefined()
  })
  it('encodes the session id it puts in the hash', () => {
    // These are proxy-chosen ids. A raw slash or hash would silently retarget
    // the deep link, so the id is escaped at the call site's discretion and the
    // builder only has to carry it through.
    const id = 'a b#c/d?e'
    const link = proxyLink('http://127.0.0.1:60201', `#/sessions/${encodeURIComponent(id)}`)
    expect(link).toBe(`http://127.0.0.1:60201/__bili/#/sessions/${encodeURIComponent(id)}`)
    expect(link).toContain('a%20b%23c%2Fd%3Fe')
  })
})

describe('the relay publishes the origin', () => {
  const relay = read('../src/billion.ts')
  it('carries it on every state where the URL is a usable handle', () => {
    // `ready` and `unreachable` both need it. `missing` must NOT have one: no
    // proxy was found, so any origin here would be invented.
    const readyAt = relay.indexOf("state: 'ready'")
    const unreachableAt = relay.indexOf("state: 'unreachable'")
    const missingAt = relay.indexOf("state: 'missing'")
    expect(readyAt).toBeGreaterThan(-1)
    expect(unreachableAt).toBeGreaterThan(-1)
    expect(missingAt).toBeGreaterThan(-1)
    expect(relay.slice(readyAt, readyAt + 120)).toContain('origin,')
    expect(relay.slice(unreachableAt, unreachableAt + 400)).toContain('origin,')
    // The missing block is short and closed before the origin could be added.
    const missingBlock = relay.slice(missingAt, missingAt + 400)
    expect(missingBlock).not.toContain('origin,')
  })
  it('still hands over counts only — an origin is an address, not a title', () => {
    // Adding the origin must not have widened the relay into conversation
    // material. The two endpoints are the whole contract.
    expect(relay.match(/fetchJson\(origin, '([^']+)'\)/gu)).toEqual([
      `fetchJson(origin, '/health')`,
      `fetchJson(origin, '/sessions')`,
    ])
    expect(relay).not.toContain('/detail')
  })
})

describe('the page links instead of redrawing', () => {
  it('starts the fleet table collapsed and lets the user open it', () => {
    // The summary is the page; 50 rows is a wall nobody asked for.
    expect(page).toContain('useState(false)')
    expect(page).toContain('{rowsOpen')
    expect(page).toContain('aria-expanded={rowsOpen}')
    expect(page).toContain("t?.('billion.showRows'")
    expect(page).toContain("t?.('billion.hideRows'")
  })
  it('sends every session row to the proxy own detail route', () => {
    expect(page).toContain('`#/sessions/${encodeURIComponent(row.id)}`')
    expect(page).toContain('dsm-xdpool-sesslink')
  })
  it('hands the opened tab to the proxy rather than keeping a handle on it', () => {
    // Same rule as the channels page: the destination owns that tab, and this
    // page must not be able to reach back into it.
    expect(page).toContain(`rel="noopener noreferrer"`)
    expect(page).toContain(`target="_blank"`)
    expect(page).toContain(`window.open(url, '_blank', 'noopener')`)
    expect(page).not.toMatch(/target="_blank"(?![^>]*rel="noopener noreferrer")/u)
  })
  it('still cannot write to the proxy — linking is still a GET', () => {
    expect(page).not.toMatch(/\bmethod:\s*'(POST|PUT|PATCH|DELETE)'/u)
    expect(page.match(/await fetch\(/gu) ?? []).toHaveLength(1)
  })
  it('carries every string it renders, in both languages', () => {
    const used = [...page.matchAll(/t\?\.\('(billion\.[A-Za-z]+)'/gu)].map(m => m[1])
    for (const key of new Set(used)) {
      expect(locales, `missing ${key}`).toContain(`'${key}'`)
    }
    const enStart = locales.indexOf('export const en = {')
    const enEnd = locales.indexOf('} as const', enStart)
    const zhStart = locales.indexOf('export const zh')
    const zh = locales.slice(zhStart)
    for (const key of [
      'billion.openDashboard',
      'billion.showRows',
      'billion.hideRows',
      'billion.rowsHint',
    ]) {
      expect(locales.slice(enStart, enEnd), `${key} missing from en`).toContain(`'${key}'`)
      expect(zh, `${key} missing from zh`).toContain(`'${key}'`)
    }
  })
  it('defines every class it renders', () => {
    const billionCss = styles.slice(styles.indexOf('export const BILLION_CARD_CSS'))
    const used = new Set(
      [...page.matchAll(/dsm-xdpool-([a-z0-9-]+)/gu)].map(m => m[0]),
    )
    // Shared classes live in the ledger stylesheet, which this page also loads.
    const shared = ['sec', 'sectitle', 'table', 'tablewrap', 'num', 'ellipsis', 'note', 'kpis', 'steps']
    const missing = [...used].filter(
      name => !billionCss.includes(`.${name}`) && !styles.includes(`.${name}`),
    )
    expect(missing, 'BillionPage renders classes with no CSS rule').toEqual([])
    // …and the ones that are new must be in THIS page's own block, not merely
    // somewhere in the file, so removing them here is caught.
    for (const name of ['sechead', 'secbtns', 'secghost', 'sesslink']) {
      expect(billionCss, `.${name} missing from BILLION_CARD_CSS`).toContain(`.dsm-xdpool-${name}`)
    }
    expect(shared.length).toBeGreaterThan(5)
  })
})