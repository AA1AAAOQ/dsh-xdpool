/**
 * Patch channel-pack: give CodeArts a STABLE upstream session id, and stop
 * treating a concurrency rejection as a thirty-minute queue ticket.
 *
 * ## The symptom
 *
 *   CodeArts tool calls hang for minutes. The pack logs "queue wait", and every
 *   turn of a tool loop waits again.
 *
 * ## The cause
 *
 * The upstream counts concurrent sessions per account through the
 * `x-ot-session-id` header (three per account). The pack's CodeArts adapter never
 * sends that header, so each request is counted as a new session; the fourth
 * request onward receives `HTTP 400 + TM.00001041`.
 *
 * The pack classifies `TM.00001041` as "queued", then polls
 * `/api/v1/queue/status` every ten seconds, up to 180 times — thirty minutes.
 * It is not a queue position; it is a cap that the caller created by presenting
 * a new session each time.
 *
 * CodeArts2API documents both halves (`docs/UPSTREAM.md` §6): derive
 * `ses_<sha256(domain_id|access_key_id) first 8 bytes>` once per credential and
 * reuse it, and treat the code as a short transient retry. This patch ports the
 * first half to the vendored pack and caps the second at roughly six seconds so
 * a genuinely busy gateway cannot park a turn for half an hour.
 *
 * ## Scope
 *
 * Only the CodeArts adapter is touched:
 *
 * - the `extraSignedHeaders` slot already exists and feeds `signRequestHuawei`,
 *   so the two session headers are signed exactly like every other identity
 *   header (unsigned headers would be a different, weaker contract);
 * - `QUEUE_RETRY_DELAY_MS` / `QUEUE_MAX_ATTEMPTS2` are the CodeArts-only
 *   constants (the qoder lane has its own `QUEUE_MAX_ATTEMPTS`).
 *
 * Idempotent. Re-run after a pack refresh; it fails loudly if the anchors move.
 *
 * Usage: node tools/patch-pack-codearts-session.mjs [path/to/pack.js]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PATH = process.argv[2] ?? join(ROOT, 'vendor', 'channel-pack', 'pack.js')
const MARKER = '[xdpool-local] stable CodeArts upstream session id'

const source = readFileSync(PATH, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const join2 = (...lines) => lines.join(EOL)

/**
 * 1. The stable session id.
 *
 * The generated bundle already carries an async `sha256Hex(Uint8Array)`, so the
 * hash can be computed inside the same async path that signs the request. Both
 * headers point at one value: the upstream counts `x-ot-session-id`, while
 * `user-session-id` is the human-visible twin the IDE sends.
 */
const OLD_SESSION = '      const extraSignedHeaders = void 0;'
const NEW_SESSION = join2(
  '      /**',
  `       * ${MARKER} — see tools/patch-pack-codearts-session.mjs.`,
  '       *',
  '       * The upstream counts concurrent sessions per account by',
  '       * x-ot-session-id (three per account). Omitting it made every request a',
  '       * new session, so the fourth one onward answered TM.00001041 and the',
  '       * queue loop below spent ten seconds per poll on a cap, not on a queue.',
  '       *',
  '       * Derived exactly as CodeArts2API derives it: one stable value per',
  '       * credential, changing only when the credential (domain or AK) does.',
  '       */',
  '      const __codeartsSessionKey = `${credential.domain_id ?? ""}|${credential.access_key_id}`;',
  '      const __codeartsSessionId = "ses_"',
  '        + (await sha256Hex(new TextEncoder().encode(__codeartsSessionKey))).slice(0, 16);',
  '      const extraSignedHeaders = {',
  '        "x-ot-session-id": __codeartsSessionId,',
  '        "user-session-id": __codeartsSessionId',
  '      };',
)

/**
 * 2. Cap the queue wait.
 *
 * Even with a stable session id a gateway can answer a genuine busy signal. Ten
 * seconds times 180 attempts is thirty minutes of silence; six attempts at one
 * second keeps the "wait a moment and retry" intent without turning a tool call
 * into an outage report.
 */
const OLD_DELAY = 'var QUEUE_RETRY_DELAY_MS = 1e4;'
const NEW_DELAY = join2(
  `// ${MARKER} — a concurrency cap is not a 10-second queue ticket.`,
  'var QUEUE_RETRY_DELAY_MS = 1e3;',
)
const OLD_ATTEMPTS = 'var QUEUE_MAX_ATTEMPTS2 = 180;'
const NEW_ATTEMPTS = join2(
  `// ${MARKER} — six attempts at 1s, not 180 attempts at 10s (30 minutes).`,
  'var QUEUE_MAX_ATTEMPTS2 = 6;',
)

for (const [name, anchor] of [
  ['session header', OLD_SESSION],
  ['queue delay', OLD_DELAY],
  ['queue attempts', OLD_ATTEMPTS],
]) {
  if (!source.includes(anchor)) throw new Error(`${name} anchor not found in ${PATH} — the pack changed shape`)
}

let next = source
  .replace(OLD_SESSION, NEW_SESSION)
  .replace(OLD_DELAY, NEW_DELAY)
  .replace(OLD_ATTEMPTS, NEW_ATTEMPTS)

if (!next.includes(MARKER)) throw new Error('marker did not land')
if (!next.includes('x-ot-session-id')) throw new Error('session header disappeared')
// The slot must still be the argument the signer receives; a patch that only
// added a header after signing would produce a 401 instead of a fast request.
// The call spans several lines and nested calls, so match the marker-relative
// neighbourhood rather than a single-line regex.
const callIndex = next.indexOf('await signRequestHuawei(', next.indexOf(MARKER))
const callWindow = callIndex === -1 ? '' : next.slice(callIndex, callIndex + 800)
if (!callWindow.includes('extraSignedHeaders')) {
  throw new Error('extraSignedHeaders is no longer passed to signRequestHuawei')
}
if (next.includes('const extraSignedHeaders = void 0;')) throw new Error('old session slot survived')

writeFileSync(PATH, next)
console.log(`patched: ${PATH}`)
console.log('  CodeArts requests now carry one stable x-ot-session-id per credential')
console.log('  queue wait capped at 6 attempts x 1s instead of 180 x 10s')