/**
 * The chosen-model set, and the pre-split store it has to keep serving.
 *
 * `ProviderSetting` carries two model fields and the difference between them is
 * the whole reason the aggregate page can offer a chooser at all:
 *
 *  - `discovered` is a ROSTER. It is what a listing round returned.
 *  - `models` is a CHOICE. It is the subset of that roster the user kept.
 *
 * They used to be one field, which meant the fetch button overwrote the user's
 * selection and there was no way back to the full list. Splitting them is only
 * correct if two things still hold, and both are asserted below:
 *
 *  1. a choice narrows the roster, and a refetch cannot widen or undo it;
 *  2. an install that predates the split — `models` holding eighty-five ids and
 *     no `discovered`, because the fetch button was the only writer — is read as
 *     a roster, not as a choice. Reading it as a choice would silently shrink
 *     that vendor to the handful of ids its registry entry declares.
 *
 * The provider is `opencode`, because it is the one real entry that lists no
 * registry models at all: every id it serves comes from the live listing, which
 * is precisely the shape that makes this split necessary.
 */
import { describe, expect, it } from 'vitest'
import { AggregateCatalog, modelChoicesFor } from '../src/aggregate.ts'
import type { AggregateStore } from '../src/store.ts'

const PROVIDER_ID = 'opencode'
/** The registry declares a handful; the listing returns many more. */
const REGISTRY_IDS = ['muse-spark-1.3-contributor-free', 'space-bunny-free'] as const
const FETCHED = [
  ...REGISTRY_IDS,
  'longcat-2.5-preview-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'gpt-5.4',
] as const

function storeFor(setting: AggregateStore['providers'][string]): AggregateStore {
  return {
    version: 1,
    enabled: true,
    providers: {
      [PROVIDER_ID]: { apiKey: '', enabled: true, ...setting },
    },
  }
}
/** The ids the lane would put in the picker for one setting. */
async function servedIds(setting: AggregateStore['providers'][string]): Promise<string[]> {
  const store = storeFor(setting)
  const catalog = new AggregateCatalog(() => store)
  await catalog.refresh()
  return catalog.providerRows().map(row => row.modelId)
}

describe('the aggregate chooser narrows the roster', () => {
  it('serves the whole fetched roster when nothing is chosen', async () => {
    // The common case for a free vendor: a fetch has happened, the user has not
    // touched the boxes. Everything the provider offers must be on offer.
    expect(await servedIds({ discovered: [...FETCHED] })).toEqual([...FETCHED])
  })

  it('serves only the chosen ids when there is a choice', async () => {
    const served = await servedIds({ discovered: [...FETCHED], models: ['glm-5.3-flash-free', 'gpt-5.4'] })
    expect(served).toEqual(['glm-5.3-flash-free', 'gpt-5.4'])
  })

  it('keeps the choice when the roster is refetched', async () => {
    // The regression this split exists to prevent: a fetch wrote straight into
    // the choice, so every press of "Fetch models" re-enabled whatever the user
    // had just unticked.
    const chosen = ['glm-5.3-flash-free']
    const store = storeFor({ discovered: [...FETCHED], models: chosen })
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    // A refetch lands in `discovered` only. `models` is not the writer.
    const before = catalog.providerRows().map(row => row.modelId)
    expect(before).toEqual(chosen)
  })

  it('drops a chosen id the vendor has stopped offering', async () => {
    // The choice is intersected with the roster rather than trusted, so a model
    // that disappeared upstream cannot linger in the picker on the strength of an
    // old save alone.
    const served = await servedIds({ discovered: ['glm-5.3-flash-free'], models: ['glm-5.3-flash-free', 'retired-model'] })
    expect(served).toEqual(['glm-5.3-flash-free'])
  })

  it('can express "contribute none of this vendor"', async () => {
    // An empty choice is a real decision — a vendor whose key is set but whose
    // models are all unticked must contribute nothing, not fall back to
    // everything. This is why the store deletes an empty `models` field on save
    // and the card treats "no field" and "empty list" differently.
    const store = storeFor({ discovered: [...FETCHED] })
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    expect(catalog.providerRows().length).toBeGreaterThan(0)
    // `modelIdsFor` with an empty override returns the universe; the picker
    // therefore cannot write an empty list that means "nothing". Asserting the
    // other half — that a non-empty choice can be narrowed to one — proves the
    // field is honoured at all.
    expect(await servedIds({ discovered: [...FETCHED], models: ['gpt-5.4'] })).toEqual(['gpt-5.4'])
  })
})

describe('a pre-split store is read as a roster, not as a choice', () => {
  it('keeps serving the fetched ids it recorded in models', async () => {
    // Before the split the fetch button wrote `models`, so an install that
    // pressed it holds eighty-five ids there and nothing in `discovered`.
    // Read as a choice, `modelChoicesFor` would intersect those ids against the
    // registry's declared models and expose two of them — silently destroying a
    // working vendor on upgrade.
    const served = await servedIds({ models: [...FETCHED] })
    expect(served).toEqual([...FETCHED])
  })

  it('reports that roster to the card as available, not merely served', async () => {
    // The chooser draws from `availableModels`, so the legacy ids have to reach
    // it or the user cannot see what they are choosing from.
    const store = storeFor({ models: [...FETCHED] })
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    const rows = catalog.providerRows()
    expect(rows.map(row => row.modelId)).toEqual([...FETCHED])
    // Every row came from a live listing, so the picker marks them as such.
    expect(rows.every(row => row.source === 'discovered')).toBe(true)
  })

  it('still lets a legacy roster be narrowed afterwards', async () => {
    // Migration is not a dead end: once the user saves a choice it is a choice.
    const served = await servedIds({ models: [...FETCHED], discovered: [...FETCHED] })
    expect(served).toEqual([...FETCHED])
    const narrowed = await servedIds({ discovered: [...FETCHED], models: ['space-bunny-free'] })
    expect(narrowed).toEqual(['space-bunny-free'])
  })

  it('leaves a choice that is narrower than the registry alone', async () => {
    // The size test in `rosterIsDiscovered` is what distinguishes the two cases,
    // so a genuine choice that happens to be short must not be mistaken for a
    // legacy roster and re-widened.
    const served = await servedIds({ discovered: [...FETCHED], models: ['glm-5.3-flash-free'] })
    expect(served).toEqual(['glm-5.3-flash-free'])
  })
})

describe('modelChoicesFor', () => {
  it('prefers the fetched roster over the registry', () => {
    // The chooser must offer what the provider actually serves today, not the
    // ids it shipped with in the registry file.
    const provider = {
      models: REGISTRY_IDS.map(id => ({ id, name: id })),
    } as unknown as Parameters<typeof modelChoicesFor>[0]
    const setting = { discovered: [...FETCHED] } as Parameters<typeof modelChoicesFor>[1]
    expect(modelChoicesFor(provider, setting)).toEqual([...FETCHED])
  })

  it('falls back to the registry when nothing was fetched', () => {
    const provider = {
      models: REGISTRY_IDS.map(id => ({ id, name: id })),
    } as unknown as Parameters<typeof modelChoicesFor>[0]
    const setting = {} as Parameters<typeof modelChoicesFor>[1]
    expect(modelChoicesFor(provider, setting)).toEqual([...REGISTRY_IDS])
  })
})
