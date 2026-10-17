/**
 * `classifyUpstream` — the free-lane refusal must not read as a dead credential.
 *
 * The shared table files every 401/403 under `session_dead`, and that class means
 * one thing to every caller: this credential is spent, stop using it. The shim
 * acts on it (it penalizes the account, cools it out of rotation and refreshes
 * the token), so a refusal that is really about the CLIENT lands on the wrong
 * remedy entirely.
 *
 * The free tier is the case that proves it. OpenCode serves its anonymous models
 * only to its own client, and answers everyone else with
 *
 *   403 {"error":{"type":"FreeTierError","message":"OpenCode's free tier can
 *        only be used from within OpenCode. ..."}}
 *
 * That is 403 with a perfectly good credential. Classified as `session_dead` it
 * reads as "this lane is logged out" and invites the user to sign in again, clear
 * a catalog or reinstall — none of which can help, because there is nothing to
 * sign in to. It is a LOCKED LANE, and the message says so.
 *
 * Its neighbours are deliberately untouched, because each of them really is what
 * the table says: a 401 is a spent key, a bare 403 is a provider refusing this
 * credential, and a 429 is quota. Only the fingerprint refusal is separated.
 */
import { describe, expect, it } from 'vitest'
import { classifyUpstream } from '../src/aggregate.ts'

describe('classifyUpstream — the free tier refusal', () => {
  it('is not a dead session', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'FreeTierError',
        message:
          "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
      },
    })
    const error = classifyUpstream(403, body, undefined, '')
    // The class every caller reads as "stop using this credential". Nothing here
    // is spent: the request was well formed and the lane simply refuses clients
    // that are not its own.
    expect(error.kind).not.toBe('session_dead')
    // And the provider's own sentence is kept, because it names the fix.
    expect(error.message).toContain('free tier can only be used from within OpenCode')
  })

  it('still files an ordinary 403 as a dead session', () => {
    // A bare 403 IS a credential refusal. Narrowing the rule must not cost the
    // class that was there for the co-paid lane's revoked keys.
    expect(classifyUpstream(403, 'forbidden', undefined, '').kind).toBe('session_dead')
    expect(classifyUpstream(401, '{"error":{"message":"Invalid API key"}}', undefined, 'sk-live-x').kind).toBe(
      'session_dead',
    )
  })

  it('still files quota as a soft rate', () => {
    // 429 is the sibling refusal the free lane hits most often, and it is not a
    // lock: the same session answers again once the window passes.
    expect(classifyUpstream(429, 'Rate limit exceeded', undefined, '').kind).toBe('soft_rate')
    const retryAfter = classifyUpstream(429, 'Rate limit exceeded', 20_000, '')
    expect(retryAfter.kind).toBe('soft_rate')
    // The retry hint is the useful part of a quota refusal.
    expect(retryAfter.message).toContain('20s')
  })

  it('does not mistake an unrelated 403 that mentions free for a lock', () => {
    // The rule keys on the error TYPE the provider declared, not on the word
    // appearing somewhere in a free-form message. A provider that merely says
    // "your free plan may not do this" is refusing this request, not this client.
    const error = classifyUpstream(403, '{"error":{"message":"this free plan cannot reach that model"}}', undefined, '')
    expect(error.kind).toBe('session_dead')
  })
})
