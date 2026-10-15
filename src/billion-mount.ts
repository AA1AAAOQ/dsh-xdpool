/**
 * Mounting the compressor the billion-context card reads.
 *
 * WHY THE POOL MOUNTS A PLUGIN THAT IS NOT ITS OWN
 *
 * The billion card reports what a live compressor is doing, and a read-only
 * relay of a listener nobody started is a page of zeroes. This module makes the
 * listener exist, which means bringing up a second plugin from inside the first.
 *
 * THAT IS NOT FREE, AND THE HAZARD IS NAMED
 *
 * billion-context provides a cordis service under its own name and spawns a
 * loopback proxy. The host refuses a second registration of the same service in
 * one isolation scope:
 *
 *   service "billion" has been registered at <our-fiber>
 *
 * thrown synchronously inside the second copy's `apply`. It is not a rejected
 * promise a caller can ignore and not something the first copy notices: the
 * second fiber dies and takes whatever it had already registered with it. This
 * plugin hit precisely this once already, on the shared sign-in channel pack
 * (`isDuplicateMountError` in `channels.ts`), where a byte-identical copy was
 * mounted by two different plugins and the second one reported a failure the
 * user could do nothing about.
 *
 * So the rule here is not "mount it and hope". It is: ask the loader what is
 * already mounted, and mount only what is not. That check is the whole point of
 * this file.
 *
 * WHY THE ROW IN cordis.patch.yml IS NOT ENOUGH
 *
 * Our patch layer inserts a row so the host mounts it during boot. That covers a
 * normal start. It does not cover the case this function exists for: a profile
 * where another plugin, or the user, already mounted billion-context, or one
 * where our layer was disabled while ours is still installed. In those cases the
 * row is absent or inert and nothing would ever bring the listener up — so the
 * card would sit on `missing` forever with no indication why.
 *
 * @module dsh-xdpool/billion-mount
 */
import type { Context } from '@deepseek-ai/cordis'

/** The package name the loader resolves, exactly as our patch row names it. */
const BILLION_PACKAGE = 'billion-context'

/**
 * A loader entry, reduced to the two facts this module needs.
 *
 * Deliberately structural rather than typed against the host's loader: the
 * loader is an injectable service we do not depend on, and reading two fields
 * off it is the whole contract. Anything else about an entry is the host's
 * business.
 */
interface LoaderEntryLike {
  options?: { name?: unknown } | undefined
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
 * Is this package already running?
 *
 * `fiber.uid` is the host's "this fiber has actually started" flag: an entry
 * that exists but never finished importing is not a second mount, it is a
 * mount in progress, and treating it as absent would race it.
 */
function mountedInLoader(loader: LoaderLike, packageName: string): boolean {
  for (const entry of loader.entries()) {
    if (entry.options?.name !== packageName) continue
    if (entry.fiber?.uid !== undefined && entry.fiber.uid !== null) return true
  }
  return false
}

/**
 * Bring billion-context up if it is not already running.
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
    // `loader` is optional on purpose. A host without it cannot mount plugins at
    // runtime, and saying so is more useful than a TypeError inside a fiber the
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
      // The common case once someone has already installed it. Nothing to do,
      // and — this is the point — nothing that could collide.
      logger.info?.(`[xdpool] billion-context is already mounted; leaving it alone`)
      return { state: 'already-mounted' }
    }
    // The row our patch layer inserts. Creating it here as well is what covers a
    // profile where that layer is absent: `create` is idempotent per id, and the
    // duplicate check above already established that nothing is running.
    await (loader as unknown as {
      create(options: { id: string; name: string }): Promise<string>
    }).create({ id: 'billion-context-xdpool', name: BILLION_PACKAGE })
    logger.info?.(`[xdpool] mounted billion-context for the billion card`)
    return { state: 'mounted' }
  } catch (error) {
    // Recorded, not thrown. The card will report the compressor as missing, which
    // is the truth, and the pool keeps serving models regardless.
    return {
      state: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}