/**
 * The usage panel's honesty guard.
 *
 * A usage panel can pass every test above this one and still lie in two
 * specific ways, and both are silent: printing ONE number where the reader
 * assumes "calls" when the truth is "turns" (a turn that rotated three
 * accounts would read as three questions), and printing a confident zero
 * about a gateway that simply declined to report token counts.
 *
 * So these cases read the rendered copy and the CALL SITE, not the arithmetic
 * - the arithmetic already has its own tests, and duplicating it here would
 * guard nothing new.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UsageRecorder } from '../src/stats.ts'

const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

describe('usage panel copy', () => {
  it('keeps turns and calls as two separate numbers', () => {
    // A collapsed panel would report "3 calls" for one question and the
    // reader would have no way to notice.
    expect(card).toContain("'row.usageTurns'")
    expect(card).toContain('turns: usage.turns')
    expect(card).toContain('calls: usage.calls')
    // Both failure flavours are named: a turn that failed outright and one
    // that rotation rescued are not the same event.
    expect(card).toContain('failed: usage.failedTurns')
    expect(card).toContain('recovered: usage.recoveredTurns')
  })

  it('says "not reported" instead of printing zero tokens', () => {
    // The single number a usage panel must never invent.
    expect(card).toContain('usage.usageReported')
    expect(card).toContain("'row.usageNotReported'")
  })

  it('shows every gateway, not only the tab on screen', () => {
    // Filtering by region would hide half the calls while the header still
    // reported the recorder's totals - the two numbers would disagree.
    expect(card).toContain('usage.rows.map')
    expect(card).not.toMatch(/usage\.rows\.filter\([^)]*region/)
  })

  it('states that the window does not survive a restart', () => {
    expect(card).toContain("'row.usageWindow'")
  })
})

describe('usage panel locale keys', () => {
  const keys = [
    'row.usageTitle',
    'row.usageTurns',
    'row.usageEmpty',
    'row.usageNotReported',
    'row.usageTokens',
    'row.usageCached',
    'row.usageSpeed',
    'row.usageTtft',
    'row.usageRowFailed',
    'row.usageWindow',
  ]

  it('defines every key the card reads', () => {
    for (const key of keys) {
      // Occurs twice: once in the English table, once in the Chinese one.
      // A single occurrence means one language is missing it.
      const occurrences = locales.split(`'${key}'`).length - 1
      expect(occurrences, key).toBe(2)
    }
  })

  it('keeps both languages parameterized identically', () => {
    for (const key of keys) {
      const lines = locales.split('\n').filter(line => line.includes(`'${key}'`))
      const params = lines.map(line => [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(','))
      // A Chinese string missing a placeholder would print the literal
      // "{turns}" to the user, and no type check would notice.
      expect(params[0], key).toBe(params[1])
    }
  })
})

describe('usage window honesty', () => {
  it('counts a rescued turn once, not once per account it visited', () => {
    const recorder = new UsageRecorder()
    recorder.record({ region: 'cn', model: 'm', turnId: 't1', at: 1, ok: false })
    recorder.record({ region: 'cn', model: 'm', turnId: 't1', at: 2, ok: false })
    recorder.record({ region: 'cn', model: 'm', turnId: 't1', at: 3, ok: true })
    const summary = recorder.summary()
    expect(summary.turns).toBe(1)
    expect(summary.calls).toBe(3)
    expect(summary.recoveredTurns).toBe(1)
    expect(summary.failedTurns).toBe(0)
    expect(summary.rows[0]?.recovered).toBe(1)
  })
})
