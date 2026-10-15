/**
 * The registry's model-listing URL (regression).
 *
 * This is the test for the bug that made "拉取模型" fail on every provider that
 * declares a listing, with a message that pointed at the wrong thing:
 *
 *   连接失败: the listing answered HTTP 200 but its shape was not recognised
 *
 * The registry spells `modelsUrl` as a FULL URL, not as a path under `baseUrl`:
 *
 *   "baseUrl":   "https://opencode.ai/zen/v1"
 *   "modelsUrl": "https://opencode.ai/zen/v1/models"
 *
 * `modelsEndpoint` concatenated the two anyway, producing
 * `https://opencode.ai/zen/v1https://opencode.ai/zen/v1/models`. That is not a
 * URL at all, and the failure it caused was one of the most misleading this
 * plugin can produce. opencode.ai answers the doubled path from its catch-all
 * route with HTTP 200 and an HTML page. So the caller saw a SUCCESSFUL response
 * whose body would not parse, and reported the shape as unrecognised — a
 * complaint about the provider's JSON, when the request never reached a listing
 * endpoint at all.
 *
 * Thirty correct registry entries hid the bug for as long as they did: every
 * one of them declares an absolute `modelsUrl`, so all thirty produced a doubled
 * URL, and none of the tests asserted what `modelsEndpoint` returns. The lesson
 * recorded in the module is that a URL assembled from a guess reads exactly like
 * a broken upstream, so the shape has to be pinned by a test.
 */
import { describe, expect, it } from 'vitest'
import { getProvider, modelsEndpoint } from '../src/providers.ts'
import type { ProviderRecord } from '../src/providers.ts'
import registry from '../src/providers-registry.json' with { type: 'json' }
/** A provider record built only from the fields this module reads. */
function record(fields: { baseUrl?: string; modelsUrl?: string }): ProviderRecord {
  return fields as unknown as ProviderRecord
}
describe('modelsEndpoint', () => {
  /**
   * The exact failure. Before the fix this returned the doubled URL, and the
   * listing fetch answered HTTP 200 with HTML.
   */
  it('uses an ABSOLUTE modelsUrl as written, never prefixed by the base', () => {
    expect(
      modelsEndpoint(record({ baseUrl: 'https://opencode.ai/zen/v1', modelsUrl: 'https://opencode.ai/zen/v1/models' })),
    ).toBe('https://opencode.ai/zen/v1/models')
  })
  it('still resolves a RELATIVE modelsUrl against the base', () => {
    // A registry that spells the listing as a path under its own base keeps
    // working: the fix is "absolute first", not "absolute only".
    expect(modelsEndpoint(record({ baseUrl: 'https://api.example.com/v1', modelsUrl: '/models' }))).toBe(
      'https://api.example.com/v1/models',
    )
    expect(modelsEndpoint(record({ baseUrl: 'https://api.example.com/v1/', modelsUrl: 'models' }))).toBe(
      'https://api.example.com/v1/models',
    )
  })
  it('does not mistake a path that starts with a version segment for a URL', () => {
    // `/v1/models` begins with a slash, which is how it stays a path. The
    // scheme test is anchored, so it cannot swallow this.
    expect(modelsEndpoint(record({ baseUrl: 'https://api.example.com', modelsUrl: '/v1/models' }))).toBe(
      'https://api.example.com/v1/models',
    )
  })
  it('reports no listing when there is none, or when a relative one has no base', () => {
    expect(modelsEndpoint(record({ baseUrl: 'https://api.example.com/v1' }))).toBeNull()
    expect(modelsEndpoint(record({ baseUrl: 'https://api.example.com/v1', modelsUrl: '   ' }))).toBeNull()
    // A relative path with no base to resolve it against is unusable, not
    // something to invent a host for.
    expect(modelsEndpoint(record({ baseUrl: '', modelsUrl: '/models' }))).toBeNull()
  })
  it('trims the trailing slashes of a base before joining a relative path', () => {
    expect(modelsEndpoint(record({ baseUrl: '  https://api.example.com/v1///  ', modelsUrl: '/models' }))).toBe(
      'https://api.example.com/v1/models',
    )
  })
  /**
   * The whole roster, checked as data.
   *
   * Every entry that declares a listing must produce a URL with exactly one
   * scheme. This is the guard that would have caught the bug on day one: it
   * does not care which providers exist, only that no URL was assembled twice.
   */
  it('never doubles a scheme across ANY registry entry', () => {
    const doubled: string[] = []
    for (const provider of registry as readonly ProviderRecord[]) {
      const endpoint = modelsEndpoint(provider)
      if (endpoint === null) continue
      if ((endpoint.match(/:[/][/]/gu) ?? []).length > 1) doubled.push(`${provider.id} -> ${endpoint}`)
    }
    expect(doubled).toEqual([])
  })
  it('produces the listing the registry names, for the keyless free provider', () => {
    // The provider the user actually reported. Read through the real lookup, so
    // a registry edit that drops the entry fails here instead of silently
    // leaving the button permanently broken.
    const opencode = getProvider('opencode')
    expect(opencode).not.toBeNull()
    expect(modelsEndpoint(opencode!)).toBe('https://opencode.ai/zen/v1/models')
  })
})