/**
 * The routing policy: which tiers exist, what Jev is told each one is for,
 * and how Jev's answers become a model and an effort level.
 *
 * Nothing here touches the engine or the network, so it runs under plain
 * `node` in tests.
 */

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Decision = {
  tier: Tier
  model: string
  effort: Effort
  /** Jev's confidence in the tier, 0 to 1. The gateway rounds to 2 places. */
  confidence: number
}

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']

export const EFFORTS: readonly Effort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Model ids as the engine names them. */
export const MODEL_OF: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  fable: 'claude-fable-5-1',
}

/**
 * What Jev is told each tier is for. This is the policy: edit these lines to
 * change how the router behaves, and nothing else.
 */
export const TIER_CRITERIA: Record<Tier, string> = {
  haiku:
    'Trivial. A lookup, a rename, a yes or no question, reading one short file, ' +
    'restating something already on screen.',
  sonnet:
    'Straightforward and minor. A small edit whose shape is already obvious from ' +
    'the request, with no real decision to make.',
  opus:
    'Plain implementation carrying some complexity. Writing or changing real code, ' +
    'possibly across a few files, where the approach is known but the work is not ' +
    'mechanical.',
  fable:
    'High complexity needing higher-order reasoning. Planning, brainstorming, ' +
    'architecture, systematic debugging, weighing trade-offs, research. Anything ' +
    'where working out the approach is itself the hard part.',
}

/** Ordered low to high; the index Jev scores is the effort level. */
export const EFFORT_CRITERIA: readonly string[] = [
  'No thinking needed. The answer is immediate.',
  'A little thinking. One or two steps.',
  'Real thinking. Several steps, or a choice worth weighing.',
  'Hard thinking. Many interacting parts, or a subtle failure to chase down.',
  'As hard as it gets. Open-ended, ambiguous, or the cost of being wrong is high.',
]

/** Tiers dropped from the question entirely, lowercase, from the env var. */
export function excludedTiers(raw: string | undefined): Set<Tier> {
  const names = (raw ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  return new Set(names.filter((n): n is Tier => (TIERS as string[]).includes(n)))
}

/** The tiers offered to Jev, in ladder order, never empty. */
export function offeredTiers(excluded: Set<Tier>): Tier[] {
  const kept = TIERS.filter(t => !excluded.has(t))
  return kept.length > 0 ? [...kept] : [...TIERS]
}

type ChoiceAnswer = { type: 'choice'; choice?: unknown; confidence?: unknown }
type ScoreAnswer = { type: 'score'; score?: unknown; confidence?: unknown }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Jev's score across EFFORT_CRITERIA to the nearest effort level. */
export function effortOf(score: unknown): Effort {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'medium'
  const i = Math.min(Math.max(Math.round(score), 0), EFFORTS.length - 1)
  return EFFORTS[i] ?? 'medium'
}

/**
 * Turns the `answers` object of a Jev response into a decision.
 *
 * Returns null whenever the answer is missing, malformed, or names a tier
 * that was not offered: the caller then leaves the turn alone.
 */
export function decisionOf(
  answers: unknown,
  offered: readonly Tier[] = TIERS,
): Decision | null {
  if (!isRecord(answers)) return null

  const tier = answers.tier as ChoiceAnswer | undefined
  if (!isRecord(tier) || tier.type !== 'choice') return null

  const choice = tier.choice
  if (typeof choice !== 'string') return null
  if (!offered.includes(choice as Tier)) return null

  const effort = answers.effort as ScoreAnswer | undefined
  const confidence =
    typeof tier.confidence === 'number' && Number.isFinite(tier.confidence)
      ? tier.confidence
      : 0

  return {
    tier: choice as Tier,
    model: MODEL_OF[choice as Tier],
    effort: effortOf(isRecord(effort) ? effort.score : undefined),
    confidence,
  }
}
