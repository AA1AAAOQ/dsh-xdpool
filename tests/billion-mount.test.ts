/**
 * What the billion-context card knows about the compressor, and what we no
 * longer do about it.
 *
 * This file used to assert the opposite contract: that `mountBillionContext`
 * would create a missing mount through the host loader. Every test here that
 * expected a `create()` call was pinning the behaviour that put a permanently
 * `failed` entry into the plugin list of every user who had installed
 * billion-context themselves — the host does not disable a duplicate row for
 * the same module name, it runs its fiber to failure. Those assertions are now
 * inverted: the strongest statement this file can make is that NO `create()`
 * call happens, on ANY input.
 *
 * The fake loader deliberately still implements `create`, and every test asserts
 * it was never reached. If the mounting behaviour ever comes back, the failure
 * is not "a test expectation changed" — it is "the loader was asked to register
 * a second billion-context", which is the exact bug.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mountBillionContext } from '../src/billion-mount.ts'

type FakeEntry = {
  options?: { name?: unknown; id?: unknown } | undefined
  fiber?: { uid?: unknown } | undefined
}

/**
 * A stand-in for the host loader, with a `create` that records being called.
 *
 * `create` is implemented so a regression cannot pass silently: if the module
 * ever calls it, `created` gains an entry and the assertion below fails with the
 * options that were about to become a duplicate mount.
 */
function fakeLoader(entries: FakeEntry[]) {
  const created: { id?: string; name?: string }[] = []
  return {
    created,
    loader: {
      entries: () => entries,
      create: async (options: { id: string; name: string }) => {
        created.push(options)
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

describe('the compressor is detected, never mounted', () => {
  it('a profile with nothing installed reports not-required and creates nothing', async () => {
    const { loader, created } = fakeLoader([])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'not-required' })
    expect(created).toEqual([])
  })

  it('a running billion-context is reported as already-mounted, untouched', async () => {
    const { loader, created } = fakeLoader([
      { options: { name: 'billion-context' }, fiber: { uid: 12 } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'already-mounted' })
    expect(created).toEqual([])
  })

  it('an entry still importing is NOT treated as absent — that was the race', async () => {
    // An entry with no uid is an import in flight. Treating it as absent is what
    // made a second mount look safe: the loader would reuse the row rather than
    // duplicate it, and the duplicate service registration then killed the
    // second fiber. Now nothing is mounted, so the distinction only decides
    // which label the card shows — but the check stays, because reporting
    // "not installed" while billion-context is mid-import would be a lie.
    const { loader, created } = fakeLoader([
      { options: { name: 'billion-context' }, fiber: {} },
      { options: { name: 'billion-context' }, fiber: { uid: undefined } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'already-mounted' })
    expect(created).toEqual([])
  })

  it('our own disabled patch row does not read as a running mount', async () => {
    // The row carries the id and the name but is `disabled: true`, and the host
    // still yields disabled rows from entries() — it skips starting them, it
    // does not drop them. Counting it would make every profile that never
    // installed billion-context read as installed.
    const { loader, created } = fakeLoader([
      {
        options: { id: 'billion-context-xdpool', name: 'billion-context', disabled: true },
        fiber: {},
      },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'not-required' })
    expect(created).toEqual([])
  })

  it('other plugins running are irrelevant', async () => {
    const { loader, created } = fakeLoader([
      { options: { name: 'dsh-xdpool' }, fiber: { uid: 3 } },
      { options: { name: 'dsh-our-free-model' }, fiber: { uid: 4 } },
    ])
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result).toEqual({ state: 'not-required' })
    expect(created).toEqual([])
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
      entries: () => {
        throw new Error('service "billion" has been registered at <billion-context>')
      },
    }
    const result = await mountBillionContext(ctxWith(loader), logger)
    expect(result.state).toBe('unavailable')
    expect((result as { reason: string }).reason).toContain('has been registered at')
  })

  it('never reaches create() on ANY input — the regression this file exists to catch', async () => {
    // A mix of every loader state the host can present. One assertion, applied
    // to all of them: the loader is read, never written.
    const cases: FakeEntry[][] = [
      [],
      [{ options: { name: 'billion-context' }, fiber: { uid: 1 } }],
      [{ options: { name: 'billion-context' }, fiber: {} }],
      [{ options: { id: 'billion-context-xdpool', name: 'billion-context', disabled: true }, fiber: {} }],
      [{ options: { name: 'billion-context' } }, { options: { name: 'other' }, fiber: { uid: 2 } }],
    ]
    for (const entries of cases) {
      const { loader, created } = fakeLoader(entries)
      await mountBillionContext(ctxWith(loader), logger)
      expect(created, `create() was called for entries: ${JSON.stringify(entries)}`).toEqual([])
    }
  })

  it('logs the already-mounted outcome when the host offers an info sink', async () => {
    const info = vi.fn()
    const { loader } = fakeLoader([
      { options: { name: 'billion-context' }, fiber: { uid: 9 } },
    ])
    await mountBillionContext(ctxWith(loader), { warn: () => {}, info })
    expect(info).toHaveBeenCalledTimes(1)
  })
})

describe('the manifest and patch layer say what they do', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  it('carries billion-context as an OPTIONAL dependency', () => {
    // Moving it out of `dependencies` is the other half of not mounting it: a
    // hard dependency would still install the compressor for every pool user
    // and drag its version along on every pool upgrade — the exact coupling the
    // patch comment always promised to avoid.
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.optionalDependencies['billion-context']).toBeTypeOf('string')
  })

  it('the patch row exists but is disabled', () => {
    expect(patch).toContain('- id: billion-context-xdpool')
    expect(patch).toContain('disabled: true')
  })

  it('the patch no longer mounts billion-context', () => {
    // The old assertion checked that our row was an `insert`. It is now a
    // disable, and that is the point: this layer must not be able to bring the
    // module up even by accident. Read the way the loader does — non-comment
    // lines only, and per-line rather than across the document, because the
    // comment above the row explains the history and names the module.
    const dataRows = patch
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(dataRows).not.toContain('name: billion-context')
    expect(dataRows).not.toContain('  name: billion-context')
    // Our row is a bare disable: no name, so the loader has nothing to start.
    const ourRow = dataRows.findIndex((line) => line.trim() === '- id: billion-context-xdpool')
    expect(ourRow).toBeGreaterThan(-1)
    const following = dataRows[ourRow + 1] ?? ''
    expect(following.trim()).toBe('disabled: true')
  })

  it('parses as the top-level array the host loader requires', () => {
    // The boot file is not ours to reformat: the host reads it with
    // `if (!Array.isArray(parsed)) throw`, so a stray top-level key here is a
    // boot failure for every user, not a test failure for us.
    const dataRows = patch
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(dataRows.length).toBeGreaterThan(0)
    const topLevel = dataRows.filter((line) => !/^\s/u.test(line))
    expect(topLevel).toHaveLength(2)
    for (const line of topLevel) {
      expect(line).toMatch(/^- (insert|id):/u)
    }
    // The first row is our own plugin's insert; the second is the disabled
    // billion marker. Neither may be a mapping key, which would turn the whole
    // document into a mapping and fail the loader's array check.
    expect(topLevel[0]).toBe('- insert:')
    expect(topLevel[1]).toBe('- id: billion-context-xdpool')
    const ids = dataRows
      .filter((line) => line.trim().startsWith('- id:'))
      .map((line) => line.trim().replace('- id:', '').trim())
    expect(ids).toEqual(['llm-xdpool', 'billion-context-xdpool'])
  })
})
