/**
 * Usage accounting: what the panel may claim, and what it may not.
 *
 * Every case here exists because the module can produce a number that LOOKS
 * fine while being wrong. A panel that quietly doubles a failure count is worse
 * than one that reports nothing, so the turn/call distinction is pinned from
 * both sides.
 */

import { describe, expect, it } from 'vitest'
import {
  frameReportsOnlyUsage,
  isUsageOnlyFrame,
  parseUsage,
  StreamTracker,
  USAGE_DAY_LIMIT,
  usageDayKey,
  UsageRecorder,
  type TokenUsage,
  type UsageCall,
} from '../src/stats.ts'

const usage = (input: number, output: number): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  reasoningTokens: 0,
  cachedTokens: 0,
})

const call = (over: Partial<UsageCall> & { turnId: string }): UsageCall => ({
  region: 'cn',
  model: 'hy3',
  at: Date.UTC(2026, 0, 2, 12, 0, 0),
  ok: true,
  ...over,
})

describe('parseUsage', () => {
  it('reads the OpenAI spelling', () => {
    expect(parseUsage({ prompt_tokens: 120, completion_tokens: 30 })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 0,
      cachedTokens: 0,
    })
  })

  it('reads the input/output spelling some gateways use', () => {
    expect(parseUsage({ input_tokens: 7, output_tokens: 9 })?.inputTokens).toBe(7)
    expect(parseUsage({ input_tokens: 7, output_tokens: 9 })?.outputTokens).toBe(9)
  })

  it('reads reasoning and cached details', () => {
    const parsed = parseUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 25 },
      prompt_tokens_details: { cached_tokens: 80 },
    })
    expect(parsed?.reasoningTokens).toBe(25)
    expect(parsed?.cachedTokens).toBe(80)
  })

  it('treats a zero count as a real report, not as silence', () => {
    expect(parseUsage({ prompt_tokens: 0, completion_tokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    })
  })

  it('returns undefined for a document that carries no usage', () => {
    expect(parseUsage({ id: 'x' })).toBeUndefined()
    expect(parseUsage(undefined)).toBeUndefined()
    expect(parseUsage([{ prompt_tokens: 1 }])).toBeUndefined()
  })
})

describe('isUsageOnlyFrame', () => {
  it('matches an empty choices array beside a usage field', () => {
    expect(isUsageOnlyFrame({ choices: [], usage: { prompt_tokens: 1 } })).toBe(true)
  })

  it('never matches a frame that carries content', () => {
    expect(isUsageOnlyFrame({ choices: [{ delta: { content: 'hi' } }], usage: {} })).toBe(false)
  })

  it('never matches a frame with no usage at all', () => {
    expect(isUsageOnlyFrame({ choices: [] })).toBe(false)
  })
})

describe('usageDayKey', () => {
  it('formats a local calendar day', () => {
    expect(usageDayKey(new Date(2026, 0, 5, 23, 30).getTime())).toBe('2026-01-05')
  })
})

describe('StreamTracker', () => {
  it('keeps the earliest first byte', () => {
    const tracker = new StreamTracker(1000)
    tracker.markFirstByte(1200)
    tracker.markFirstByte(1200)
    expect(tracker.ttftMs).toBe(200)
  })

  it('does not report decode time without a first byte', () => {
    const tracker = new StreamTracker(1000)
    tracker.finish(1500)
    expect(tracker.decodeMs).toBeUndefined()
  })

  it('measures decode from the first byte to the end', () => {
    const tracker = new StreamTracker(1000)
    tracker.markFirstByte(1100)
    tracker.finish(1400)
    expect(tracker.decodeMs).toBe(300)
  })

  it('lets a later usage frame win', () => {
    const tracker = new StreamTracker()
    tracker.observe({ usage: { prompt_tokens: 1 } })
    tracker.observe({ usage: { prompt_tokens: 9 } })
    expect(tracker.usage?.inputTokens).toBe(9)
  })
})

describe('UsageRecorder', () => {
  it('drops the oldest sample once the window is full', () => {
    const recorder = new UsageRecorder(2)
    recorder.record(call({ turnId: 'a' }))
    recorder.record(call({ turnId: 'b' }))
    recorder.record(call({ turnId: 'c' }))
    expect(recorder.size()).toBe(2)
    expect(recorder.summary().turns).toBe(2)
  })

  it('separates logical turns from physical calls', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', ok: false }))
    recorder.record(call({ turnId: 't1', ok: false }))
    recorder.record(call({ turnId: 't1', ok: true }))
    const summary = recorder.summary()
    expect(summary.turns).toBe(1)
    expect(summary.calls).toBe(3)
  })

  it('counts a rotated turn as recovered, not failed', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', ok: false }))
    recorder.record(call({ turnId: 't1', ok: true }))
    const summary = recorder.summary()
    expect(summary.failedTurns).toBe(0)
    expect(summary.recoveredTurns).toBe(1)
  })

  it('counts a turn that failed on every account as failed', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', ok: false }))
    recorder.record(call({ turnId: 't1', ok: false }))
    expect(recorder.summary().failedTurns).toBe(1)
  })

  it('counts one failed turn per day even when it rotated', () => {
    const recorder = new UsageRecorder()
    const at = new Date(2026, 0, 2, 12, 0, 0).getTime()
    recorder.record(call({ turnId: 't1', at, ok: false }))
    recorder.record(call({ turnId: 't1', at, ok: false }))
    recorder.record(call({ turnId: 't1', at, ok: false }))
    const day = recorder.summary().days[0]
    expect(day.calls).toBe(3)
    expect(day.failedTurns).toBe(1)
  })

  it('reports no usage rather than zero when the gateway said nothing', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1' }))
    const summary = recorder.summary()
    expect(summary.usageReported).toBe(false)
    expect(summary.rows[0]?.inputTokens).toBe(0)
  })

  it('withholds throughput when the decode window is too short to measure', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', usage: usage(100, 50), decodeMs: 20 }))
    expect(recorder.summary().rows[0]?.tps).toBeNull()
  })

  it('publishes throughput once the decode window is real', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', usage: usage(100, 600), decodeMs: 2000 }))
    expect(recorder.summary().rows[0]?.tps).toBe(300)
  })

  it('averages time to first byte over the calls that reported one', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', ttftMs: 200 }))
    recorder.record(call({ turnId: 't2', ttftMs: 400 }))
    expect(recorder.summary().rows[0]?.avgTtftMs).toBe(300)
  })

  it('keeps one row per region and model', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1', region: 'cn', model: 'hy3' }))
    recorder.record(call({ turnId: 't2', region: 'global', model: 'hy3' }))
    expect(recorder.summary().rows).toHaveLength(2)
  })

  it('keeps the series sorted and bounded', () => {
    const recorder = new UsageRecorder()
    for (let i = 0; i < USAGE_DAY_LIMIT + 5; i += 1) {
      const at = new Date(2026, 0, i + 1, 12, 0, 0).getTime()
      recorder.record(call({ turnId: `t${i}`, at }))
    }
    const days = recorder.summary().days
    expect(days).toHaveLength(USAGE_DAY_LIMIT)
    expect(days.map(d => d.day)).toEqual([...days.map(d => d.day)].sort())
  })

  it('forgets everything on reset', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 't1' }))
    recorder.reset()
    expect(recorder.summary().calls).toBe(0)
  })
})

describe('frameReportsOnlyUsage', () => {
  it('matches the gateway trailer frame', () => {
    const frame = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n'
    expect(frameReportsOnlyUsage(frame)).toBe(true)
  })

  it('never matches a normal content chunk', () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":1}}\n\n'
    expect(frameReportsOnlyUsage(frame)).toBe(false)
  })

  it('never matches the done sentinel', () => {
    expect(frameReportsOnlyUsage('data: [DONE]')).toBe(false)
  })

  it('handles CRLF line endings', () => {
    expect(frameReportsOnlyUsage('data: {"choices":[],"usage":{}}\r\n')).toBe(true)
  })

  it('survives an unparsable payload instead of throwing', () => {
    expect(frameReportsOnlyUsage('data: {not json')).toBe(false)
  })

  it('ignores frames with no data line at all', () => {
    expect(frameReportsOnlyUsage(': comment\nevent: ping')).toBe(false)
  })

  it('reports a frame whose only data line is a usage trailer', () => {
    const frame = [': keep-alive', 'event: message', 'data: {"choices":[],"usage":{}}'].join('\n')
    expect(frameReportsOnlyUsage(frame)).toBe(true)
  })
})