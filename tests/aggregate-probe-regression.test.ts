/**
 * The aggregate-catalog type probe (regression).
 *
 * This is the test for the bug that made xdpool's providers vanish from the
 * model picker on a fresh install. The startup log said, verbatim:
 *
 *   registration FAILED: TypeError: catalog.visible is not a function
 *
 * `isAggregateCatalog` used to answer "is this the aggregate flavour?" by
 * looking at the DATA — `catalog.current()[0]` and then checking whether that
 * row carried a `providerId` of its own. On a fresh install the aggregate store
 * is empty, `current()` returns `[]`, the probe said "not aggregate", and
 * `createWorkBuddyAdapter` went on to call `catalog.visible()` on an object that
 * does not have that method.
 *
 * The consequence was worse than a wrong branch. `buildModels()` runs while the
 * adapters are being CONSTRUCTED, before any `registerAdapter` call, so the
 * throw escaped to the outermost catch in `apply` and NONE of the three
 * providers registered. The card kept rendering, the settings kept working, and
 * the only symptom was an empty model picker with nothing on screen saying why.
 *
 * Every assertion here therefore pins the CAPABILITY probe, not the data shape:
 * the answer must not depend on what happens to be in the store at boot.
 */
import { describe, expect, it } from 'vitest'
import { AggregateCatalog, isAggregateCatalog } from '../src/aggregate.ts'
import type { AggregateCatalog as AggregateCatalogType, AggregateModelRow } from '../src/aggregate.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { AggregateStore } from '../src/store.ts'
/** An empty store: a fresh install has configured no third-party provider yet. */
const EMPTY_STORE: AggregateStore = { version: 1 }
/**
 * The probe must survive a store that yields nothing, which is the one state a
 * fresh install is actually in.
 *
 * The old data-shape probe returned `false` here, which is the entire bug.
 */
describe('isAggregateCatalog', () => {
  it('recognises an EMPTY aggregate catalog', async () => {
    const catalog = new AggregateCatalog(() => EMPTY_STORE)
    // Not refreshed either — even refreshed, an empty store yields no rows.
    await catalog.refresh()
    expect(catalog.current()).toHaveLength(0)
    expect(catalog.providerRows()).toHaveLength(0)
    expect(catalog.comboRows()).toHaveLength(0)
    // The assertion that used to fail: this was `false` before the fix, which
    // sent `createWorkBuddyAdapter` down the `catalog.visible()` branch.
    expect(isAggregateCatalog(catalog)).toBe(true)
  })
  it('recognises a POPULATED aggregate catalog', async () => {
    const store: AggregateStore = {
      version: 1,
      enabled: true,
      providers: {
        agnes: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1/v1', enabled: true },
      },
    }
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(isAggregateCatalog(catalog)).toBe(true)
  })
  it('still rejects a POOL catalog, in every selection state', () => {
    // A pool catalog is empty until the gateway answers; it must never be
    // mistaken for an aggregate one just because it has nothing in it yet.
    for (const catalog of [new WorkBuddyCatalog(), new WorkBuddyCatalog('global')]) {
      expect(isAggregateCatalog(catalog)).toBe(false)
    }
  })
  it('is decided by capability, not by what the store happens to hold', () => {
    // Pin the mechanism so the probe cannot drift back to a data check: an
    // object carrying the aggregate surface but an EMPTY roster must classify
    // the same as one with rows in it.
    const bare = {
      current: () => [] as readonly never[],
      providerRows: () => [] as readonly never[],
      comboRows: () => [] as readonly never[],
    } as unknown as AggregateCatalogType
    expect(isAggregateCatalog(bare)).toBe(true)
    // And a pool-shaped object stays rejected even with rows present.
    const poolShaped = {
      current: () => [{ providerId: 'agnes' }] as readonly never[],
      visible: () => [] as readonly never[],
    } as unknown as AggregateCatalogType
    expect(isAggregateCatalog(poolShaped)).toBe(false)
  })
})
/**
 * Importing `adapter.ts` pulls in the real pi-ai provider stack, which costs
 * several seconds to transform. The budget is the same one
 * `tests/account-discovery.test.ts` uses for its slow cases.
 */
const SLOW = 60_000
/**
 * The failure mode, end to end.
 *
 * `createWorkBuddyAdapter` needs a `Context` for the pi-ai attachment hooks.
 * A bare context object is enough here: the test never sends a request, it only
 * asks the adapter to BUILD its model list, which is where the throw used to
 * happen.
 */
describe('createWorkBuddyAdapter with an empty aggregate catalog', () => {
  it('builds a model list instead of throwing catalog.visible is not a function', async () => {
    const { createWorkBuddyAdapter } = await import('../src/adapter.ts')
    const catalog = new AggregateCatalog(() => EMPTY_STORE)
    await catalog.refresh()
    // A minimal shim: the adapter only calls baseUrl() and token().
    const shim = {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'loopback-secret',
      close: async () => {},
    }
    const ctx = {
      get: (key: string) => (key === 'attachments' ? undefined : undefined),
    } as unknown as Parameters<typeof createWorkBuddyAdapter>[0]['ctx']
    // Before the fix this line threw:
    //   TypeError: catalog.visible is not a function
    // and the caller escaped to its outermost catch, registering nothing.
    const adapter = createWorkBuddyAdapter({
      shim: shim as Parameters<typeof createWorkBuddyAdapter>[0]['shim'],
      catalog,
      ctx,
      providerId: 'xdpool-aggregate',
    })
    // An empty aggregate store advertises nothing, which is CORRECT: it is not
    // a crash, it is "no third-party provider configured". The card stays up and
    // the two pool lanes keep their models.
    expect(adapter.providerId).toBe('xdpool-aggregate')
    expect(() => adapter.buildModels()).not.toThrow()
    expect(adapter.buildModels()).toHaveLength(0)
  }, SLOW)
})
/** Kept so the import graph is pinned: the row type is what the probe rejected. */
export type { AggregateModelRow }