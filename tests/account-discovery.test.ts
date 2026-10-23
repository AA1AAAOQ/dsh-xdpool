/**
 * Regression tests for "accounts vanish when switching sign-in".
 *
 * The reported symptom: four domestic accounts signed in via WorkBuddy Switch,
 * the card showed four, and after restarting DSH only two remained.
 *
 * Root cause found here: `readCredential` rethrew
 * `WorkBuddyEncryptedCredentialError`, and `scan()` had no per-file guard — so
 * ONE file the plugin could not open (an encrypted credential whose at-rest key
 * was unavailable, because the desktop app was not running or could not be
 * located) propagated out and discarded every account that HAD parsed fine.
 * An auth directory routinely blends plain files, encrypted files and files from
 * a desktop version this plugin cannot read, so the mix is normal, not an error.
 *
 * The fix has two halves, and both are asserted:
 *   1. a bad file is SKIPPED, never fatal to the scan;
 *   2. the skip is REPORTED, so "2 accounts" can be distinguished from
 *      "4 files, 2 unreadable" — a count that silently disagrees with disk is
 *      what made this look like deleted accounts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool, workbuddyAccountId, type WorkBuddyCredential } from '../src/accounts.ts'

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

/**
 * A credential encrypted at rest, the shape 5.6.0+ writes.
 *
 * The envelope is deliberately invalid: the point is that the plugin cannot open
 * it, which is the situation that used to abort the whole scan.
 */
function encryptedCredential(name: string): string {
  return JSON.stringify({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'not-a-real-envelope' },
      refreshToken: { $wbEncrypted: 1, envelope: 'not-a-real-envelope' },
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
  })
}

function pool(dir: string): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({ authDirs: [dir], logger: { warn() {} } })
}

/** A directory with `good` readable accounts and `bad` unopenable ones. */
function mixedDir(good: number, bad: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-mixed-'))
  for (let i = 0; i < good; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.good${i}.info`), plainCredential(`good${i}`))
  }
  for (let i = 0; i < bad; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.bad${i}.info`), encryptedCredential(`bad${i}`))
  }
  return dir
}

/**
 * These cases touch the real at-rest key lookup, which — on a machine that HAS
 * the desktop app installed — can spend several seconds trying to reach it
 * before failing. That is the real behaviour under test (the file must be
 * skipped, not fatal), so the timeout is raised rather than stubbed out:
 * mocking the lookup would stop the test from covering the path that broke.
 *
 * The first case pays the cost; the rest are fast because the lookup result is
 * cached per process.
 */
const SLOW = 60_000

describe('one unopenable file must not empty the pool', () => {
  it('keeps every account that parsed fine', async () => {
    // 3 readable + 1 encrypted-and-unopenable: the scan must yield 3, not throw
    // and not return 0. This is the reported defect in miniature.
    const dir = mixedDir(3, 1)
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(3)
  }, SLOW)

  it('succeeds even when EVERY file is unopenable', async () => {
    // Degenerate case: no throw, an empty pool, and the skips reported.
    const dir = mixedDir(0, 2)
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(0)
    expect(p.skippedFilesInOrder()).toHaveLength(2)
  }, SLOW)

  it('reports the skipped files with the reason', async () => {
    const dir = mixedDir(2, 2)
    const p = pool(dir)
    await p.scan()
    const skipped = p.skippedFilesInOrder()
    expect(skipped).toHaveLength(2)
    // The reason matters: "encrypted" is actionable (start the desktop app),
    // whereas "malformed" means the file simply is not a credential. Reporting
    // them alike would send the user after a fix that cannot work.
    for (const entry of skipped) expect(entry.reason).toBe('encrypted')
  }, SLOW)

  it('does not mark an unopenable file as an account in any form', async () => {
    // Guards against a "fix" that counts skips as accounts to make the number
    // match the file count: a credential that cannot be read cannot serve.
    const dir = mixedDir(1, 1)
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.label).toContain('good0')
  }, SLOW)
})

describe('malformed files are handled the same way', () => {
  it('a file that is not valid JSON is skipped, not fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-badjson-'))
    writeFileSync(join(dir, 'workbuddy-desktop.ok.info'), plainCredential('ok'))
    writeFileSync(join(dir, 'workbuddy-desktop.broken.info'), '{ this is not json')
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(1)
    const skipped = p.skippedFilesInOrder()
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.reason).toBe('malformed')
  })

  it('valid JSON that is not a credential is skipped, not fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-wrongshape-'))
    writeFileSync(join(dir, 'workbuddy-desktop.ok.info'), plainCredential('ok'))
    writeFileSync(join(dir, 'not-a-credential.info'), JSON.stringify({ hello: 'world' }))
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(1)
  })
})

describe('the pool still works with only good files', () => {
  it('reports no skips', async () => {
    const dir = mixedDir(3, 0)
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(3)
    expect(p.skippedFilesInOrder()).toHaveLength(0)
  })
})

describe('scan sign-ins join the same pool', () => {
  /**
   * A credential the login channels produced. It has a `uid` and no `uin`,
   * which is the shape `packCredentialToWorkBuddy` produces — the desktop file
   * shape carries both, and `workbuddyAccountId` reads `uin` first.
   */
  function scanCredential(name: string, uin?: string): WorkBuddyCredential {
    return {
      accessToken: `scan-${name}`,
      refreshToken: '',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
      nickname: name,
      ...uin === undefined ? {} : { uin },
      ...uin === undefined ? { uid: `uid-${name}` } : {},
      sourcePath: `channel-pack:workbuddy:WORKBUDDY_ACCOUNT_${name}`,
    }
  }

  it('serves an account that only exists in the channel pack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-scanonly-'))
    const p = pool(dir)
    p.applyExternalSource(async () => [scanCredential('scanned')])
    const accounts = await p.scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.label).toContain('scanned')
  })

  it('counts one person who signed in both ways once', async () => {
    // The duplicate this bridge exists to remove: the same account as a desktop
    // file AND as a scan sign-in. Both carry the uin, so they key identically.
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-both-'))
    writeFileSync(join(dir, 'workbuddy-desktop.info'), plainCredential('both'))
    const p = pool(dir)
    p.applyExternalSource(async () => [scanCredential('both', 'uin-both')])
    const accounts = await p.scan()
    expect(accounts).toHaveLength(1)
  })

  it('honours the ignore list for scan sign-ins too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-ignored-scan-'))
    const p = pool(dir)
    p.applyExternalSource(async () => [scanCredential('blocked')])
    await p.scan()
    const id = workbuddyAccountId(scanCredential('blocked'))
    p.applyIgnored([id])
    // Re-registering with the same source and rescanning must keep it out: the
    // gate is in the scan, not only in the render path.
    const accounts = await p.scan()
    expect(accounts.filter(a => a.id === id)).toHaveLength(0)
  })

  it('keeps the desktop accounts when the channel source fails', async () => {
    // A channel pack that cannot answer is a missing pool, not a broken one.
    const dir = mixedDir(2, 0)
    const p = pool(dir)
    p.applyExternalSource(async () => { throw new Error('route not mounted') })
    const accounts = await p.scan()
    expect(accounts).toHaveLength(2)
  })

  it('still scans desktop-only when no source is registered', () => {
    const p = pool(mixedDir(1, 0))
    p.applyExternalSource(undefined)
    return expect(p.scan()).resolves.toHaveLength(1)
  })

  /**
   * The reported bug (2026-10-23): two accounts were rejected by the upstream,
   * the user re-signed in through the channel page, and the card kept saying the
   * sign-in was rejected.
   *
   * Root cause: `compareFreshness` ranked purely on `lastRefreshAtMs`, which a
   * scanned credential never has (the pack does not record one), so `?? 0` put a
   * brand-new sign-in BELOW an abandoned snapshot from three weeks earlier. The
   * pool kept serving the stale token, the upstream kept answering "sign-in
   * rejected", and the dead mark never cleared because `isFresher` said the
   * credential had not changed.
   */
  describe('a fresh sign-in outranks an abandoned snapshot', () => {
    /** A timestamped desktop file — a snapshot, not the live sign-in. */
    function snapshotFile(dir: string, name: string, issued: number): void {
      writeFileSync(
        join(dir, 'workbuddy-desktop.2026-10-08T08-54-41-646Z.3944.5745f846.info'),
        JSON.stringify({
          auth: {
            accessToken: `stale-${name}`,
            refreshToken: `refresh-${name}`,
            expiresAt: Date.now() + 86_400_000 * 9,
            lastRefreshTime: issued,
            domain: 'www.workbuddy.cn',
          },
          account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
        }),
      )
    }

    it('keeps the scanned credential, not the older snapshot', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wbpool-fresh-scan-'))
      // Issued 2026-10-08 and abandoned since; still nominally unexpired, which
      // is exactly why the old expiry-based rule kept it.
      snapshotFile(dir, 'same-person', 1_791_449_649_044)
      const p = pool(dir)
      p.applyExternalSource(async () => [scanCredential('same-person')])
      const accounts = await p.scan()

      expect(accounts).toHaveLength(1)
      expect(accounts[0]?.credential.accessToken).toBe('scan-same-person')
      expect(accounts[0]?.credential.sourcePath).toContain('channel-pack:')
    })

    it('still prefers the live file when the app is signed in', async () => {
      // The live file is the one credential a running app is demonstrably using,
      // so it stays ahead of a scan: flipping that order would break the case
      // the pool was built for (desktop rotations).
      const dir = mkdtempSync(join(tmpdir(), 'wbpool-live-wins-'))
      writeFileSync(join(dir, 'workbuddy-desktop.info'), plainCredential('live-person'))
      const p = pool(dir)
      p.applyExternalSource(async () => [scanCredential('live-person', 'uin-live-person')])
      const accounts = await p.scan()

      expect(accounts).toHaveLength(1)
      expect(accounts[0]?.credential.accessToken).toBe('token-live-person')
    })

    it('clears the rejected mark once a scan replaces the credential', async () => {
      // The end-to-end shape of the report: the pool had marked the account
      // dead, the user scanned again, and the mark has to go — otherwise the
      // card keeps saying "sign-in rejected" no matter how often they retry.
      const dir = mkdtempSync(join(tmpdir(), 'wbpool-revive-scan-'))
      snapshotFile(dir, 'revived', 1_791_449_649_044)
      const p = pool(dir)
      await p.scan()
      const id = workbuddyAccountId(scanCredential('revived', 'uin-revived'))
      p.penalizeCredentialDead(id, Date.now() + 3_600_000)
      expect(p.deadCredentials().length).toBe(1)

      // A different access token is what a real sign-in produces.
      p.applyExternalSource(async () => [scanCredential('revived', 'uin-revived')])
      await p.scan()

      expect(p.deadCredentials()).toHaveLength(0)
      expect(p.list('cn')[0]?.credential.accessToken).toBe('scan-revived')
    })
  })

  it('keeps two people who share a nickname apart', async () => {
    // 2026-10-23: two distinct accounts are both called 青楫渡. Identity is the
    // credential, never the display name — keying on the nickname is what made
    // the channel pack's dedupe delete the second person's sign-in.
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-same-name-'))
    const p = pool(dir)
    p.applyExternalSource(async () => [scanCredential('青楫渡', 'uin-a'), scanCredential('青楫渡', 'uin-b')])
    const accounts = await p.scan()
    expect(accounts).toHaveLength(2)
    expect(new Set(accounts.map(account => account.id)).size).toBe(2)
  })
})
