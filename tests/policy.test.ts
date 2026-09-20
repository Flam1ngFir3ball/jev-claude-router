import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decisionOf,
  effortOf,
  excludedTiers,
  MODEL_OF,
  offeredTiers,
  TIERS,
} from '../hooks/policy.ts'

const choice = (name: string, confidence = 0.9) => ({
  tier: { type: 'choice', choice: name, confidence },
  effort: { type: 'score', score: 2 },
})

describe('policy', () => {
  test('a tier Jev picked becomes that tier’s model id', () => {
    const d = decisionOf(choice('fable'))
    assert.equal(d?.tier, 'fable')
    assert.equal(d?.model, 'claude-fable-5-1')
  })

  test('every tier maps to a model id the engine knows', () => {
    for (const tier of TIERS) {
      assert.match(MODEL_OF[tier], /^claude-(haiku|sonnet|opus|fable)-/)
    }
  })

  test('a score rounds to the nearest effort level', () => {
    assert.equal(effortOf(0), 'low')
    assert.equal(effortOf(2.4), 'high')
    assert.equal(effortOf(2.6), 'xhigh')
    assert.equal(effortOf(4), 'max')
  })

  test('a score outside the ladder clamps instead of throwing', () => {
    assert.equal(effortOf(-3), 'low')
    assert.equal(effortOf(99), 'max')
  })

  test('a missing or unusable score falls back to medium', () => {
    assert.equal(effortOf(undefined), 'medium')
    assert.equal(effortOf(Number.NaN), 'medium')
    assert.equal(effortOf('high'), 'medium')
  })

  test('a tier that was not offered is refused', () => {
    const offered = offeredTiers(excludedTiers('fable'))
    assert.equal(decisionOf(choice('fable'), offered), null)
    assert.equal(decisionOf(choice('opus'), offered)?.tier, 'opus')
  })

  test('excluding every tier falls back to the full ladder', () => {
    const offered = offeredTiers(excludedTiers('haiku,sonnet,opus,fable'))
    assert.deepEqual(offered, [...TIERS])
  })

  test('an unknown name in the exclude list is ignored', () => {
    assert.deepEqual([...excludedTiers('fable, nonsense')], ['fable'])
    assert.deepEqual([...excludedTiers(undefined)], [])
  })

  test('malformed answers give no decision rather than a wrong one', () => {
    assert.equal(decisionOf(null), null)
    assert.equal(decisionOf({}), null)
    assert.equal(decisionOf({ tier: { type: 'score', score: 1 } }), null)
    assert.equal(decisionOf({ tier: { type: 'choice' } }), null)
    assert.equal(decisionOf({ tier: { type: 'choice', choice: 'gpt-5' } }), null)
  })

  test('a missing confidence reads as no confidence, not as certainty', () => {
    const d = decisionOf({ tier: { type: 'choice', choice: 'opus' } })
    assert.equal(d?.confidence, 0)
  })
})
