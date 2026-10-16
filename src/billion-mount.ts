/**
 * Detecting whether the compressor the billion-context card reads is running.
 *
 * WHY THIS MODULE EXISTS AT ALL
 *
 * The billion card reports what a live compressor is doing. Distinguishing
 * "not installed" from "installed but not answering" from "ready" is the whole
 * value of that page — the three states read as information, and collapsing
 * them into one would make a correct install look broken. This module is what
 * tells the card which world it is in.
 *
 * WHY IT NO LONGER MOUNTS ANYTHING (this used to, and it was wrong)
 *
 * 2.0.0 made this function mount billion-context when it was not already
 * running: our patch layer inserted a row, and a runtime `create()` here was a
 * second path for the same job. Both were aimed at a profile that had not
 * installed the compressor. Measured against the opposite profile — one that
 * HAD installed it, which is the normal state for anyone using that feature —
 * neither safeguard held:
 *
 *   billion-context registers a cordis service under its own name, and the host
 *   refuses a second registration outright (`service "…" has been registered at
 *   <…>`). Our duplicate row was left `enabled: true` with its fiber run to
 *   `failed`, so every such user got a permanently failed entry in their plugin
 *   list — visible, unexplained, pointing at us.
 *
 * It was the same class of failure this plugin had already hit once on the
 * shared sign-in channel pack (`isDuplicateMountError` in `channels.ts`), where
 * a byte-identical copy mounted by two plugins left the second one reporting a
 * failure the user could do nothing about. Knowing the failure mode from one
 * feature and shipping it again in another is exactly the mistake this file
 * exists to record.
 *
 * The row in `cordis.patch.yml` is now `disabled: true` and this function no
 * longer creates anything. Installing billion-context is the user's decision
 * and stays theirs; the card says "not installed" when it is not.
 *
 * WHY THE DUPLICATE CHECK REMAINS
 *
 * `mountedInLoader` still runs, and it is still the most useful line here: it
 * is what lets the card report "already installed" — the state a user who just
 * added billion-context and is waiting for its proxy to come up wants to see,
 * and the one that tells them no action is needed. Removing the mounting did
 * not remove the need to know.
 *
 * @module dsh-xdpool/billion-mount
 */
import type { Context } from '@deepseek-ai/cordis'

/** The package name the loader resolves, exactly as our patch row names it. */
const BILLION_PACKAGE = 'billion-context'

/**
 * A loader entry, reduced to the facts this module needs.
 *
 * Deliberately structural rather than typed against the host's loader: the
 * loader is an injectable service we do not depend on, and reading three fields
 * off it is the whole contract. Anything else about an entry is the host's
 * business.
 */
interface LoaderEntryLike {
  options?: { name?: unknown; disabled?: unknown } | undefined
  fiber?: { uid?: unknown } | undefined
}

/** The loader service, reduced to what a duplicate check needs. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/** What the caller gets back, so the card can explain an inert mount. */
export type MountedBillionContext =
  | { state: 'already-mounted' }
  | { state: 'mounted' }
  | { state: 'not-required' }
  | { state: 'unavailable'; reason: string }

/**
 * Is this package installed and able to run?
 *
 * Any entry whose name matches counts — including one whose fiber has not
 * started yet. When this function still decided whether to mount, a fiber-less
 * entry had to be treated as absent: treating an import-in-flight as present
 * would have skipped the mount and left the compressor never starting. Now that
 * nothing mounts, the distinction only picks a label, and the honest one is
 * "installed": a user watching billion-context's own boot does not want the
 * card telling them it is missing while its proxy is half-way up.
 *
 * A DISABLED entry does not count. `loader.entries()` yields disabled rows too
 * — the host skips starting them, it does not drop them — and our own patch
 * row is disabled on purpose. Counting it would make every profile that never
 * installed billion-context read as "installed", which is precisely the lie the
 * card must not tell.
 */
function mountedInLoader(loader: LoaderLike, packageName: string): boolean {
  for (const entry of loader.entries()) {
    if (entry.options?.name !== packageName) continue
    if (entry.options?.disabled === true) continue
    return true
  }
  return false
}

/**
 * Report whether the compressor is already running. Never mounts.
 *
 * Resolves rather than rejects on every path: a compressor that will not start
 * is a card that says so, never a pool that fails to boot. The pool's own model
 * registry has nothing to do with compression, and one missing optional feature
 * must not take the accounts down with it.
 */
export async function mountBillionContext(
  ctx: Context,
  logger: { info?: (message: string) => void; warn: (message: string) => void },
): Promise<MountedBillionContext> {
  try {
    // `loader` is optional on purpose. A host without it cannot report plugin
    // state, and saying so is more useful than a TypeError inside a fiber the
    // caller never awaited.
    let loader: LoaderLike | undefined
    ctx.inject(['loader'], (scoped) => {
      // The loader ships in a host package we deliberately do not depend on, so
      // its service is not in this module's type graph. `inject` still resolves
      // the gate at runtime; only the compile-time shape is missing, and reading
      // two fields through `unknown` is the honest way to say so.
      loader = (scoped as unknown as { loader: LoaderLike }).loader
    })
    if (loader === undefined) {
      return { state: 'unavailable', reason: 'the host exposes no plugin loader' }
    }
    if (mountedInLoader(loader, BILLION_PACKAGE)) {
      logger.info?.(`[xdpool] billion-context is already mounted; leaving it alone`)
      return { state: 'already-mounted' }
    }
    // Not running, and not ours to start: the row in our patch layer is
    // `disabled: true` (see that file for the measured failure that put it
    // there), so the card reports the compressor as absent and the user can
    // install it if they want it. Nothing here may reach for the loader's
    // `create()` — doing so would fight the disabled row beside it.
    return { state: 'not-required' }
  } catch (error) {
    // Recorded, not thrown. The card will report the compressor as missing, which
    // is the truth, and the pool keeps serving models regardless.
    return {
      state: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
