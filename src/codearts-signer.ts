/**
 * Huawei Cloud `SDK-HMAC-SHA256` signer for the CodeArts upstream.
 *
 * This is a **port of `internal/codearts/signer.go` from CodeArts2API**
 * (https://github.com/AA1AAAOQ/CodeArts2API, MIT), kept behaviour-for-behaviour
 * because the upstream gateway rejects anything else with `APIG.0301` — which
 * reads to a user as "not signed in" even though the credential is valid.
 *
 * Two details differ from Huawei's public documentation and are the usual source
 * of a wrong signature:
 *
 * 1. `CanonicalURI` is percent-encoded **per segment** and then forced to end in
 *    `/`. `/api/v2/chat/completions` signs as `/api/v2/chat/completions/`.
 * 2. `CanonicalHeaders` is built by concatenating `"k:v\n"` lines, so it already
 *    ends in `\n`; joining the canonical request with `\n` adds another one. The
 *    result is a blank line before `SignedHeaders`.
 *
 * `docs/UPSTREAM.md` in that repository records both against the live gateway.
 * The vectors in `tests/codearts-signer.test.ts` are the same ones its Go test
 * pins, computed independently rather than from this implementation.
 *
 * @module dsh-xdpool/codearts-signer
 */
import { createHash, createHmac } from 'node:crypto'

/** Signing algorithm stamped into `Authorization`. */
export const CODEARTS_SIGNING_ALGORITHM = 'SDK-HMAC-SHA256'

/** `x-sdk-date` shape the signer produces. */
const SDK_DATE_PATTERN = /^\d{8}T\d{6}Z$/u

/** Header values the upstream compares byte-for-byte after trimming. */
function trimmed(value: string): string {
  return value.trim()
}

/** Hex SHA-256 of a byte string. */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Huawei's JS `urlEncode`: RFC 3986 unreserved characters survive, everything
 * else becomes uppercase `%XX` per UTF-8 byte.
 *
 * `encodeURIComponent` is *not* the same function: it leaves `!'()*` untouched,
 * and a path containing `$+` (which `encodeURIComponent` does encode) is only
 * half the story — the signer must agree with what the upstream recomputes.
 */
export function jsUrlEncode(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  let out = ''
  for (const byte of bytes) {
    if (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d // -
      || byte === 0x2e // .
      || byte === 0x5f // _
      || byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Canonical URI: one encode per path segment, then a forced trailing slash.
 *
 * `URL.pathname` arrives percent-encoded, so each segment is decoded first and
 * re-encoded with {@link jsUrlEncode}. The upstream hashes this exact spelling.
 */
export function canonicalUri(pathname: string): string {
  const path = pathname === '' ? '/' : pathname
  const segments = path.split('/').map((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // A lone `%` is not a valid escape; signing the raw segment is the only
      // honest answer and matches what the Go implementation does on failure.
    }
    return jsUrlEncode(decoded)
  })
  const joined = segments.join('/')
  return joined.endsWith('/') ? joined : `${joined}/`
}

/**
 * Canonical query: keys and values each sorted, then both sides encoded.
 *
 * `URLSearchParams` has already decoded the input, which is what the upstream
 * does too; sorting after decoding is the pinned behaviour.
 */
export function canonicalQuery(parameters: URLSearchParams): string {
  const pairs: { key: string; value: string }[] = []
  for (const [key, value] of parameters) pairs.push({ key, value })
  pairs.sort((left, right) => left.key === right.key
    ? left.value.localeCompare(right.value)
    : left.key.localeCompare(right.key))
  return pairs.map(({ key, value }) => `${jsUrlEncode(key)}=${jsUrlEncode(value)}`).join('&')
}

/** Options one signed request accepts. */
export interface SignRequestOptions {
  /** Clock override so a test vector is deterministic. */
  now?: Date
}

/**
 * Sign one upstream request and return the headers to send.
 *
 * @param accessKeyId - STS access key (`HSTA…`).
 * @param secretAccessKey - STS secret key.
 * @param securityToken - STS token; an empty string omits `x-security-token`.
 * @param method - HTTP method; only POST/PUT/PATCH sign a body.
 * @param rawUrl - absolute URL the request will hit.
 * @param body - request body bytes, already serialized.
 * @param headers - extra headers (identity, tracing, model id) to sign.
 * @param options - clock override for tests.
 * @returns every signed header plus `host`, `x-sdk-date` and `Authorization`.
 */
export async function signRequest(
  accessKeyId: string,
  secretAccessKey: string,
  securityToken: string,
  method: string,
  rawUrl: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
  options: SignRequestOptions = {},
): Promise<Record<string, string>> {
  const url = new URL(rawUrl)
  const signedHeaders = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) {
    signedHeaders.set(name.toLowerCase(), value)
  }
  signedHeaders.set('host', url.host)
  if (!signedHeaders.has('x-sdk-date')) {
    signedHeaders.set('x-sdk-date', sdkDate(options.now ?? new Date()))
  }
  if (securityToken !== '') signedHeaders.set('x-security-token', securityToken)

  // Only methods whose body is part of the signature; a GET with a body signs
  // the empty hash, which is Huawei's own convention.
  const payload = method === 'PUT' || method === 'PATCH' || method === 'POST'
    ? Buffer.from(body)
    : Buffer.alloc(0)

  const names = [...signedHeaders.keys()].sort()
  const canonicalHeaderBlock = names
    .map(name => `${name}:${trimmed(signedHeaders.get(name) ?? '')}\n`)
    .join('')
  const signedHeaderList = names.join(';')
  const payloadHash = sha256Hex(payload)

  const canonicalRequest = [
    method,
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaderBlock,
    signedHeaderList,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    CODEARTS_SIGNING_ALGORITHM,
    signedHeaders.get('x-sdk-date') ?? '',
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n')

  const signature = createHmac('sha256', Buffer.from(secretAccessKey, 'utf8'))
    .update(stringToSign)
    .digest('hex')

  const out: Record<string, string> = {}
  for (const [name, value] of signedHeaders) out[name] = value
  out.Authorization = `${CODEARTS_SIGNING_ALGORITHM} Access=${accessKeyId}`
    + `, SignedHeaders=${signedHeaderList}, Signature=${signature}`
  return out
}

/** Render `x-sdk-date` from a clock. */
export function sdkDate(now: Date): string {
  const iso = now.toISOString()
  const stamp = iso.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return SDK_DATE_PATTERN.test(stamp) ? stamp : iso
}