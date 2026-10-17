/**
 * Recommended-use line for one model, derived purely from proved capabilities.
 *
 * The plugin refuses to invent a capability number, and the same discipline
 * applies here: this function only ever reads what {@link ModelFacts} already
 * proved — context window, image input, named thinking levels. Where the
 * upstream published nothing it says nothing, so a row with no facts yields no
 * recommended-use line rather than a guessed one.
 *
 * The three axes the user asked for — context size, thinking level, vision —
 * map directly onto the three fields a facts object can carry. Each becomes one
 * clause; the clauses are joined with a middle dot so the line reads as a single
 * recommendation rather than three unrelated tags.
 *
 * @module src/client/recommend-use
 */

import { formatModelCapacity, type ModelFacts } from './model-facts.ts'

/**
 * Compose a short Chinese "推荐用途" line from proved facts, or `undefined`
 * when there is nothing proved to base one on.
 *
 * `contextWindow` decides the size clause, `vision` the modality clause, and
 * `supportedEfforts` (the thinking levels the upstream named) the reasoning
 * clause. A model that published none of the three gets no line at all.
 */
export function recommendUse(facts: ModelFacts | undefined): string | undefined {
  if (facts === undefined) return undefined
  const bits: string[] = []

  const ctx = typeof facts.contextWindow === 'number' && facts.contextWindow > 0 ? facts.contextWindow : undefined
  if (ctx !== undefined) {
    const cap = formatModelCapacity(ctx)
    const tier = ctx >= 1_000_000
      ? `百万级长上下文(${cap})`
      : ctx >= 262_144
        ? `超长上下文(${cap})`
        : ctx >= 131_072
          ? `长上下文(${cap})`
          : ctx >= 65_536
            ? `中等上下文(${cap})`
            : `短上下文(${cap})`
    const use = ctx >= 1_000_000
      ? '长篇文档 / 论文 / 代码库分析'
      : ctx >= 262_144
        ? '长文与多轮深度对话'
        : ctx >= 131_072
          ? '长文写作与资料整理'
          : ctx >= 65_536
            ? '常规写作与问答'
            : '轻量对话与短文本'
    bits.push(`${tier}：${use}`)
  }

  if (facts.vision === true) bits.push('支持图片/截图输入：图表理解与多模态问答')

  const efforts = facts.supportedEfforts
  const reasons = Array.isArray(efforts) && efforts.length > 0
  if (reasons) bits.push('强推理：复杂逻辑 / 数学推导 / 代码生成')

  if (bits.length === 0) return undefined
  return bits.join(' · ')
}
