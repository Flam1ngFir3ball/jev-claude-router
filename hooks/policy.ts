/**
 * The routing policy: which tiers exist, what Jev is told each one is for,
 * and how Jev's answers become a model and an effort level.
 *
 * Nothing here touches the engine or the network, so it runs under plain
 * `node` in tests.
 */

import {
  baseModel,
  fitsWindow,
  tierOfModel,
  type SwitchVerdict,
} from "./pricing.ts";

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

/** The efforts the engine accepts, low to high. There is no rung above max. */
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
   * The model Jev's tier would have run on, when held. Usually implied by
   * `held`; it differs when the session runs a model off the ladder
   * (`claude-opus-5`) and Jev named the same tier (`claude-opus-5-5`): the
   * same rung, a different cache.
   */
  heldModel?: string;
  /**
   * The two prices a held downgrade was decided between, when it was the
   * cost of the switch and not Jev's doubt that held it. Absent otherwise.
   */
  heldCost?: { stay: number; go: number; limit?: number };
  /**
   * The tier the turn had to leave because the context no longer fits it,
   * when the move went only as far up as it had to (not to Jev's pick).
   */
  outgrew?: Tier;
  /**
   * The context this turn carries, when that is what held it: the tier Jev
   * named cannot take a prompt this long at all. Absent otherwise.
   */
  heldWindow?: number;
  /** The confidence the switch needed, when Jev's doubt is what held it. */
  heldBar?: number;
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
  /**
   * The effort Jev named, when the tier's ceiling capped this turn. Absent
   * when no cap applied.
   */
  cappedEffort?: Effort;
  /**
   * Jev's probability for each offered tier, when the answer carried them.
   * They sum to one; `confidence` is derived from them when the provider
   * sends none (the Vercel gateway does not).
   */
  probabilities?: Partial<Record<Tier, number>>;
  /**
   * The effort Jev asked for, when `effort` is instead what the engine runs
   * on a conversation's first turn (see `FIRST_TURN_EFFORT`). Absent when
   * the two agree.
   */
  askedEffort?: Effort;
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

/**
 * Ordered low to high; the index Jev scores is the effort level. Written as
 * situations rather than degrees, which is what TypeSafe's guidance for a
 * score question asks for ("with numbers only, the model has nothing to
 * match against and splits the probability"). Five levels, one per effort
 * the engine accepts.
 */
export const EFFORT_CRITERIA: readonly string[] = [
  "The answer is already known or on screen: a lookup, a rename, a yes or " +
    "no, restating something.",
  "One or two obvious steps: a small edit whose shape the request already " +
    "gives, a short explanation.",
  "Several steps that have to fit together, or a choice worth weighing: " +
    "real code across a file or two, a bug with a likely cause.",
  "Many interacting parts, or a subtle failure to chase down: a change " +
    "across several files, a bug with no obvious cause, a design with " +
    "trade-offs.",
  "Open-ended or ambiguous, or the cost of being wrong is high: " +
    "architecture, a systematic debugging campaign, a migration plan, " +
    "anything where the approach itself is the hard part.",
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

type ChoiceAnswer = {
  type: "choice";
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
};
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

  const probabilities = probabilitiesOf(tier.probabilities, offered);
  const confidence =
    typeof tier.confidence === "number" && Number.isFinite(tier.confidence)
      ? tier.confidence
      : confidenceFrom(probabilities, offered.length);

  return {
    tier: choice as Tier,
    model: MODEL_OF[choice as Tier],
    effort: effortOf(isRecord(effort) ? effort.score : undefined),
    confidence,
    effortConfidence: confidenceOf(isRecord(effort) ? effort.confidence : 0),
    ...(probabilities !== undefined ? { probabilities } : {}),
  };
}

/** The per-tier probabilities from a choice answer, offered tiers only. */
function probabilitiesOf(
  raw: unknown,
  offered: readonly Tier[],
): Partial<Record<Tier, number>> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<Tier, number>> = {};
  let any = false;
  for (const tier of offered) {
    const p = raw[tier];
    if (typeof p === "number" && Number.isFinite(p)) {
      out[tier] = p;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * TypeSafe's confidence, from the probabilities, for a provider that sends
 * none. Their documented measure is how far the mass sits on one option:
 * all of it gives 1, an even spread gives 0, and their worked example
 * (0.85 / 0.15 / 0 → 0.78) is `(n·p_max − 1) / (n − 1)` for n options. Same
 * scale as the confidence the direct API sends, so the sticky bar means the
 * same thing on either provider.
 */
export function confidenceFrom(
  probabilities: Partial<Record<Tier, number>> | undefined,
  options: number,
): number {
  if (probabilities === undefined) return 0;
  const values = Object.values(probabilities).filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return 0;
  const max = Math.max(...values);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  if (options <= 1) return clamp(max);
  return clamp((options * max - 1) / (options - 1));
}

/**
 * The confidence a switch must clear before the model moves, when stickiness
 * is on. Jev's confidence is its top probability, normalised so an even
 * spread reads 0: with four tiers, 0.75 means the named tier holds about 81%
 * of the mass. 0.75 is a starting point, not a measured optimum; retune with
 * `/jev sticky` or `npm run try-prompts`.
 *
 * The bar is one of two things a shaky switch has to clear. The other is the
 * price: a downgrade whose cold cache write costs more than the turn would
 * cost on the tier already warm is held whatever Jev's confidence
 * (`switchVerdict` in pricing.ts, with the context size from the engine).
 */
export const DEFAULT_STICKY_CONFIDENCE = 0.75;

/**
 * Whether stickiness is on. **On by default** (unset/empty). Opt out with
 * `0`/`false`/`off`/`no`/`none`; opt in explicitly with `1`/`true`/`yes`/`on`.
 */
export function stickyOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  if (
    flag === "0" ||
    flag === "false" ||
    flag === "off" ||
    flag === "no" ||
    flag === "none"
  ) {
    return false;
  }
  // Unset, explicit on, or anything else → on (session default).
  return true;
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
 * Holds a switch on the tier the last turn used when Jev is not sure enough
 * of it, or when it is a downgrade that would cost more than it saves
 * (`verdict`, computed by the caller from the context size; null when the
 * switch is an upgrade, whose worth is a question of capability, not price).
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
  verdict: SwitchVerdict | null = null,
): Decision {
  if (previous === null) return fresh;
  // The model, not the tier: a session on `claude-opus-5` that Jev keeps on
  // opus is still a switch, to `claude-opus-5-5` and a cold cache. The
  // engine's `[1m]` suffix is not a different model, and the session's own
  // spelling is what is sent back, so nothing changes under it.
  if (baseModel(fresh.model) === baseModel(previous.model))
    return fresh.model === previous.model
      ? fresh
      : { ...fresh, model: previous.model };
  const shaky = fresh.confidence < threshold;
  const unprofitable = verdict !== null && verdict.hold;
  if (!shaky && !unprofitable) return fresh;
  return {
    tier: previous.tier,
    model: previous.model,
    effort: fresh.effort,
    confidence: fresh.confidence,
    // Sonnet effort gating reads this next; dropping it made every held
    // Sonnet turn look like effort confidence 0 and always hold effort.
    effortConfidence: fresh.effortConfidence,
    ...(fresh.probabilities !== undefined
      ? { probabilities: fresh.probabilities }
      : {}),
    held: fresh.tier,
    heldModel: fresh.model,
    ...(shaky && !unprofitable ? { heldBar: threshold } : {}),
    ...(unprofitable
      ? {
          heldCost: {
            stay: verdict.stay,
            go: verdict.go,
            ...(verdict.limit !== undefined ? { limit: verdict.limit } : {}),
          },
        }
      : {}),
  };
}

/**
 * Keeps a turn off a tier whose window it does not fit: on the tier already
 * running when that one takes it, otherwise nowhere (null), so the session
 * model answers. A `use haiku` at 300k is refused the same way; the API
 * would refuse it with "Prompt is too long", and did, three times in a week.
 */
export function withinWindow(
  decision: Decision,
  previous: Decision | null,
  contextTokens: number,
): Decision | null {
  if (fitsWindow(decision.tier, contextTokens)) return decision;
  if (previous === null || !fitsWindow(previous.tier, contextTokens))
    return null;
  return {
    tier: previous.tier,
    model: previous.model,
    effort: decision.effort,
    confidence: decision.confidence,
    effortConfidence: decision.effortConfidence,
    ...(decision.probabilities !== undefined
      ? { probabilities: decision.probabilities }
      : {}),
    held: decision.tier,
    heldModel: decision.model,
    heldWindow: contextTokens,
  };
}

/**
 * The decision a session is already running on, for the turns the router
 * did not route: a resumed session, `/jev on` after a stretch off, a plugin
 * loaded into a live session. Its cache is what the first routed turn's
 * switch is priced against. Null for a model off the ladder.
 */
export function sessionDecision(model: string): Decision | null {
  const tier = tierOfModel(model);
  if (tier === null) return null;
  return { tier, model, effort: "medium", confidence: 1 };
}

/**
 * A turn the engine started, not the person: its "say what you are doing,
 * then continue" nudge when a turn has run long without a reply. Jev would
 * grade the nudge's text (opus at 46%, measured 2026-09-23) and move the
 * model under a task that is mid-flight; the turn continues instead.
 */
const NUDGE = /^\s*The user hasn't heard from you in a while/i;

export function isEngineNudge(text: string): boolean {
  return NUDGE.test(normalizeQuotes(text));
}

/**
 * A bare go-ahead: the person is answering the previous turn, not starting a
 * task. Jev reads these as trivial with near-total confidence ("yes" 1.00,
 * "y" 0.98, "go ahead" 0.79, measured 2026-09-22), which is right about the
 * text and wrong about the work. Stickiness cannot catch this, since its bar
 * is a confidence and these clear any bar. The list is intentionally narrow
 * — bare `k`/`go`/`next`/`approved` used to false-positive on real tasks.
 * Trailing punctuation (`.`, `!`, `?`, `,`) is tolerated; anything longer is
 * a real prompt and goes to Jev.
 */
const CONTINUATION =
  /^(?:y|yes|yep|yeah|yup|ok|okay|sure|go ahead|go on|go for it|proceed|continue|carry on|do it|ok do it|let'?s do it|please do|yes please|sounds good|lgtm)[\s.!,?]*$/i;

export function isContinuation(text: string): boolean {
  return CONTINUATION.test(normalizeQuotes(text).trim());
}

/**
 * Whether natural-language tier overrides ("use opus") are honored.
 * On by default; `JEV_ROUTER_ALLOW_OVERRIDE=0` disables them.
 */
export function overrideAllowedOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  if (
    flag === "0" ||
    flag === "false" ||
    flag === "off" ||
    flag === "no" ||
    flag === "none"
  ) {
    return false;
  }
  return true;
}

/**
 * Whether a task-notification turn continues the previous route instead of
 * asking Jev. On by default: the turn's text is the engine's XML about a
 * finished background task, not work to grade, and the reply it wakes is
 * the one already under way. Skipping Jev there saves a round trip on the
 * critical path of every task that finishes. `JEV_ROUTER_NOTIFY_CONTINUE=0`
 * asks Jev anyway.
 */
export function notifyContinueOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no" || flag === "off");
}

/**
 * A tier named in the prompt: "use opus", "go with fable", "switch to haiku",
 * "run this on sonnet", "do it using opus". Only verbs that actually mean
 * "run on" are accepted; bare "on"/"for"/"with"/"using" are not (they turned
 * "happy with opus" and "I'm using opus for comparison" into routes). A bare
 * tier glued to another word ("sonnet-level") is not a name either. Negations
 * skip only the first run-on *or* bare `using <tier>` after them, so
 * "stop using haiku and use opus" still forces opus. A model id names its
 * tier too. Returns the tier, or null when none is named or not offered.
 */
const OVERRIDE =
  /\b(?:use|do (?:it |this )?using|switch(?:ing)? to|route to|run (?:it |this )?on|go with)\s+(?:claude-)?(haiku|sonnet|opus|fable)(?:-\d+)*(?![\w-])/gi;

/**
 * Bare `using <tier>` is not an override, but it can absorb a negation so a
 * later affirmative is not wrongly skipped ("stop using haiku and use opus").
 */
const USING_SINK =
  /\busing\s+(?:claude-)?(?:haiku|sonnet|opus|fable)(?:-\d+)*(?![\w-])/gi;

/** Bare `<tier>` after `avoid`/`stop` only ("avoid haiku and use opus"). */
const BARE_TIER_SINK =
  /\b(?:claude-)?(?:haiku|sonnet|opus|fable)(?:-\d+)*(?![\w-])/gi;

/**
 * Negation starters. Bare `\bnot` is omitted: "why not use opus" is
 * affirmative. `never mind` is omitted (`never(?!\s+mind)`). Spaced
 * `do/can/must/may not` and common `*n't` forms (curly apostrophes
 * normalized first) are included.
 */
const OVERRIDE_NEGATION_AT =
  /\b(?:do\s*n'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|shouldn'?t|mustn'?t|couldn'?t|can(?:'?t|not|\s+not)|never(?!\s+mind)|avoid|stop|do\s+not|must\s+not|may\s+not)\b/gi;

/**
 * Words allowed between a negation and its target. Anything else (you, what,
 * doing, and, …) means the negation is discourse/rhetorical, not "don't use".
 */
const NEGATION_BRIDGE =
  /^(?:\s+(?:want|to|try|ever|really|please|just|even|still|actually|also|need|have|you\s+to))*\s*$/i;

/** Fold typographic apostrophes so iOS/macOS quotes match the ASCII forms. */
function normalizeQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

export function parseOverride(
  text: string,
  offered: readonly Tier[] = TIERS,
): Tier | null {
  const normalized = normalizeQuotes(text);
  const matches = [...normalized.matchAll(OVERRIDE)];
  let named: Tier | null = null;
  for (const match of matches) {
    const at = match.index ?? 0;
    if (overrideNegated(normalized, at, matches)) continue;
    const tier = match[1]?.toLowerCase() as Tier | undefined;
    if (tier !== undefined && offered.includes(tier)) named = tier;
  }
  return named;
}

/** True when the gap is only light bridge words and no clause break. */
function proximityOk(gap: string): boolean {
  if (/[.!?,;:—–…]/.test(gap)) return false;
  return NEGATION_BRIDGE.test(gap);
}

/**
 * True when this match is the first attached run-on (or sink) after a
 * negation. Discourse ("Stop what you're doing and use opus") and tags
 * ("why don't you use opus") do not bind.
 */
function overrideNegated(
  text: string,
  matchAt: number,
  matches: RegExpMatchArray[],
): boolean {
  for (const neg of text.matchAll(OVERRIDE_NEGATION_AT)) {
    const negAt = neg.index ?? -1;
    if (negAt < 0 || negAt > matchAt) continue;
    const negEnd = negAt + neg[0].length;
    const negWord = neg[0].toLowerCase().replace(/\s+/g, " ");
    const sinks = [
      ...matches.map((m) => m.index ?? -1),
      ...[...text.matchAll(USING_SINK)].map((m) => m.index ?? -1),
    ];
    if (negWord === "avoid" || negWord === "stop") {
      sinks.push(
        ...[...text.matchAll(BARE_TIER_SINK)].map((m) => m.index ?? -1),
      );
    }
    const ordered = [...new Set(sinks.filter((i) => i >= negEnd))].sort(
      (a, b) => a - b,
    );
    for (const sink of ordered) {
      if (!proximityOk(text.slice(negEnd, sink))) break;
      // This negation binds its first attached sink only; keep scanning later
      // negations when that sink is someone else ("don't use haiku never use opus").
      if (sink === matchAt) return true;
      break;
    }
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

/**
 * The most effort each tier may be asked for. The engine's own default is
 * xhigh; the router's is medium on every tier, raised per session with
 * `JEV_ROUTER_CEILING` or `/jev ceiling`. One effort per tier is the whole
 * policy: what Jev asks for above it is capped to it, and `cappedEffort`
 * keeps what Jev wanted so the route line can say so.
 */
export type Ceiling = Record<Tier, Effort>;

export const DEFAULT_CEILING: Effort = "medium";

/** Ladder position of an effort, low to high. */
function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

/** An effort by name, or null. `off` and `none` mean no cap, which is max. */
export function effortNamed(raw: string): Effort | null {
  const name = raw.trim().toLowerCase();
  if (name === "off" || name === "none") return "max";
  return (EFFORTS as string[]).includes(name) ? (name as Effort) : null;
}

/** The same ceiling on every tier. */
export function ceilingAt(effort: Effort): Ceiling {
  return { haiku: effort, sonnet: effort, opus: effort, fable: effort };
}

/**
 * Reads `JEV_ROUTER_CEILING`: one effort for every tier (`xhigh`), or a
 * comma list of `tier:effort` pairs for some (`fable:xhigh,opus:high`) with
 * the rest at the default. Anything unreadable is ignored, so a typo leaves
 * the default in place rather than opening the ceiling.
 */
export function ceilingOf(raw: string | undefined): Ceiling {
  const ceiling = ceilingAt(DEFAULT_CEILING);
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return ceiling;
  const whole = effortNamed(text);
  if (whole !== null) return ceilingAt(whole);
  for (const part of text.split(",")) {
    const [tierName, effortName] = part.split(":").map((s) => s.trim());
    if (tierName === undefined || effortName === undefined) continue;
    const effort = effortNamed(effortName);
    if (effort === null || !(TIERS as string[]).includes(tierName)) continue;
    ceiling[tierName as Tier] = effort;
  }
  return ceiling;
}

/** A copy of `ceiling` with `effort` set on `tiers`, or on every tier. */
export function withCeiling(
  ceiling: Ceiling,
  effort: Effort,
  tiers: readonly Tier[] = TIERS,
): Ceiling {
  const next = { ...ceiling };
  for (const tier of tiers) next[tier] = effort;
  return next;
}

/** Caps a decision's effort at its tier's ceiling, keeping what Jev named. */
export function capTo(decision: Decision, ceiling: Ceiling): Decision {
  const cap = ceiling[decision.tier];
  if (effortRank(decision.effort) <= effortRank(cap)) return decision;
  return { ...decision, effort: cap, cappedEffort: decision.effort };
}

/**
 * What the engine runs on the first request of a conversation when asked
 * for an effort it does not honour there. Measured 2026-09-23 on Claude
 * Code 2.1.280, by the transcript's `perTurnEffort`: Fable 5.1 runs
 * `medium` as `high` on the first turn of a session (five of five), and
 * honours it from the second turn on (three of three); `low` and `high` go
 * through on every turn, and Opus 5.5 honours all five. The router sends
 * what will run, so the route line does not claim an effort the engine did
 * not use. The cost is the same either way. Remove an entry once the engine
 * honours it, and the request goes back to what Jev asked for.
 */
export const FIRST_TURN_EFFORT: Partial<
  Record<Tier, Partial<Record<Effort, Effort>>>
> = {
  fable: { medium: "high" },
};

/**
 * The decision as the engine will run it on a conversation's first turn,
 * with what Jev asked kept in `askedEffort` so the next turn, where the
 * engine honours it, starts from Jev's word and not the quirk.
 */
export function firstTurnEffort(decision: Decision): Decision {
  const ran = FIRST_TURN_EFFORT[decision.tier]?.[decision.effort];
  if (ran === undefined) return decision;
  return { ...decision, effort: ran, askedEffort: decision.effort };
}

/** The decision as Jev asked for it, for the turns that hold to or continue it. */
export function asAsked(decision: Decision): Decision {
  if (decision.askedEffort === undefined) return decision;
  const { askedEffort, ...rest } = decision;
  return { ...rest, effort: askedEffort };
}

/**
 * The context size from which an upgrade has to be surer than the bar.
 *
 * An upgrade writes the whole context to the dearer tier's cache: at 250k,
 * five dollars for fable. Over a week of transcripts (2026-09-23), 54 of 72
 * routed upgrades ran under 75% confidence and 7 more under 90%, every one
 * of those past 100k context, while the prompts that are plainly planning
 * work measure 0.97 to 1.00. So past this size an upgrade needs
 * `UPGRADE_CONFIDENCE`, or the bar if that is higher. A tier the prompt
 * names is not an upgrade in this sense and is never held.
 */
export const UPGRADE_CONTEXT_TOKENS = 100_000;
export const UPGRADE_CONFIDENCE = 0.9;

/**
 * The most an upgrade may cost this turn over staying, in dollars. Writing a
 * large context to a dearer tier's cache is the one cost a confident Jev
 * does not see: opus to fable at 250k is about $5 before any output. At $1
 * and a typical turn, an upgrade goes through up to about 48k of context
 * from opus to fable, 126k from sonnet to opus, 254k from haiku to sonnet.
 */
export const UPGRADE_MAX_USD = 1;

/**
 * `JEV_ROUTER_UPGRADE_MAX`: dollars an upgrade may cost over staying, or
 * `off` for no limit (the confidence bar still applies). Anything else is
 * the default.
 */
export function upgradeMaxOf(raw: string | undefined): number | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/^\$/, "");
  if (v === "off" || v === "none") return null;
  const n = Number(v);
  return v !== "" && Number.isFinite(n) && n >= 0 ? n : UPGRADE_MAX_USD;
}

/**
 * `JEV_ROUTER_PRICE_CHECK`: the downgrade and upgrade price checks, on
 * unless `0`, `false`, `no` or `off`. Separate from sticky, which is the
 * confidence bar alone.
 */
export function priceCheckOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no" || flag === "off");
}

/** The bar an upgrade must clear, given the context it would write. */
export function upgradeBar(bar: number, contextTokens: number): number {
  return contextTokens >= UPGRADE_CONTEXT_TOKENS
    ? Math.max(bar, UPGRADE_CONFIDENCE)
    : bar;
}
