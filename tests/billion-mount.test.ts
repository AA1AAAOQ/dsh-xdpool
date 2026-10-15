import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mountBillionContext } from '../src/billion-mount.ts'

type FakeEntry = {
  options?: { name?: unknown } | undefined
  fiber?: { uid?: unknown } | undefined
}

/**
 * A stand-in for the host loader.
 *
 * Only the two members `mountBillionContext` touches are implemented, because
 * only those two are the contract: `entries()` to ask what is running, and
 * `create()` to bring up something that is not. If the function ever reaches for
 * a third member, the absence here is the failure this fake is meant to surface.
 *
 * `create` reproduces the host's two idempotence guarantees, because both are
 * load-bearing for the call site: it reuses an entry that already holds the id
 * rather than making a second one, and an entry that exists without a fiber is
 * started rather than duplicated.
 */
function fakeLoader(entries: FakeEntry[]) {
  const created: { id?: string; name?: string }[] = []
  const reused: string[] = []
  return {
    created,
    reused,
    loader: {
      entries: () => entries,
      create: async (options: { id: string; name: string }) => {
        created.push(options)
        const existing = entries.find(
          (entry) => entry.options?.name === options.name && entry.options?.id === options.id,
        )
        if (existing !== undefined) {
          reused.push(options.id)
          return options.id
        }
        entries.push({ options: { name: options.name, id: options.id }, fiber: { uid: 'new' } })
        return options.id
      },
    },
  }
}

const logger = { warn: () => {}, info: () => {} }

/** A ctx that provides `loader`, which is the only service this path needs. */
function ctxWith(loader: unknown): never {
  return {
    inject: (_services: string[], callback: (scoped: unknown) => void) => {
      callback({ loader })
      return () => {}
    },
  } as never
}

describe('the compressor is mounted only when nothing else already has it', () => {
  it('mounts billion-context on a profile where it is not running', async () => {
    const { loader, created } = fakeLoader([])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'mounted' })
    expect(created).toEqual([{ id: 'billion-context-xdpool', name: 'billion-context' }])
  })

  it('does not mount a second copy, which would throw inside its own apply', async () => {
    const { loader, created } = fakeLoader([
      { options: { name: 'billion-context' }, fiber: { uid: 12 } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'already-mounted' })
    expect(created).toEqual([])
  })

  it('mounts when a row exists but never finished starting', async () => {
    // An entry with no uid is an import in flight, not a second mount. Racing it
    // would produce exactly the duplicate we are here to prevent — so the call is
    // still made, and the host's own idempotence is what makes it safe.
    const { loader, created, reused } = fakeLoader([
      { options: { name: 'billion-context' }, fiber: {} },
      { options: { name: 'billion-context' }, fiber: { uid: undefined } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'mounted' })
    expect(created).toHaveLength(1)
    expect(reused).toEqual([])
  })

  it('asks the host to reuse our own row instead of adding a second one', async () => {
    // The row our patch layer inserts is already in the tree with this exact id.
    // The host resolves that by reusing the entry, which is why create() is safe
    // to call unconditionally rather than only when the row is absent.
    const { loader, reused } = fakeLoader([
      { options: { id: 'billion-context-xdpool', name: 'billion-context' }, fiber: {} },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'mounted' })
    expect(reused).toEqual(['billion-context-xdpool'])
  })

  it('ignores other plugins that happen to be running', async () => {
    const { loader, created } = fakeLoader([
      { options: { name: 'dsh-xdpool' }, fiber: { uid: 3 } },
      { options: { name: 'dsh-our-free-model' }, fiber: { uid: 4 } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'mounted' })
    expect(created).toHaveLength(1)
  })

  it('reports an unavailable loader rather than throwing', async () => {
    const result = await mountBillionContext(
      { inject: () => () => {} } as never,
      logger,
    )
    expect(result).toEqual({
      state: 'unavailable',
      reason: 'the host exposes no plugin loader',
    })
  })

  it('swallows a loader that refuses, because the pool must still boot', async () => {
    const loader = {
      entries: () => [],
      create: async () => {
        throw new Error('service "billion" has been registered at <billion-context>')
      },
    }
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result.state).toBe('unavailable')
    expect((result as { reason: string }).reason).toContain('has been registered at')
  })

  it('logs the outcome when the host offers an info sink', async () => {
    const info = vi.fn()
    const { loader } = fakeLoader([])
    await mountBillionContext(ctxWith(loader), { warn: () => {}, info })
    expect(info).toHaveBeenCalledTimes(1)
  })
})

describe('the manifest and patch layer say what they do', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  it('carries billion-context as an ordinary dependency so pnpm installs it', () => {
    // The loader resolves bundle packages out of the profile's node_modules,
    // which is exactly where a declared dependency lands.
    expect(manifest.dependencies['billion-context']).toBeTypeOf('string')
  })

  it('inserts a row rather than restating a config the host would replace whole', () => {
    expect(patch).toContain('- id: billion-context-xdpool')
    expect(patch).toContain('name: billion-context')
    // billion-context's own row is `bili-native`. Addressing it here would
    // replace its config wholesale — the patch engine does no deep merge — so our
    // row must carry a different id.
    expect(patch).not.toContain('id: bili-native')
    expect(patch).not.toMatch(/^- id: billion-context$/mu)
  })

  it('uses the same row id in the patch and at runtime', () => {
    const source = readFileSync(new URL('../src/billion-mount.ts', import.meta.url), 'utf8')
    expect(source).toContain("'billion-context-xdpool'")
    expect(patch).toContain('- id: billion-context-xdpool')
  })

  it('parses as the top-level array the host loader requires', () => {
    // The boot file is not ours to reformat: the host reads it with
    // `if (!Array.isArray(parsed)) throw`, so a stray top-level key here is a
    // boot failure for every user, not a test failure for us.
    const dataRows = patch
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(dataRows.length).toBeGreaterThan(0)
    // Top-level elements (column zero) must all be sequence items: `- insert:`
    // or `- id:`. A mapping key at column zero would turn the document into a
    // mapping, which the loader rejects outright.
    const topLevel = dataRows.filter((line) => !/^\s/u.test(line))
    expect(topLevel).toHaveLength(2)
    for (const line of topLevel) {
      expect(line).toMatch(/^- (insert|id):/u)
    }
    // Ours is the second element, and it is an insert — never a config
    // replacement. The patch engine assigns whole rows with no deep merge, so a
    // restated config would silently drop every option the host ships with.
    expect(topLevel[1]).toBe('- insert:')
    // Our row is the only id this layer owns; anything else at column zero would
    // be a second target we would be overwriting rather than adding.
    const ids = dataRows
      .filter((line) => line.trim().startsWith('- id:'))
      .map((line) => line.trim().replace('- id:', '').trim())
    expect(ids).toEqual(['llm-xdpool', 'billion-context-xdpool'])
  })
})