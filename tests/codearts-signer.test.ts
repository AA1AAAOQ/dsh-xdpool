/**
 * Golden vectors for the CodeArts signer.
 *
 * The expected `Authorization` values are **not** produced by this module. They
 * are the same four vectors CodeArts2API's `internal/codearts/signer_test.go`
 * pins, where a separate Python implementation of Huawei's JS signer computed
 * them. That provenance is the point: a change that "cleans up" the double
 * newline or the forced trailing slash fails here instead of surfacing as
 * `APIG.0301` on the user's first request.
 *
 * @module dsh-xdpool/tests/codearts-signer
 */
import { describe, expect, it } from 'vitest'
import { canonicalQuery, canonicalUri, jsUrlEncode, signRequest } from '../src/codearts-signer.ts'

const VEC_AK = 'HSTAAAAAAAAAAAAAAAAAAA'
const VEC_SK = 'sk-secret-0123456789abcdef'
const VEC_STS = 'sts-token-abc123'

function authorization(header: Record<string, string> | undefined): string {
  expect(header).toBeDefined()
  return (header as Record<string, string>).Authorization
}

describe('CodeArts SDK-HMAC-SHA256 signer', () => {
  it('signs a POST with a body, STS token, and a padded header value', async () => {
    const signed = await signRequest(
      VEC_AK,
      VEC_SK,
      VEC_STS,
      'POST',
      'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions',
      new TextEncoder().encode('{"model":"glm-5.3-flash","stream":false}'),
      {
        'Content-Type': 'application/json',
        'X-Sdk-Date': '20260101T000000Z',
        maas_type: 'benefit',
        'model-id': 'glm-5.3-flash',
        'X-Ot-Function': '  agent-general  ',
      },
    )
    expect(authorization(signed)).toBe(
      'SDK-HMAC-SHA256 Access=' + VEC_AK
      + ', SignedHeaders=content-type;host;maas_type;model-id;x-ot-function;x-sdk-date;x-security-token'
      + ', Signature=d74d70f38c5d7e69b73c728740a2c7397a4191737d93f207d1a6f5fce49e99c4',
    )
  })

  it('sorts a repeated query and does not sign a GET body', async () => {
    const signed = await signRequest(
      'AKID',
      'SECRET',
      '',
      'GET',
      'https://opengw.developer.huaweicloud.com/api/v1/user/tokens/balance?b=2&a=1&a=0',
      new TextEncoder().encode('{"ignored":true}'),
      { 'X-Sdk-Date': '20260203T040506Z' },
    )
    expect(authorization(signed)).toBe(
      'SDK-HMAC-SHA256 Access=AKID, SignedHeaders=host;x-sdk-date'
      + ', Signature=0acd5e903f49fd4e91d71aee6188d446d6f76863c5d8f13a4d428c0af017af45',
    )
    expect(signed['x-security-token']).toBeUndefined()
  })

  it('encodes a path and query the way the JS signer does', async () => {
    const signed = await signRequest(
      'AKID',
      'SECRET',
      'TOK',
      'POST',
      'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/models/模型 名称/a$b+c?q=a b&z=~-._',
      new TextEncoder().encode('{}'),
      { 'X-Sdk-Date': '20260304T050607Z', 'x-ot-session-id': 'ses_deadbeefdeadbeef' },
    )
    expect(authorization(signed)).toBe(
      'SDK-HMAC-SHA256 Access=AKID, SignedHeaders=host;x-ot-session-id;x-sdk-date;x-security-token'
      + ', Signature=177aeae3dc48dc4b2dec46b1754ee2e1ea3af8d3f76044c33fe74f74df5f7224',
    )
  })

  it('signs an empty PUT body and leaves the STS header out when absent', async () => {
    const signed = await signRequest(
      'AKID',
      'SECRET',
      '',
      'PUT',
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim',
      new Uint8Array(),
      { 'X-Sdk-Date': '20260405T060708Z' },
    )
    expect(authorization(signed)).toBe(
      'SDK-HMAC-SHA256 Access=AKID, SignedHeaders=host;x-sdk-date'
      + ', Signature=1ee2960c0fad87a352395c32d2e4cb4f1fc2755cd92d09822dea0994700f3f79',
    )
  })
})

describe('canonical pieces', () => {
  it('encodes per segment and forces a trailing slash', () => {
    expect(canonicalUri('/api/v2/chat/completions')).toBe('/api/v2/chat/completions/')
    expect(canonicalUri('/')).toBe('/')
    expect(canonicalUri('/a/b/')).toBe('/a/b/')
    expect(canonicalUri('/a$b+c')).toBe('/a%24b%2Bc/')
    expect(canonicalUri('/模型 名称')).toBe('/%E6%A8%A1%E5%9E%8B%20%E5%90%8D%E7%A7%B0/')
  })

  it('sorts and encodes query entries', () => {
    expect(canonicalQuery(new URLSearchParams(''))).toBe('')
    expect(canonicalQuery(new URLSearchParams('b=2&a=1&a=0'))).toBe('a=0&a=1&b=2')
    expect(canonicalQuery(new URLSearchParams('z=~-._'))).toBe('z=~-._')
    expect(canonicalQuery(new URLSearchParams('q=a b'))).toBe('q=a%20b')
  })

  it('keeps only RFC 3986 unreserved characters', () => {
    expect(jsUrlEncode('abcXYZ019-._~')).toBe('abcXYZ019-._~')
    expect(jsUrlEncode('a b')).toBe('a%20b')
    expect(jsUrlEncode('$&+,:;=@')).toBe('%24%26%2B%2C%3A%3B%3D%40')
    expect(jsUrlEncode('模型')).toBe('%E6%A8%A1%E5%9E%8B')
    expect(jsUrlEncode('a/b')).toBe('a%2Fb')
    expect(jsUrlEncode('100%')).toBe('100%25')
  })
})