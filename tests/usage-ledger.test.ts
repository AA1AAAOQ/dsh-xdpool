/**
 * The ledger the 数据看板 page renders.
 *
 * Every number here comes from {@link UsageRecorder.summary()}. The page never
 * re-derives anything: two derivations of one fact set are two chances to
 * disagree, and a dashboard whose KPI disagrees with the table underneath it is
 * worse than no dashboard, because it is trusted.
 *
 * The tests below exist mostly to pin the two distinctions the whole page rests
 * on, both of which are easy to regress into a plausible lie:
 *
 * - **turns are not calls.** One user request that rotated three accounts is one
 *   turn and three calls.
 * - **"no tokens" is not "no report".** Only `usageReported` separates a gateway
 *   that said zero from a gateway that said nothing.
 */
import { describe, expect, it } from 'vitest'
import { UsageRecorder, type UsageCall } from '../src/stats.ts'
function call(over: Partial<UsageCall> & { turnId: string }): UsageCall {
  return {
    region: 'cn',
    model: 'deepseek-v4.1-flash',
    at: Date.UTC(2026, 9, 7, 2, 35),
    ok: true,
    ...over,
  }
}
function tokens(inputTokens: number, outputTokens: number, cachedTokens = 0): UsageCall['usage'] {
  return { inputTokens, outputTokens, reasoningTokens: 0, cachedTokens }
}
describe('usage ledger', () => {
  it('publishes retained samples newest first', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', at: 1 }))
    recorder.record(call({ turnId: 'b', at: 2 }))
    recorder.record(call({ turnId: 'c', at: 3 }))
    expect(recorder.summary().entries.map(e => e.turnId)).toEqual(['c', 'b', 'a'])
  })
  it('does not let the newest-first view reorder the retained window', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', at: 1 }))
    recorder.record(call({ turnId: 'b', at: 2 }))
    recorder.summary()
    recorder.record(call({ turnId: 'c', at: 3 }))
    expect(recorder.summary().entries.map(e => e.turnId)).toEqual(['c', 'b', 'a'])
  })
  it('groups calls by the account that served them', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', account: 'alice#1', usage: tokens(100, 10) }))
    recorder.record(call({ turnId: 'a', account: 'bob#2', ok: false }))
    recorder.record(call({ turnId: 'b', account: 'alice#1', usage: tokens(50, 5) }))
    const rows = recorder.summary().accounts
    expect(rows.map(r => r.account)).toEqual(['alice#1', 'bob#2'])
    expect(rows[0]).toMatchObject({ calls: 2, turns: 2, failed: 0, inputTokens: 150, outputTokens: 15 })
    expect(rows[1]).toMatchObject({ calls: 1, turns: 1, failed: 1 })
  })
  it('keeps the same account label on two regions apart', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', region: 'cn', account: 'same#1' }))
    recorder.record(call({ turnId: 'b', region: 'global', account: 'same#1' }))
    const rows = recorder.summary().accounts
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.region).sort()).toEqual(['cn', 'global'])
  })
  it('names the two most-used models per account, busiest first', () => {
    const recorder = new UsageRecorder()
    for (let i = 0; i < 3; i += 1) recorder.record(call({ turnId: `a${String(i)}`, account: 'alice#1', model: 'hy3' }))
    recorder.record(call({ turnId: 'b0', account: 'alice#1', model: 'hy4-preview' }))
    recorder.record(call({ turnId: 'c0', account: 'alice#1', model: 'kimi-k3' }))
    expect(recorder.summary().accounts[0]?.topModels).toEqual(['hy3', 'hy4-preview'])
  })
  it('keeps a sample that named no account instead of dropping it from the totals', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', account: 'alice#1' }))
    recorder.record(call({ turnId: 'b', ok: false }))
    const summary = recorder.summary()
    expect(summary.calls).toBe(2)
    expect(summary.accounts).toHaveLength(2)
    expect(summary.accounts.some(r => r.account === '')).toBe(true)
  })
  it('counts cached tokens per account', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', account: 'alice#1', usage: tokens(100, 10, 80) }))
    expect(recorder.summary().accounts[0]?.cachedTokens).toBe(80)
  })
  it('separates turns from calls in the ledger the page reads', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a', account: 'alice#1', ok: false }))
    recorder.record(call({ turnId: 'a', account: 'bob#2', ok: false }))
    recorder.record(call({ turnId: 'a', account: 'carol#3' }))
    const summary = recorder.summary()
    expect(summary.turns).toBe(1)
    expect(summary.calls).toBe(3)
    expect(summary.recoveredTurns).toBe(1)
    expect(summary.failedTurns).toBe(0)
  })
  it('reports no usage when no sample carried a count', () => {
    const recorder = new UsageRecorder()
    recorder.record(call({ turnId: 'a' }))
    expect(recorder.summary().usageReported).toBe(false)
  })
})