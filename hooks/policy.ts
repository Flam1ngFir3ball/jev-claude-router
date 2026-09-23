/**
 * The routing policy: which tiers exist, what Jev is told each one is for,
 * and how Jev's answers become a model and an effort level.
 *
 * Nothing here touches the engine or the network, so it runs under plain
 * `node` in tests.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Decision = {
  tier: Tier;
  model: string;
  effort: Effort;
  /** Jev's confidence in the tier, 0 to 1. The gateway rounds to 2 places. */
  confidence: number;
  /**
   * Jev's confidence in the effort score, separately. Measured 2026-09-22:
   * the two move independently (tier 0.81 with effort 0.49 on the same
   * prompt), and effort confidence is lowest on terse follow-ups, which is
   * where an effort flip is least worth paying for. 0 when the answer
   * carried none.
   */
  effortConfidence?: number;
  /**
   * The tier Jev named, when stickiness kept the turn on the previous one
   * instead. Absent on a turn that went where Jev pointed. Kept so the route
   * line can say a hold happened; a hold nobody can see is indistinguishable
   * from a router that is not running.
   */
  held?: Tier;
  /**
   * The effort Jev named, when a turn staying on Sonnet kept the previous
   * turn's effort instead (see `holdsSonnetEffort`). Absent otherwise.
   */
  heldEffort?: Effort;
  /**
   * The tier was named in the prompt itself ("use opus"), so Jev's tier
   * answer was set aside and stickiness did not get a vote. Its effort still
   * comes from Jev. Shown on the route line, since a forced turn at 43%
   * would otherwise read as a low-confidence pick.
   */
  forced?: true;
};

export const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

export const EFFORTS: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Model ids as the engine names them. */
export const MODEL_OF: Record<Tier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

/**
 * What Jev is told each tier is for. This is the policy: edit these lines to
 * change how the router behaves, and nothing else.
 */
export const TIER_CRITERIA: Record<Tier, string> = {
  haiku:
    "Trivial. A lookup, a rename, a yes or no question, reading one short file, " +
    "restating something already on screen.",
  sonnet:
    "Straightforward and minor. A small edit whose shape is already obvious from " +
    "the request, with no real decision to make.",
  opus:
    "Plain implementation carrying some complexity. Writing or changing real code, " +
    "possibly across a few files, where the approach is known but the work is not " +
    "mechanical.",
  fable:
    "High complexity needing higher-order reasoning. Planning, brainstorming, " +
    "architecture, systematic debugging, weighing trade-offs, research. Anything " +
    "where working out the approach is itself the hard part.",
};

/** Ordered low to high; the index Jev scores is the effort level. */
export const EFFORT_CRITERIA: readonly string[] = [
  "No thinking needed. The answer is immediate.",
  "A little thinking. One or two steps.",
  "Real thinking. Several steps, or a choice worth weighing.",
  "Hard thinking. Many interacting parts, or a subtle failure to chase down.",
  "As hard as it gets. Open-ended, ambiguous, or the cost of being wrong is high.",
];

/** Tiers dropped from the question entirely, lowercase, from the env var. */
export function excludedTiers(raw: string | undefined): Set<Tier> {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    names.filter((n): n is Tier => (TIERS as string[]).includes(n)),
  );
}

/** The tiers offered to Jev, in ladder order, never empty. */
export function offeredTiers(excluded: Set<Tier>): Tier[] {
  const kept = TIERS.filter((t) => !excluded.has(t));
  return kept.length > 0 ? [...kept] : [...TIERS];
}

type ChoiceAnswer = { type: "choice"; choice?: unknown; confidence?: unknown };
type ScoreAnswer = { type: "score"; score?: unknown; confidence?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Jev's score across EFFORT_CRITERIA to the nearest effort level. */
export function effortOf(score: unknown): Effort {
  if (typeof score !== "number" || !Number.isFinite(score)) return "medium";
  const i = Math.min(Math.max(Math.round(score), 0), EFFORTS.length - 1);
  return EFFORTS[i] ?? "medium";
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
  if (!isRecord(answers)) return null;

  const tier = answers.tier as ChoiceAnswer | undefined;
  if (!isRecord(tier) || tier.type !== "choice") return null;

  const choice = tier.choice;
  if (typeof choice !== "string") return null;
  if (!offered.includes(choice as Tier)) return null;

  const effort = answers.effort as ScoreAnswer | undefined;
  const confidenceOf = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  return {
    tier: choice as Tier,
    model: MODEL_OF[choice as Tier],
    effort: effortOf(isRecord(effort) ? effort.score : undefined),
    confidence: confidenceOf(tier.confidence),
    effortConfidence: confidenceOf(isRecord(effort) ? effort.confidence : 0),
  };
}

/**
 * The confidence a switch must clear before the model moves, when stickiness
 * is on.
 *
 * The prompt cache is per model: a session cached under one tier is cold for
 * the next, so the turn that switches pays full input tokens. A router that
 * flips on a 51% hunch can pick the cheaper model every time and still cost
 * more. 0.75 is the starting point, not a measured optimum; retune it with
 * `npm run try-prompts`.
 */
export const DEFAULT_STICKY_CONFIDENCE = 0.75;

/** Whether stickiness is on. Off unless the env var says otherwise. */
export function stickyOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/**
 * The bar from the environment, or the default when it is unusable.
 *
 * A value above 1 is read as a percentage, since `JEV_ROUTER_STICKY_CONFIDENCE=80`
 * is the likelier intent than a bar no turn can ever clear. 0 and 1 are both
 * refused: one would hold every switch forever, the other would hold none,
 * and each is better said by leaving the flag off.
 */
export function thresholdOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STICKY_CONFIDENCE;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio <= 0 || ratio >= 1) return DEFAULT_STICKY_CONFIDENCE;
  return ratio;
}

/**
 * Holds a shaky switch on the tier the last turn used.
 *
 * Only the model is held here. The effort Jev asked for is applied either
 * way: on Opus and Haiku it is sent per request and costs no cache, so a
 * held turn still gets to think harder or less hard than the one before it.
 * Sonnet is the exception, and `holdsSonnetEffort` handles it separately.
 *
 * `previous` is the tier the last routed turn ran on, or null on the first
 * turn of a session, which has nothing to hold to.
 */
export function stickyDecision(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
): Decision {
  if (previous === null) return fresh;
  if (fresh.tier === previous.tier) return fresh;
  if (fresh.confidence >= threshold) return fresh;
  return {
    tier: previous.tier,
    model: previous.model,
    effort: fresh.effort,
    confidence: fresh.confidence,
    // Sonnet effort gating reads this next; dropping it made every held
    // Sonnet turn look like effort confidence 0 and always hold effort.
    effortConfidence: fresh.effortConfidence,
    held: fresh.tier,
  };
}

/**
 * A bare go-ahead: the person is answering the previous turn, not starting a
 * task. Jev reads these as trivial with near-total confidence ("yes" 1.00,
 * "y" 0.98, "go ahead" 0.79, measured 2026-09-22), which is right about the
 * text and wrong about the work: the work is whatever the last turn proposed,
 * on whatever tier it ran. Stickiness cannot catch this, since its bar is a
 * confidence and these clear any bar. Trailing punctuation (`.`, `!`, `?`,
 * `,`) is tolerated; anything longer is a real prompt and goes to Jev.
 */
const CONTINUATION =
  /^(?:y|yes|yep|yeah|yup|ok|okay|k|sure|go|go ahead|go on|go for it|proceed|continue|carry on|do it|ok do it|let'?s do it|please do|yes please|sounds good|lgtm|approved|next)[\s.!,?]*$/i;

export function isContinuation(text: string): boolean {
  return CONTINUATION.test(text.trim());
}

/**
 * A tier named in the prompt: "use opus", "go with fable", "switch to haiku",
 * "run this on sonnet", "do it using opus". Only verbs that actually mean
 * "run on" are accepted; bare "on"/"for"/"with"/"using" are not (they turned
 * "happy with opus" and "I'm using opus for comparison" into routes). A bare
 * tier glued to another word ("sonnet-level") is not a name either. Negations
 * (`don't want to use`, `won't use`, `avoid using`) skip only the first run-on
 * after the negation, so "don't use haiku use opus" still forces opus. A model
 * id ("use claude-opus-5-5") names its tier too. Returns the tier, or null
 * when none is named or the named one is not offered.
 */
const OVERRIDE =
  /\b(?:use|do (?:it |this )?using|switch(?:ing)? to|route to|run (?:it |this )?on|go with)\s+(?:claude-)?(haiku|sonnet|opus|fable)(?:-\d+)*(?![\w-])/gi;

/**
 * Negation starters. Bare `\bnot` is omitted on purpose: "why not use opus"
 * is an affirmative ask. Spaced `do not` / `can not` are included; so are the
 * common `*n't` forms (`doesn't`, `shouldn't`, …).
 */
const OVERRIDE_NEGATION_AT =
  /\b(?:do\s*n'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|shouldn'?t|mustn'?t|can(?:'?t|not|\s+not)|never|avoid|stop|do\s+not)\b/gi;

export function parseOverride(
  text: string,
  offered: readonly Tier[] = TIERS,
): Tier | null {
  const matches = [...text.matchAll(OVERRIDE)];
  let named: Tier | null = null;
  for (const match of matches) {
    const at = match.index ?? 0;
    if (overrideNegated(text, at, matches)) continue;
    const tier = match[1]?.toLowerCase() as Tier | undefined;
    if (tier !== undefined && offered.includes(tier)) named = tier;
  }
  return named;
}

/**
 * True when this match is the first run-on after a negation. A later
 * affirmative in the same sentence ("don't use haiku use opus") is not.
 */
function overrideNegated(
  text: string,
  matchAt: number,
  matches: RegExpMatchArray[],
): boolean {
  const before = text.slice(0, matchAt);
  let lastNeg = -1;
  for (const neg of before.matchAll(OVERRIDE_NEGATION_AT)) {
    lastNeg = neg.index ?? -1;
  }
  if (lastNeg < 0) return false;
  for (const other of matches) {
    const otherAt = other.index ?? 0;
    if (otherAt < lastNeg) continue;
    return otherAt === matchAt;
  }
  return false;
}

/** A decision forced to a named tier; Jev's effort is kept, its tier is not. */
export function forcedDecision(tier: Tier, fresh: Decision | null): Decision {
  return {
    tier,
    model: MODEL_OF[tier],
    effort: fresh?.effort ?? "medium",
    confidence: fresh?.confidence ?? 0,
    effortConfidence: fresh?.effortConfidence ?? 0,
    forced: true,
  };
}

/**
 * Whether a turn staying on Sonnet should keep the previous turn's effort.
 *
 * Measured 2026-09-22 on one session at ~58k context: an effort change on
 * Opus 5.5 and Haiku 4.5 costs nothing (the engine sends it per turn), but
 * on Sonnet 5 it rewrites everything after the system block, about half the
 * prefix, $0.12 at that size. So on Sonnet an effort flip is a cache miss
 * and gets the same treatment as a model switch: it has to clear the bar.
 *
 * The bar is read against Jev's confidence in the effort score, not the
 * tier, because the two are separate answers and the effort one is the
 * shakier (0.00 to 0.81 across ten prompts; lowest on the short follow-ups
 * where a flip is least worth $0.12). Symmetric on purpose: letting rises
 * through freely ratchets a Sonnet stretch up to xhigh and holds it there.
 */
export function holdsSonnetEffort(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
): boolean {
  if (previous === null) return false;
  if (fresh.tier !== "sonnet" || previous.tier !== "sonnet") return false;
  if (fresh.effort === previous.effort) return false;
  return (fresh.effortConfidence ?? 0) < threshold;
}

/**
 * The confidence a subagent's classification must reach before its model is
 * set, up or down. A subagent starts with an empty conversation, so there is
 * no cache to protect and stickiness does not apply; what the bar guards is
 * a guess. Calibrated 2026-09-22 on six subagent-style prompts: the
 * well-specified ones scored 0.72 to 0.98, the one vague audit 0.22, so 0.5
 * splits them. Below it the subagent runs on what it would have anyway.
 */
export const SUBAGENT_CONFIDENCE = 0.5;

/**
 * Jev's decision for a spawned subagent, or null to leave the spawn alone.
 * Nothing is held to: the parent's tier is only what "alone" resolves to.
 */
export function subagentDecision(
  fresh: Decision | null,
  threshold: number = SUBAGENT_CONFIDENCE,
): Decision | null {
  if (fresh === null) return null;
  return fresh.confidence >= threshold ? fresh : null;
}
