/**
 * The preferred-account pin.
 *
 * A pin is a promise with exactly one clause: "try this one first", never "only
 * this one". Everything below exists to keep that clause true. A pin that could
 * strand a request — by outliving its account, by overriding a strategy the user
 * never touched, or by being visible in the UI while doing nothing — would be
 * worse than no pin at all, so each case is pinned deliberately.
 *
 * The file-backed half (`src/preferred.ts`) is tested here too: it is written by
 * two processes (the host and the CLI) and read at startup, so a truncated or
 * hand-mangled document has to degrade to "nothing is pinned" rather than to a
 * throw inside `apply()`.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { poolWebStatus } from '../src/web-status.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import {
  PREFERRED_FILE_NAME,
  preferredIdPath,
  readPreferredId,
  readPreferredIdSync,
  writePreferredId,
} from '../src/preferred.ts'
import { pluginDataDir } from '../src/ignored.ts'

/** Write a fake auth directory holding `count` distinct CN accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-prefer-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A pool over `count` fake accounts, already scanned. */
async function pool(count: number): Promise<WorkBuddyAccountPool> {
  const instance = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(count)], logger: { warn() {} } })
  await instance.scan()
  return instance
}

describe('the pool honours a pin without depending on it', () => {
  it('serves the pinned account first, however the strategy would have drawn', async () => {
    const instance = await pool(3)
    const target = instance.list()[2]!
    instance.prefer(target.id)
    for (let i = 0; i < 4; i += 1) expect((await instance.acquire())!.id).toBe(target.id)
  })

  it('falls back to the strategy when the pinned account is cooling', async () => {
    const instance = await pool(3)
    const target = instance.list()[2]!
    instance.prefer(target.id)
    instance.penalize(target.id)
    // The promise is "first", not "only": the pool must still serve somebody.
    const served = await instance.acquire()
    expect(served).toBeDefined()
    expect(served!.id).not.toBe(target.id)
  })

  it('ignores a pin naming an account the pool has never seen', async () => {
    const instance = await pool(2)
    instance.prefer('uid-that-was-never-scanned')
    expect(await instance.acquire()).toBeDefined()
    // And it does not become a reported preference the card would draw.
    expect(instance.preferredId()).toBe('uid-that-was-never-scanned')
  })

  it('keeps the pin across a rescan, because the user chose an account, not a scan', async () => {
    const instance = await pool(2)
    const target = instance.list()[0]!
    instance.prefer(target.id)
    await instance.scan()
    expect(instance.preferredId()).toBe(target.id)
    expect((await instance.acquire())!.id).toBe(target.id)
  })

  it('reports the pin, and reports no pin once cleared', async () => {
    const instance = await pool(1)
    expect(instance.preferredId()).toBeUndefined()
    instance.prefer('acct-1')
    expect(instance.preferredId()).toBe('acct-1')
    instance.prefer(undefined)
    expect(instance.preferredId()).toBeUndefined()
  })
})

describe('the status document reports the pin honestly', () => {
  /** The card's document for `region`, over a pool with `count` CN accounts. */
  async function document(instance: WorkBuddyAccountPool, region: 'cn' | 'global' = 'cn') {
    return await poolWebStatus({
      pool: instance,
      catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
      client: new WorkBuddyUpstreamClient(),
    }, region)
  }

  it('marks the pinned row and names the pin at document level', async () => {
    const instance = await pool(2)
    const target = instance.list()[0]!
    instance.prefer(target.id)
    const status = await document(instance)
    expect(status.preferredAccountId).toBe(target.id)
    // Exactly one row may claim the mark: two would mean the card is drawing a
    // global choice as a per-row property it got wrong somewhere.
    expect(status.accounts.filter(account => account.preferred).map(account => account.id)).toEqual([target.id])
  })

  it('marks no row when nothing is pinned', async () => {
    const instance = await pool(2)
    const status = await document(instance)
    expect(status.preferredAccountId).toBeUndefined()
    expect(status.accounts.some(account => account.preferred)).toBe(false)
  })

  it('omits the pin rather than naming an account the card cannot show', async () => {
    const instance = await pool(1)
    instance.prefer('uid-signed-out-since')
    // The global tab lists the other gateway's accounts, which never include a CN
    // id. Reporting the pin there would offer "stop preferring this" for a row
    // that does not exist.
    const global = await document(instance, 'global')
    expect(global.preferredAccountId).toBeUndefined()
  })
})

describe('the preferred-account file', () => {
  it('round-trips an id through write and both reads', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'wbp-preferfile-')), 'nested', PREFERRED_FILE_NAME)
    await writePreferredId('acct-7', path)
    expect(await readPreferredId(path)).toBe('acct-7')
    // The synchronous read is the startup path, so it must agree with the async
    // one rather than being a second, subtly different parser.
    expect(readPreferredIdSync(path)).toBe('acct-7')
  })

  it('clears by deleting, so "no pin" has exactly one on-disk shape', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'wbp-preferfile-')), PREFERRED_FILE_NAME)
    await writePreferredId('acct-7', path)
    await writePreferredId(undefined, path)
    expect(existsSync(path)).toBe(false)
    expect(await readPreferredId(path)).toBeUndefined()
    expect(readPreferredIdSync(path)).toBeUndefined()
    // Clearing something that was never set must not fail — the card's button is
    // reachable whether or not a pin exists.
    await expect(writePreferredId(undefined, path)).resolves.toBeUndefined()
  })

  it('reads no pin from every malformed document rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-preferfile-'))
    const cases: readonly string[] = [
      '', 'not json at all', '[]', 'null', '"a bare string"',
      '{"accountId":null}', '{"accountId":7}', '{"accountId":""}', '{"accountId":"   "}',
      '{"accountId":"acct-7"}', '  {"accountId":"  acct-9  "}  ',
    ]
    for (const [index, body] of cases.entries()) {
      const path = join(dir, `case-${index}.json`)
      await writeFile(path, body, 'utf8')
      const expected = index === 9 ? 'acct-7' : index === 10 ? 'acct-9' : undefined
      expect(await readPreferredId(path), `async read of ${body}`).toBe(expected)
      expect(readPreferredIdSync(path), `sync read of ${body}`).toBe(expected)
    }
  })

  it('leaves no temp file behind, so a crash mid-write cannot be mistaken for a pin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-preferfile-'))
    const path = join(dir, PREFERRED_FILE_NAME)
    await writePreferredId('acct-1', path)
    await writePreferredId('acct-2', path)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).sort()).toEqual([PREFERRED_FILE_NAME])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, accountId: 'acct-2' })
  })

  it('defaults to the plugin data directory, so both processes agree on one file', () => {
    const env = { DSH_HOME: 'D:/xdpool-prefer-home' } as NodeJS.ProcessEnv
    expect(preferredIdPath(env)).toBe(join(pluginDataDir(env), PREFERRED_FILE_NAME))
    // Honoured explicitly rather than read from process.env at module scope, so
    // two hosts in one test process do not share a path by accident.
    expect(preferredIdPath(env)).not.toBe(preferredIdPath({ DSH_HOME: 'D:/other' } as NodeJS.ProcessEnv))
  })
})