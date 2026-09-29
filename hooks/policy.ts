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
  /** Jev's pick, when the turn moved up only part of the way to it. */
  wanted?: Tier;
  /**
   * Why Jev gave no answer (a timeout, an error), when the turn stayed on the
   * tier already running instead of dropping to the session model.
   */
  jevFailed?: string;
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
   * answer was set aside and stickiness did not get a vote. Jev is not asked
   * at all, so it runs at medium effort. Shown on the route line, since a forced turn at 43%
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
  sonnet: "claude-sonnet-5-5",
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
  // Commas, semicolons or spaces between the names.
  const names = (raw ?? "")
    .split(/[\s,;]+/)
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

/**
 * `offered` paired with the `excluded` list that actually matches it. Naming
 * every tier excluded (a misconfigured `JEV_ROUTER_EXCLUDE`, or a matching
 * combination of `/jev tiers off` calls before the last-tier guard existed)
 * makes `offeredTiers` fall back to the full ladder rather than nothing —
 * every caller that stores or displays `excluded` alongside `offered` needs
 * the two to agree, or `/jev` can end up saying a tier is both offered and
 * excluded.
 */
export function tierFilter(excluded: Iterable<Tier>): {
  offered: Tier[];
  excluded: Tier[];
} {
  const set = excluded instanceof Set ? excluded : new Set(excluded);
  const offered = offeredTiers(set);
  return { offered, excluded: offered.length === TIERS.length ? [] : [...set] };
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
  // Clamped to 0..1: a Decision's confidence is trusted as a probability
  // everywhere it is read, and `persist.ts`'s unpack validation now rejects
  // one that is not — a provider that ever sends something outside that
  // range (measured possible, not measured live) would otherwise route on
  // it live and then have the whole Decision silently dropped on restore.
  const confidenceOf = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(1, Math.max(0, v))
      : 0;

  const probabilities = probabilitiesOf(tier.probabilities, offered);
  const confidence =
    typeof tier.confidence === "number" && Number.isFinite(tier.confidence)
      ? Math.min(1, Math.max(0, tier.confidence))
      : confidenceFrom(probabilities, offered.length, choice as Tier);

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
      out[tier] = Math.min(1, Math.max(0, p));
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
 *
 * With `chosen`, the mass is the chosen tier's own, not the largest: an
 * answer whose choice and probabilities disagree (haiku chosen at 0.05,
 * fable at 0.95) is not sure of haiku, and must not clear a bar as if it were.
 */
export function confidenceFrom(
  probabilities: Partial<Record<Tier, number>> | undefined,
  options: number,
  chosen?: Tier,
): number {
  if (probabilities === undefined) return 0;
  const values = Object.values(probabilities).filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return 0;
  const p = chosen === undefined ? Math.max(...values) : (probabilities[chosen] ?? 0);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  if (options <= 1) return clamp(p);
  return clamp((options * p - 1) / (options - 1));
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
  // Unset, explicit on, or anything else → on (session default).
  return !flagOff(raw);
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
  return confidenceShareOf(raw) ?? DEFAULT_STICKY_CONFIDENCE;
}

/**
 * A confidence bar as a share strictly between 0 and 1, or null. `0.6`,
 * `60` and `60%` are the same bar; anything written with `%` is a
 * percentage, so `0.5%` is half a percent, not half. Without `%`, a number
 * past 1 is a percentage, but one between 1 and 10 must be whole: `1.5` is
 * refused rather than read as 1.5%, a bar so low it is as good as none.
 * Plain decimals only (`Number` alone reads `0x40` as 64).
 */
export function confidenceShareOf(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  const percent = trimmed.endsWith("%");
  const v = percent ? trimmed.slice(0, -1).trim() : trimmed;
  if (!PLAIN_DECIMAL.test(v)) return null;
  const n = Number(v);
  // `1.5` could be 1.5% or a slip for 0.15; `60.5` can only be a percentage.
  if (!percent && n > 1 && n < 10 && !Number.isInteger(n)) return null;
  const ratio = percent || n > 1 ? n / 100 : n;
  return ratio > 0 && ratio < 1 ? ratio : null;
}

/**
 * Holds a switch on the tier the last turn used when Jev is not sure enough
 * of it, or when the move costs more than it is worth (`verdict`, computed
 * by the caller from the context size: for a downgrade, whether it saves
 * anything; for an upgrade, whether it costs more than the upgrade limit
 * over staying; null when price checks are off or nothing is known).
 *
 * Only the model is held here. The effort Jev asked for is applied either
 * way: on Opus and Haiku it is sent per request and costs no cache, so a
 * held turn still gets to think harder or less hard than the one before it.
 * Sonnet is the exception, and `holdsSonnetEffort` handles it separately.
 *
 * `previous` is the tier the last routed turn ran on, or null on the first
 * turn of a session, which has nothing to hold to.
 *
 * `offered` refuses to hold on a `previous` that has since been turned off
 * with `/jev tiers off` — but only when `previous` was itself a real routed
 * decision (`effortConfidence` set). A `previous` seeded only as a
 * placeholder from the session model (nothing ever routed there) is exempt:
 * an unrouted turn runs on that same placeholder anyway, so refusing to
 * weigh it against a switch's real cost does not stop the plugin from
 * "using" the tier — the tier is not being used *by a choice this plugin
 * made* either way — and it does force a switch whose cache-write cost can
 * run many times what staying would have, for no benefit.
 */
export function stickyDecision(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
  verdict: SwitchVerdict | null = null,
  offered: readonly Tier[] = TIERS,
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
  const droppedTier =
    !offered.includes(previous.tier) && previous.effortConfidence !== undefined;
  if ((!shaky && !unprofitable) || droppedTier) return fresh;
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
 * running when that one takes it, otherwise nowhere (null), so the caller's
 * own step-up runs instead. A `use haiku` at 300k is refused the same way;
 * the API would refuse it with "Prompt is too long", and did, three times in
 * a week. `offered` refuses `previous` as a landing spot when it has been
 * turned off since it started running, even though it still fits — the
 * caller still sees `previous` was non-null (nothing here nulls it), so its
 * own step-up runs from `decision.tier` rather than giving up outright.
 */
export function withinWindow(
  decision: Decision,
  previous: Decision | null,
  contextTokens: number,
  offered: readonly Tier[] = TIERS,
): Decision | null {
  if (fitsWindow(decision.tier, contextTokens)) return decision;
  if (
    previous === null ||
    !fitsWindow(previous.tier, contextTokens) ||
    !offered.includes(previous.tier)
  )
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
    // A named tier that does not fit is still the person's pick.
    ...(decision.forced ? { forced: true as const } : {}),
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
  return !flagOff(raw);
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
  return !flagOff(raw);
}

/** The words every on/off setting reads as off: `0`, `false`, `no`, `off`, `none`. */
export function flagOff(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "no" || flag === "off" || flag === "none";
}

/** A plain decimal (`12`, `0.5`, `1000.`, `.5`): no sign, hex or exponent, the same for every setting. */
export const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

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
/** The verbs that route, shared by OVERRIDE and the backticked-tier unwrap in ownWords. */
const ROUTE_VERB =
  "use|do (?:it |this )?using|switch(?:ing)?(?: over| back)?(?: (?:the )?model)? to|route to|run (?:it |this )?on|go with";

const OVERRIDE = new RegExp(
  `\\b(?:${ROUTE_VERB})\\s+(?:claude-)?(haiku|sonnet|opus|fable)(?:-\\d+)*(?![\\w-])`,
  "gi",
);

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
 * affirmative. `never mind` is omitted (`never(?!\s+mind)`). Every modal's
 * contracted AND spaced form is included ("shouldn't"/"should not",
 * "won't"/"will not", ...) — a prior version had the contractions but
 * missed the spaced form for should/would/could/will, so "we should not use
 * haiku" read as affirmative and forced the very tier it refused.
 */
const OVERRIDE_NEGATION_AT =
  /\b(?:do\s*n'?t|doesn'?t|didn'?t|won'?t|will\s+not|wouldn'?t|would\s+not|shouldn'?t|should\s+not|mustn'?t|couldn'?t|could\s+not|can(?:'?t|not|\s+not)|never(?!\s+mind)|avoid|stop|do\s+not|must\s+not|may\s+not)\b/gi;

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

/**
 * The words of a prompt that are the person's own: without pasted content
 * (the engine wraps it in `<pasted_content>` tags), code blocks and spans,
 * and quoted lines. A handoff or log pasted in can say "use opus" as an
 * example; that is not an instruction to route there.
 */
/**
 * `text` without its `<tag …>…</tag>` blocks, found by hand: the pattern
 * this replaces rescanned to the end from every unclosed opening (a paste
 * of 100k `<pasted_content ` took half a second).
 */
function withoutBlocks(text: string, tag: string): string {
  const OPEN = `<${tag}`;
  const CLOSE = `</${tag}`;
  let out = "";
  let pos = 0;
  let at = text.indexOf(OPEN);
  while (at !== -1) {
    const next = text[at + OPEN.length];
    if (next !== undefined && /\w/.test(next)) {
      at = text.indexOf(OPEN, at + 1);
      continue;
    }
    const openEnd = text.indexOf(">", at);
    if (openEnd === -1) break;
    const close = text.indexOf(CLOSE, openEnd + 1);
    if (close === -1) break;
    const closeEnd = text.indexOf(">", close);
    if (closeEnd === -1) break;
    out += `${text.slice(pos, at)} `;
    pos = closeEnd + 1;
    at = text.indexOf(OPEN, pos);
  }
  return out + text.slice(pos);
}

export function ownWords(text: string): string {
  return withoutBlocks(withoutBlocks(text, "pasted_content"), "task-notification")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    // A tier alone in backticks after a route verb is the person's own ask
    // ("use `opus`"), not code: unwrapped before code spans go.
    .replace(new RegExp(`\\b(${ROUTE_VERB})\\s+\`((?:claude-)?(?:haiku|sonnet|opus|fable)(?:-\\d+)*)\``, "gi"), "$1 $2")
    .replace(/`[^`\n]*`/g, " ")
    // A code comment on a line of its own, outside a fence: `// use opus`.
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    // A phrase in double quotes is being quoted, not said: "use opus".
    .replace(/"[^"\n]{1,200}"/g, " ")
    .replace(/\u201c[^\u201d\n]{1,200}\u201d/g, " ")
    // Single quotes too, around a short phrase with no punctuation inside:
    // the README says 'use opus'. An apostrophe (don't, 'em, users') is not
    // a quote: it does not both open after a space and close before one
    // around a phrase that short and plain.
    .replace(/(^|[\s(])['\u2018][^'\u2018\u2019\n.,;:!?]{1,60}['\u2019](?=[\s.,;:!?)]|$)/g, "$1 ")
    .replace(/^[ \t]*>.*$/gm, " ");
}

/** How much of the person's own words a named tier is looked for in. */
const OWN_WORDS_MAX = 20_000;

export function parseOverride(
  text: string,
  offered: readonly Tier[] = TIERS,
): Tier | null {
  // A tier named in a prompt past this many characters is in a paste the
  // engine did not mark; the person's own ask is at the start or the end.
  const own = normalizeQuotes(ownWords(text));
  // Joined with a sentence break, so a phrase cannot form across the cut
  // ("…use" + "opus…" from "user" and "octopus").
  const normalized = own.length <= OWN_WORDS_MAX ? own : `${own.slice(0, OWN_WORDS_MAX / 2)}\n.\n${own.slice(-OWN_WORDS_MAX / 2)}`;
  const matches = [...normalized.matchAll(OVERRIDE)];
  const negated = negatedAt(normalized, matches);
  let named: Tier | null = null;
  for (const [i, match] of matches.entries()) {
    const at = match.index ?? 0;
    if (negated.has(at)) continue;
    const previous = matches[i - 1];
    const from = previous ? (previous.index ?? 0) + previous[0].length : 0;
    if (!addressedAt(normalized, from, at)) continue;
    if (TIER_AS_NAME.test(normalized.slice(at + match[0].length, at + match[0].length + 40))) continue;
    const tier = match[1]?.toLowerCase() as Tier | undefined;
    if (tier !== undefined && offered.includes(tier)) named = tier;
  }
  return named;
}

/**
 * What may stand ahead of the verb, between the start of its clause and the
 * verb, for the phrase to be said to the model. Measured against a labelled
 * set of prompts (tests/fixtures/override-corpus.ts): refusing only what
 * looks like talk (a deny-list) let through prose with any subject not
 * listed ("anyone can use opus", "they want to use opus", "the job will
 * switch to haiku"), so this lists what a request opens with instead —
 * softeners, acknowledgements, scope ("for the migration", "this time"),
 * and the ways of asking — and anything else is talk about a tier. The cost
 * of a miss is a turn left to Jev; of a false match, a forced switch with no
 * checks, which is the one to avoid.
 */
const OPENER = new RegExp(
  "^(?:" +
    [
      // Softeners and acknowledgements.
      "please|pls|plz|pleae|kindly|pretty please|just|now|then|so|ok|okay|kk|cool|oh|hey|hi|yes|yeah|yep|yup|sure|hmm+|um+|well|again",
      "maybe|perhaps|actually|instead|also|and|but|or|rather|here|claude|nope|no|alright|right",
      "fine|anyway|honestly|really|definitely|ideally|tbh|always|only|probably|better",
      // Addressing the model by name: `@claude`.
      "@[\\w-]+",
      // Scope.
      // One word after "for the": a second is the clause's own subject
      // ("for these tasks people use haiku" is talk).
      "this time|for this one|for this|for now|from now on|going forward|for the rest of (?:the|this) [\\w-]+|for (?:the|this|that|these|those|each|every|all) [\\w-]+",
      // Asking.
      "let'?s|let us|let me|go ahead and|i want you to|i want to|we want to|i'?d like (?:you )?to|i would like (?:you )?to",
      "i need you to|we need to|you need to|i'?d rather you|i would rather you|i'?d prefer (?:(?:that |if )?you)?|i think (?:you|we) should",
      "you should|u should|we should|you can|you may|you could|can you|can u|could you|would you|will you|can we|could we|shall we",
      "feel free to|you'?re free to|make sure (?:to|you)|remember to|be sure to|try to|time to|it'?s time to",
      "(?:please )?don'?t hesitate to|i'?m going to ask you to|i'?m asking you to|i said(?: to)?|wouldn'?t hurt to",
      "you might as well|might as well|you might want to",
      // Tag questions that ask for it.
      "why not|why don'?t you|can'?t you|won'?t you|couldn'?t you|wouldn'?t you",
    ].join("|") +
    ")(?: |$)",
);

/** A list marker opening the clause: `-`, `*`, `+`, `•`, `- [ ]`, `1.`, `1)`, `(1)`, `a)`. */
const BULLET = /^(?:[-*+•](?:\s*\[[ x]?\])?|\[[ x]?\]|\(?(?:\d+|[a-z])[.)])\s*/;

/** A clause break: sentence ends, commas, dashes, ellipses, a new line, a joining and/then/but. */
const CLAUSE_BREAK = /[.!?,;:\n—–…]|\s-\s|\s(?:and|then|but)\s/gi;

/**
 * Whether the verb at `at` asks the model to run on the tier: the text from
 * the last clause break (or the end of the previous route phrase, `from`) up
 * to the verb is nothing but `OPENER`s.
 */
function addressedAt(text: string, from: number, at: number): boolean {
  let start = from;
  for (const brk of text.slice(from, at).matchAll(CLAUSE_BREAK))
    start = from + (brk.index ?? 0) + brk[0].length;
  // A clause under a condition describes what happens then, not what to do
  // now: "if it runs long, switch to opus", "otherwise use opus".
  let sentence = from;
  for (const brk of text.slice(from, start).matchAll(/[.!?\n]/g)) sentence = from + (brk.index ?? 0) + 1;
  // Any clause of the sentence so far: "Add a fallback: if it times out, …".
  for (const part of text.slice(sentence, start).toLowerCase().split(/[,;:—–]|\s-\s/)) {
    const clause = part.trim().replace(BULLET, "");
    if (CONDITION.test(clause) && !POLITE_CONDITION.test(clause) && !SET_PHRASE.test(clause))
      return false;
  }
  let lead = text.slice(start, at).trim().toLowerCase().replace(/\s+/g, " ").replace(BULLET, "");
  for (let guard = 0; lead !== "" && guard < 12; guard++) {
    const m = lead.match(OPENER);
    if (m === null) return false;
    lead = lead.slice(m[0].length).trimStart();
  }
  return lead === "";
}

/** A clause that sets a condition, ahead of the one naming the tier. */
const CONDITION = /^(?:if|when|whenever|unless|once|until|in case|otherwise|else)\b/;

/** Set phrases that are not conditions on anything: "once again", "if needed". */
const SET_PHRASE =
  /^(?:once (?:again|more)|if (?:so|not)|(?:if|when) in doubt|if that'?s the case|whenever|until the end of (?:this|the) (?:session|conversation|task|chat)|if so|if (?:needed|necessary|possible|required|appropriate|applicable)|when(?:ever)? (?:done|ready|finished|possible)|until further notice|if (?:that|this|it)(?:'?s| is)? (?:ok|okay|fine|alright|all right|not too much trouble)(?: with \w+)?)\s*(?:then)?\s*$/;

/**
 * A condition that is only manners, or the person's say-so, not a state of
 * things: "if you can", "if you want", "whenever you're ready", "unless you
 * disagree", "until I say otherwise". A listed phrase and nothing more: "if
 * you get a 429" or "if my repo is large" describes behaviour.
 */
const POLITE_CONDITION = new RegExp(
  "^(?:if|when|whenever|unless|until)\\s+(?:" +
    [
      "(?:you|u|ya)\\s+(?:can|could|would|will|may|might|want(?: to)?|like|wish|prefer|please|must|disagree|object|agree|think so|see fit|are able|are ready|are free|don'?t mind|do not mind|get (?:a|the) chance|have (?:a )?(?:sec|second|moment|minute|chance|time))",
      "you'?re (?:ready|able|free|ok|okay|happy|done)",
      "i (?:say|tell you) (?:otherwise|so|to stop)",
      "i change my mind",
      "possible",
      "(?:that|it)(?:'?s| is) (?:ok|okay|fine|alright|all right|not too much(?: trouble)?)(?: with you)?",
    ].join("|") +
    ")\\s*(?:then)?\\s*$",
);

/**
 * Words after the tier that make it a name for something else: "use sonnet
 * pricing" is about a price table, "use haiku ids in the test" about ids.
 */
const TIER_AS_NAME =
  /^[ \t]+(?:pricing|prices?|rates?|ids?|names?|constants?|strings?|labels?|values?|entr(?:y|ies)|fields?|columns?|tables?|fixtures?|mocks?|stubs?|numbers?|figures?|tokens?|limits?|costs?|windows?)\b/i;

/** True when the gap is only light bridge words and no clause break. */
function proximityOk(gap: string): boolean {
  if (/[.!?,;:—–…]/.test(gap)) return false;
  return NEGATION_BRIDGE.test(gap);
}

/**
 * The route phrases a negation binds: each negation binds the first run-on
 * (or sink) attached after it, and only that one. Discourse ("Stop what
 * you're doing and use opus") and tags ("why don't you use opus") do not
 * bind. Worked out once per prompt, in one pass over the negations with the
 * sinks found once: re-finding every sink for every phrase and negation made
 * a long prompt cubic (a 20k-character one took a minute).
 */
function negatedAt(text: string, matches: readonly RegExpMatchArray[]): Set<number> {
  const at = (m: RegExpMatchArray) => m.index ?? -1;
  const sorted = (xs: number[]) => [...new Set(xs.filter((i) => i >= 0))].sort((a, b) => a - b);
  const sinks = sorted([...matches.map(at), ...[...text.matchAll(USING_SINK)].map(at)]);
  const withBare = sorted([...sinks, ...[...text.matchAll(BARE_TIER_SINK)].map(at)]);
  // The first position in `xs` at or after `from`.
  const firstFrom = (xs: readonly number[], from: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    return xs[lo];
  };
  const bound = new Set<number>();
  for (const neg of text.matchAll(OVERRIDE_NEGATION_AT)) {
    const negEnd = (neg.index ?? 0) + neg[0].length;
    const negWord = neg[0].toLowerCase().replace(/\s+/g, " ");
    const sink = firstFrom(negWord === "avoid" || negWord === "stop" ? withBare : sinks, negEnd);
    if (sink !== undefined && proximityOk(text.slice(negEnd, sink))) bound.add(sink);
  }
  return bound;
}

/**
 * A decision forced to a named tier. The router does not ask Jev for one
 * (`fresh` is null), so it runs at medium; given an answer, its effort would
 * be kept and its tier set aside.
 */
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
 *
 * With `ceiling`, an effort the ceiling no longer allows is not held: it
 * would be cut to the cap anyway, so the effort changes and the cache is
 * rewritten whatever the hold does, and Jev's own pick should run instead.
 */
export function holdsSonnetEffort(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
  ceiling?: Ceiling,
): boolean {
  if (previous === null) return false;
  if (fresh.tier !== "sonnet" || previous.tier !== "sonnet") return false;
  if (fresh.effort === previous.effort) return false;
  if (ceiling !== undefined && effortRank(previous.effort) > effortRank(ceiling.sonnet)) return false;
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
 * The most effort each tier may be asked for, xhigh on every tier by
 * default — matching the engine's own default — and adjustable per session
 * with `JEV_ROUTER_CEILING` or `/jev ceiling`. One effort per tier is the
 * whole policy: what Jev asks for above it is capped to it, and
 * `cappedEffort` keeps what Jev wanted so the route line can say so.
 */
export type Ceiling = Record<Tier, Effort>;

export const DEFAULT_CEILING: Effort = "xhigh";

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
  // Commas, semicolons or spaces between the parts, as JEV_ROUTER_EXCLUDE.
  for (const part of text.replace(/\s*:\s*/g, ":").split(/[\s,;]+/)) {
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
  // Plain dollars only: `-1` or `0x10` is a mistake, not a limit.
  if (!PLAIN_DECIMAL.test(v)) return UPGRADE_MAX_USD;
  return Number(v);
}

/**
 * `JEV_ROUTER_PRICE_CHECK`: the downgrade and upgrade price checks, on
 * unless `0`, `false`, `no`, `off` or `none`. Separate from sticky, which is the
 * confidence bar alone.
 */
export function priceCheckOf(raw: string | undefined): boolean {
  return !flagOff(raw);
}

/** The bar an upgrade must clear, given the context it would write. */
export function upgradeBar(bar: number, contextTokens: number): number {
  return contextTokens >= UPGRADE_CONTEXT_TOKENS
    ? Math.max(bar, UPGRADE_CONFIDENCE)
    : bar;
}
