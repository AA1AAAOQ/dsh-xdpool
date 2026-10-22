/**
 * `sticky` is a promise the card makes in plain words: 一个对话只用一个账号.
 *
 * It used to end at the process boundary — the bindings lived in a Map, so every
 * `dsh web` restart re-picked and one session could be served by three accounts
 * in a day, paying full prompt cost each time. These tests pin the file-backed
 * behaviour.
 *
 * The tricky part is proving it: a fresh pool picks the SAME account for an
 * unbound conversation anyway (the new-conversation policy is deterministic), so
 * "two pools agree" passes even with loading disabled. Every assertion here
 * therefore binds a conversation to an account the default pick would NOT have
 * chosen — a full pass with the loader removed is impossible.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'

/** A plain-JSON credential, the shape older desktop builds write. */
function plainCredential(name: string): string {
  return JSON.stringify({
    auth: {
      accessToken: `token-${name}`,
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
  })
}

function authDir(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-affinity-'))
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.${i}.info`), plainCredential(`acc${i}`))
  }
  return dir
}

function affinityFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-affinity-file-')), 'sticky-affinity.json')
}

function pool(dir: string, affinityPath: string | undefined): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({
    authDirs: [dir],
    distribution: 'sticky',
    logger: { warn() {} },
    ...affinityPath === undefined ? {} : { affinityPath },
  })
}

/** Let the debounced write land. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 700) })

describe('sticky bindings survive a restart', () => {
  it('writes the account it picked for a conversation', async () => {
    const file = affinityFile()
    const subject = pool(authDir(3), file)
    await subject.scan()
    const picked = await subject.acquire(undefined, 'cn', 'conversation-a')
    expect(picked).toBeDefined()
    await settle()
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { bindings: Record<string, string> }
    expect(doc.bindings['conversation-a']).toBe(picked?.id)
  })

  it('honours a binding written by an earlier process', async () => {
    // Bound to the LAST account a fresh pool would pick, so passing here proves
    // the file was read rather than coincidence.
    const dir = authDir(3)
    const box = pool(dir, undefined)
    const ids = (await box.scan()).map(account => account.id)
    const wanted = ids[ids.length - 1]
    expect(ids[0]).not.toBe(wanted)

    const file = affinityFile()
    writeFileSync(file, JSON.stringify({ version: 1, bindings: { 'conversation-a': wanted } }))
    const restarted = pool(dir, file)
    await restarted.scan()
    expect((await restarted.acquire(undefined, 'cn', 'conversation-a'))?.id).toBe(wanted)
  })

  it('keeps two conversations on their own accounts', async () => {
    const dir = authDir(3)
    const ids = (await pool(dir, undefined).scan()).map(account => account.id)
    const file = affinityFile()
    writeFileSync(file, JSON.stringify({ version: 1, bindings: { a: ids[0], b: ids[2] } }))
    const restarted = pool(dir, file)
    await restarted.scan()
    expect((await restarted.acquire(undefined, 'cn', 'a'))?.id).toBe(ids[0])
    expect((await restarted.acquire(undefined, 'cn', 'b'))?.id).toBe(ids[2])
  })

  it('re-picks when the bound account no longer exists', async () => {
    // A removed account must not leave a conversation pinned to nothing.
    const file = affinityFile()
    writeFileSync(file, JSON.stringify({ version: 1, bindings: { gone: 'no-such-account' } }))
    const subject = pool(authDir(2), file)
    await subject.scan()
    expect(await subject.acquire(undefined, 'cn', 'gone')).toBeDefined()
  })

  it('keeps working with no file at all (memory only)', async () => {
    const subject = pool(authDir(2), undefined)
    await subject.scan()
    const a = await subject.acquire(undefined, 'cn', 'conversation-a')
    expect((await subject.acquire(undefined, 'cn', 'conversation-a'))?.id).toBe(a?.id)
  })
})
