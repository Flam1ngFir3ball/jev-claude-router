/**
 * What `/jev` prints, the line at the top of a reply, and the summary under
 * it. `/jev` is the router's only guaranteed-visible surface: a command's
 * output row draws on every surface, where a footer label may not, so
 * anything you need to be sure of belongs here.
 *
 * Everything shown to the person is in short plain words: `kept fable:
 * haiku costs $4.41 vs $0.13`, not `held:haiku·$4.41>$0.125`.
 */

import type { JevResult } from "./jev.ts";
import {
  capTo,
  ceilingAt,
  MODEL_OF,
  decisionOf,
  DEFAULT_STICKY_CONFIDENCE,
  effortNamed,
  EFFORTS,
  forcedDecision,
  holdsSonnetEffort,
  stickyDecision,
  SUBAGENT_CONFIDENCE,
  subagentDecision,
  TIERS,
  UPGRADE_CONTEXT_TOKENS,
  upgradeBar,
  withCeiling,
  withinWindow,
  type Ceiling,
  type Decision,
  type Tier,
} from "./policy.ts";
import {
  baseModel,
  breakEvenTokens,
  isDowngrade,
  PRICE,
  upgradeVerdict,
  priceOfModel,
  switchVerdict,
  usageCost,
  usd,
  fitsWindow,
  WINDOW_TOKENS,
  type Ttl,
} from "./pricing.ts";
import type { ProviderResult } from "./provider.ts";
import { compactionLine, type Compaction } from "./compactor.ts";

/**
 * What the API said a turn cost, and which model it says answered. The
 * shape of the engine's `TurnUsage`, spelled out here so this file stays
 * free of engine types and runs under plain `node`.
 */
export type Usage = {
  /** The model that answered, by the id the API reports. */
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * One turn's outcome, kept for the status report. `usage` arrives after the
 * decision, from the `stop` chunk of each step, so it is filled in later and
 * is absent for a turn still running or one whose response never came.
 */
export type Attempt = {
  prompt: string;
  ms: number;
  usage?: Usage;
  /** Dollars for `usage` at list price, or absent for a model without one. */
  cost?: number;
  /**
   * What started the turn, when it was not the person typing a task. Absent
   * for a typed prompt. `notify`: the main loop woke because a background
   * task finished, and the engine's `<task-notification>` was the turn's
   * text. `agent`: a subagent's own loop, which no `turn.start` announces;
   * its model was settled at `agent.spawn`, and its steps carry that. Without
   * this, one prompt that spawned three reviewers read as one reply that
   * changed model three times. `continue`: a bare go-ahead ("yes"), which
   * ran on the previous turn's decision without asking Jev. `nudge`: the
   * engine's own "say what you are doing, then continue", the same way, and
   * announced nowhere but here.
   */
  kind?: "notify" | "agent" | "continue" | "nudge";
  /** For `kind: 'agent'`: which subagent, as `$.agent.list()` describes it. */
  agent?: AgentTag;
} & ({ decision: Decision } | { skipped: string });

/**
 * Which subagent a turn ran in. `type` is the definition (`general-purpose`,
 * `Explore`); `label` its row's description (`Review library-sync cluster`),
 * or the id when the list has no row for it yet, in which case `type` is
 * absent too.
 */
export type AgentTag = {
  type?: string;
  label: string;
};

/** Percent, rounded, for a confidence. */
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Why a turn did not run exactly as Jev asked, in plain words: held on its
 * previous tier for doubt or for price, held on its previous Sonnet effort,
 * forced to a tier the prompt named, capped at the ceiling, or sent the
 * effort a first request runs. Empty when it ran as asked.
 */
export function reasonsOf(attempt: Attempt): string[] {
  if (!("decision" in attempt)) return [];
  const d = attempt.decision;
  const out: string[] = [];
  if (d.held !== undefined) {
    // Same rung, different model: a session model off the ladder.
    const wanted =
      d.heldModel !== undefined && d.held === d.tier ? d.heldModel : d.held;
    const kept = d.held === d.tier ? d.model : d.tier;
    out.push(
      d.heldWindow !== undefined
        ? `kept ${kept}: too long for ${wanted} (${kOf(d.heldWindow)})`
        : d.heldCost !== undefined
          ? `kept ${kept}: ${wanted} costs ${usd(d.heldCost.go)} vs ${usd(d.heldCost.stay)}` +
            (d.heldCost.limit !== undefined
              ? `, over the ${usd(d.heldCost.limit)} limit`
              : "")
          : `kept ${kept}: Jev ${pct(d.confidence)} on ${wanted}` +
            (d.heldBar !== undefined ? `, needs ${pct(d.heldBar)}` : ""),
    );
  }
  if (d.jevFailed !== undefined)
    out.push(`kept ${d.tier}: Jev ${d.jevFailed}`);
  if (d.outgrew !== undefined)
    out.push(
      `${d.outgrew} too long, moved up only to ${d.tier}` +
        (d.wanted !== undefined && d.wanted !== d.tier ? ` (Jev wanted ${d.wanted})` : ""),
    );
  // Sonnet only: an effort change there re-caches half the prefix.
  if (d.heldEffort !== undefined) {
    out.push(
      `kept ${d.effort}: Jev ${pct(d.effortConfidence ?? 0)} on ${d.heldEffort}`,
    );
  }
  if (d.forced) out.push("your pick");
  // The ceiling, and the engine running the capped effort higher on a
  // conversation's first request, read as one fact: what Jev wanted, what
  // the ceiling allowed, what actually ran. A first request that ran what
  // Jev wanted anyway was not capped in any way that matters.
  const capped = d.cappedEffort !== undefined && d.cappedEffort !== d.effort;
  if (capped && d.askedEffort !== undefined)
    out.push(
      `capped ${d.cappedEffort}→${d.askedEffort}; 1st request runs it as ${d.effort}`,
    );
  else if (capped) out.push(`capped from ${d.cappedEffort}`);
  else if (d.askedEffort !== undefined)
    out.push(`1st request runs ${d.askedEffort} as ${d.effort}`);
  return out;
}

/**
 * The cheapest tier above `from`, up to `to`, that takes `contextTokens`:
 * where a turn goes when what it would run on is too small. `fromIncluded`
 * false means strictly above `from`. Null when none fits.
 */
function stepUp(
  from: Tier,
  to: Tier,
  offered: readonly Tier[],
  contextTokens: number,
  strictlyAbove = true,
): Tier | null {
  const lo = TIERS.indexOf(from);
  const hi = TIERS.indexOf(to);
  return (
    TIERS.find(
      (t, i) =>
        (strictlyAbove ? i > lo : i >= lo) &&
        i <= hi &&
        offered.includes(t) &&
        fitsWindow(t, contextTokens),
    ) ?? null
  );
}

/** What started a turn nobody typed, in plain words; null for a typed prompt. */
export function originOf(
  attempt: Pick<Attempt, "kind" | "agent">,
): string | null {
  if (attempt.kind === "notify") return "task finished";
  if (attempt.kind === "continue") return "continuing";
  if (attempt.kind === "nudge") return "continuing";
  if (attempt.kind === "agent")
    return attempt.agent?.type ? `${attempt.agent.type} agent` : "agent";
  return null;
}

const NOTIFICATION = /^\s*<task-notification>/;
const tagOf = (text: string, tag: string) =>
  text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

/**
 * Reads the engine's task notification, when the turn's text is one: what
 * the row should say instead of the XML envelope.
 */
export function notificationOf(text: string): string | null {
  if (!NOTIFICATION.test(text)) return null;
  return tagOf(text, "summary") ?? `task ${tagOf(text, "task-id") ?? "?"}`;
}

/** The task a notification is about: the agent's id, as `$.agent.list()` names it. */
export function notificationTaskOf(text: string): string | null {
  if (!NOTIFICATION.test(text)) return null;
  return tagOf(text, "task-id") ?? null;
}

/**
 * Folds one step's usage into its turn: counts sum, the model is the last
 * step's, as the engine defines a turn's usage, and the dollars are re-priced
 * from the sum. Mutates, because the same object sits in the history and in
 * the by-turn lookup. Returns this one step's own cost (0 when it cannot be
 * priced), for the caller's running session total — which must count every
 * step's real cost regardless of whether the *row's* total stays presentable
 * (see below).
 *
 * `attempt.cost` is the row's own field, for display, and is deliberately
 * `undefined` — not "however much we could price" — the moment any one of
 * the turn's steps cannot be priced (a synthetic or unknown model): a partial
 * dollar figure with a $ sign in front of it reads as the whole turn's cost,
 * which it is not. That is a display choice; it must not double as the
 * accounting for money actually spent. An earlier version conflated the two
 * by having the caller diff `attempt.cost` before and after this call: the
 * moment `attempt.cost` was cleared (this step or an earlier one lacked a
 * price), the diff went negative and silently subtracted a step already
 * billed, or if the *first* step was unpriced, `attempt.cost` stayed
 * `undefined` forever and every later step's real cost added `0 - 0` —
 * missing the whole turn from the session total.
 */
export function addUsage(
  attempt: Attempt,
  usage: Usage,
  ttl: Ttl = "1h",
): number {
  const prior = attempt.usage;
  attempt.usage = {
    model: usage.model,
    input_tokens: (prior?.input_tokens ?? 0) + usage.input_tokens,
    output_tokens: (prior?.output_tokens ?? 0) + usage.output_tokens,
    cache_read_input_tokens:
      (prior?.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens,
    cache_creation_input_tokens:
      (prior?.cache_creation_input_tokens ?? 0) +
      usage.cache_creation_input_tokens,
  };
  // Each step at the model that answered it: a turn whose steps ran on
  // different models (a fallback) is not priced wholly at the last one's.
  const step = usageCost(usage.model, usage, ttl);
  if (step === null || (prior !== undefined && attempt.cost === undefined))
    delete attempt.cost;
  else attempt.cost = (attempt.cost ?? 0) + step;
  return step ?? 0;
}

/**
 * How much of what the turn's requests carried was read from cache, 0 to 1.
 * Everything carried is uncached input plus cache reads plus cache writes;
 * this is the cost-relevant measure, since reads bill at a tenth.
 */
export function cacheRatio(usage: Usage): number {
  const carried = carriedOf(usage);
  return carried === 0 ? 0 : usage.cache_read_input_tokens / carried;
}

/** What the last turn carried into the model: the context size, in tokens. */
export function carriedOf(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

/**
 * A usage record with every count a number. The API omits the cache fields
 * on some paths; summed unchecked they made NaN of the turn's cost, the
 * session's `spent` and the context every price hold reads.
 */
export function normalUsage(usage: {
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}): Usage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    model: typeof usage.model === "string" ? usage.model : "",
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    cache_read_input_tokens: n(usage.cache_read_input_tokens),
    cache_creation_input_tokens: n(usage.cache_creation_input_tokens),
  };
}

/**
 * How much of a prompt is kept in the history. Only its opening is shown,
 * and a session of long pastes kept whole outran the store's size cap, so
 * nothing saved.
 */
export const PROMPT_KEPT = 400;
export const kept = (text: string) => (text.length > PROMPT_KEPT ? text.slice(0, PROMPT_KEPT) : text);

export type Status = {
  enabled: boolean;
  surface: string | null;
  provider: ProviderResult;
  timeoutMs: number;
  /** The confidence a switch must clear, or null when stickiness is off. */
  sticky: number | null;
  /** The most an upgrade may cost over staying, or null for no limit. */
  upgradeMax?: number | null;
  /** The price checks: on, off, or absent on older callers. */
  price?: boolean;
  /** The most effort each tier may be asked for. */
  ceiling: Ceiling;
  /** Compaction by Jev: on, and the last one; absent on older callers. */
  compactOn?: boolean;
  compaction?: Compaction | null;
  /** Which prompt cache the session writes; the price of a switch depends on it. */
  ttl: Ttl;
  /** The context size the next turn would carry, or null before the first reply. */
  contextTokens: number | null;
  /** The main loop's model as `/model` shows it, or null when unknown. */
  sessionModel: string | null;
  /** What the main loop is running on, as the router last saw it; null when nothing yet. */
  running: Decision | null;
  offered: readonly Tier[];
  excluded: readonly Tier[];
  announce: boolean;
  attempts: readonly Attempt[];
  /** Dollars across every turn the router saw this session, at list price. */
  spent: number;
};

/**
 * What a switch is priced against: the context the turn carries, the output
 * it is likely to produce (the last turn's, or a typical one), and which
 * cache the session writes.
 */
type Economics = {
  contextTokens: number;
  outputTokens: number;
  ttl: Ttl;
  /** The running model's cache has expired (a resume after the TTL): staying is a write too. */
  cold?: boolean;
};

/**
 * What settles a main-loop turn beyond Jev's answer. `sticky` is the bar a
 * switch must clear, or null when switches are free; `running` what the last
 * routed turn ran on; `forced` a tier the prompt itself named, which takes
 * the tier question away from Jev and from stickiness both; `ceiling` the
 * most effort each tier may be asked for; `economics` what a downgrade is
 * priced against, absent when nothing is known about the context yet.
 */
type Hold = {
  sticky: number | null;
  running: Decision | null;
  forced?: Tier | null;
  ceiling?: Ceiling;
  economics?: Economics;
  /** The most an upgrade may cost over staying; null or absent for no limit. */
  upgradeMax?: number | null;
  /** The downgrade and upgrade price checks; absent reads as off. */
  price?: boolean;
};

/** A typical turn's output when the session has not produced one yet. */
export const TYPICAL_OUTPUT_TOKENS = 1500;

/**
 * One turn's outcome from Jev's answer, so the three ways a turn can fail to
 * route all land in one place and all get announced the same way.
 *
 * This is the only place a main-loop decision is settled: the route the
 * engine applies and the line /jev shows are the same object, so the two
 * cannot disagree. The order is the policy: a named tier first (it needs no
 * answer from Jev at all — effort defaults to medium), then stickiness on
 * the tier (Jev's doubt, or the price of a downgrade), then, for a turn that
 * stays on Sonnet, stickiness on the effort, then the tier's ceiling.
 */
export function attemptOf(
  text: string,
  result: JevResult,
  offered: readonly Tier[],
  hold: Hold = { sticky: null, running: null },
): Attempt {
  const summary = notificationOf(text);
  const head =
    summary === null
      ? { prompt: kept(text) }
      : { prompt: kept(summary), kind: "notify" as const };
  const forced = hold.forced ?? null;

  if (!result.ok && forced === null) {
    // No answer from Jev: stay on the tier already running rather than drop
    // to the session model, which could be a cold cache and a switch back
    // afterwards. With nothing running, or nothing that fits, the turn is
    // left to the session model as before.
    // Only a tier Jev actually routed: a placeholder seeded from the
    // session model (no key, nothing routed yet) is the session model.
    if (hold.running !== null && hold.running.effortConfidence !== undefined) {
      const stay = continuationOf(
        text,
        hold.running,
        hold.ceiling ?? ceilingAt("max"),
        hold.economics?.contextTokens ?? null,
        offered,
      );
      if ("decision" in stay)
        return {
          ...head,
          ms: result.ms,
          decision: { ...stay.decision, confidence: 0, jevFailed: result.reason },
        };
    }
    return { ...head, ms: result.ms, skipped: result.reason };
  }

  const fresh = result.ok ? decisionOf(result.answers, offered) : null;
  let decision = forced !== null ? forcedDecision(forced, fresh) : fresh;
  if (!decision) {
    return {
      ...head,
      ms: result.ms,
      skipped: "Jev answered but named no tier we offered",
    };
  }
  // First of all, can the tier take a prompt this long? Haiku's window is
  // 200k; a turn carrying more is refused by the API, forced or not.
  if (hold.economics !== undefined) {
    const fits = withinWindow(
      decision,
      hold.running,
      hold.economics.contextTokens,
    );
    if (fits === null) {
      // Neither Jev's pick nor what is running takes a context this long
      // (haiku past its window, Jev saying haiku again). Rather than leave
      // the turn to whatever the session model is, go up only as far as the
      // context needs.
      // With nothing known to be running, the session model holds the warm
      // cache, and staying there is cheaper than a cold write anywhere.
      const step =
        hold.running === null
          ? null
          : stepUp(decision.tier, TIERS.at(-1)!, offered, hold.economics.contextTokens);
      if (step === null) {
        return {
          ...head,
          ms: result.ms,
          skipped:
            `too long for ${decision.tier} (${kOf(hold.economics.contextTokens)})`,
        };
      }
      return {
        ...head,
        ms: result.ms,
        decision: capTo(
          {
            tier: step,
            model: MODEL_OF[step],
            effort: decision.effort,
            confidence: decision.confidence,
            ...(decision.effortConfidence !== undefined
              ? { effortConfidence: decision.effortConfidence }
              : {}),
            ...(decision.probabilities !== undefined
              ? { probabilities: decision.probabilities }
              : {}),
            outgrew: hold.running?.tier ?? decision.tier,
            ...(decision.tier !== (hold.running?.tier ?? decision.tier)
              ? { wanted: decision.tier }
              : {}),
            ...(decision.forced ? { forced: true as const } : {}),
          },
          hold.ceiling ?? ceilingAt("max"),
        ),
      };
    }
    if (fits.heldWindow !== undefined) {
      // Held on the running tier: on Sonnet an effort change still rewrites
      // much of the cache, so the effort gate applies here as well.
      const held =
        !fits.forced &&
        hold.sticky !== null &&
        hold.running !== null &&
        hold.running.effortConfidence !== undefined &&
        holdsSonnetEffort(fits, hold.running, hold.sticky)
          ? { ...fits, effort: hold.running.effort, heldEffort: fits.effort }
          : fits;
      return {
        ...head,
        ms: result.ms,
        decision: capTo(held, hold.ceiling ?? ceilingAt("max")),
      };
    }
  }
  // What Jev (or the prompt) picked, before any hold: what a hold that does
  // not fit gives way to.
  const picked: Decision | null = decision;
  const priced = hold.price === true;
  if ((hold.sticky !== null || priced) && !decision.forced) {
    const running = hold.running;
    const downgrade =
      running !== null && isDowngrade(running.tier, decision.tier);
    // The same rung on a different model — a session on `claude-opus-5`
    // that Jev keeps on opus — is a switch to a cold cache too, and priced
    // like a downgrade; there is no doubt to weigh, Jev agreed on the tier.
    const lateral =
      running !== null &&
      running.tier === decision.tier &&
      running.model !== decision.model;
    const fromPrice =
      running !== null ? (priceOfModel(running.model) ?? PRICE[running.tier]) : null;
    const upgrade =
      running !== null && !downgrade && !lateral && running.tier !== decision.tier;
    const verdict =
      !priced || running === null || fromPrice === null || hold.economics === undefined
        ? null
        : downgrade || lateral
          ? switchVerdict(
              running.tier,
              decision.tier,
              hold.economics.contextTokens,
              hold.economics.outputTokens,
              hold.economics.ttl,
              fromPrice,
              hold.economics.cold === true,
            )
          : upgrade && hold.upgradeMax != null
            ? upgradeVerdict(
                running.tier,
                decision.tier,
                hold.economics.contextTokens,
                hold.economics.outputTokens,
                hold.upgradeMax,
                hold.economics.ttl,
                fromPrice,
                hold.economics.cold === true,
              )
            : null;
    // An upgrade writes the whole context to the dearer tier; past 100k it
    // has to be surer than the bar.
    // Sticky off: no confidence bar, the price checks stand on their own.
    const bar =
      lateral || hold.sticky === null
        ? 0
        : !downgrade && hold.economics !== undefined
          ? upgradeBar(hold.sticky, hold.economics.contextTokens)
          : hold.sticky;
    decision = stickyDecision(decision, running, bar, verdict);
  }
  // A forced turn named its tier; effort comes from Jev when it was asked,
  // otherwise medium. The Sonnet effort gate does not get a vote here.
  if (
    !decision.forced &&
    hold.sticky !== null &&
    hold.running !== null &&
    // A placeholder for what a session runs on carries no effort Jev
    // chose; there is nothing to hold to.
    hold.running.effortConfidence !== undefined &&
    holdsSonnetEffort(decision, hold.running, hold.sticky)
  ) {
    decision = {
      ...decision,
      effort: hold.running.effort,
      heldEffort: decision.effort,
    };
  }
  // A hold must fit too: holding to haiku at 190k would send the turn where
  // the API refuses it. Jev's pick passed the check above, so the hold gives
  // way to it.
  if (
    hold.economics !== undefined &&
    decision.held !== undefined &&
    !fitsWindow(decision.tier, hold.economics.contextTokens) &&
    picked !== null
  ) {
    // The tier the hold kept is outgrown, but what held the move (doubt,
    // or an upgrade over the limit) still stands: go up only as far as the
    // context needs, the cheapest tier that fits, not all the way to Jev's
    // pick. When that is Jev's pick, it runs as picked.
    const held = decision;
    const step = stepUp(held.tier, picked.tier, offered, hold.economics.contextTokens, true);
    if (step === null || step === picked.tier) {
      decision = picked;
    } else {
      // What held the move priced haiku against Jev's pick; neither figure
      // describes the step, so the line says what happened instead.
      const { heldCost: _c, heldBar: _b, heldWindow: _w, held: _h, heldModel: _m, ...rest } = held;
      void _c, _b, _w, _h, _m;
      decision = { ...rest, tier: step, model: MODEL_OF[step], outgrew: held.tier, wanted: picked.tier };
    }
  }
  decision = capTo(decision, hold.ceiling ?? ceilingAt("max"));
  return { ...head, ms: result.ms, decision };
}

/**
 * A bare go-ahead's outcome: the previous turn's decision, carried over as
 * is. `held` and the like are dropped, since they described that turn's
 * choice, not this one's; the `continue` tag says what happened here. The
 * ceiling is re-applied so a change mid-session still binds.
 */
export function continuationOf(
  text: string,
  running: Decision,
  ceiling: Ceiling = ceilingAt("max"),
  contextTokens: number | null = null,
  offered: readonly Tier[] = TIERS,
): Attempt {
  const { tier, model, effort, confidence, effortConfidence } = running;
  if (contextTokens !== null && !fitsWindow(tier, contextTokens)) {
    const step = stepUp(tier, TIERS.at(-1)!, offered, contextTokens);
    if (step === null)
      return {
        prompt: kept(text),
        ms: 0,
        kind: "continue",
        skipped: `too long for ${tier} (${kOf(contextTokens)})`,
      };
    return {
      prompt: kept(text),
      ms: 0,
      kind: "continue",
      decision: capTo(
        { tier: step, model: MODEL_OF[step], effort, confidence, effortConfidence, outgrew: tier },
        ceiling,
      ),
    };
  }
  return {
    prompt: kept(text),
    ms: 0,
    kind: "continue",
    decision: capTo(
      { tier, model, effort, confidence, effortConfidence },
      ceiling,
    ),
  };
}

/**
 * A bare go-ahead when there is nothing safe to continue (first turn, or the
 * previous turn was unrouted / routing was off). Jev must not be asked: it
 * grades these as trivial at ~1.00 and would clear any sticky bar. The turn
 * stays on the session model.
 */
export function continuationSkipped(text: string): Attempt {
  return {
    prompt: kept(text),
    ms: 0,
    kind: "continue",
    skipped: "nothing to continue",
  };
}

/**
 * A spawned subagent's outcome from Jev's answer to its task. No stickiness
 * and no forcing: a subagent starts with an empty conversation, so there is
 * no cache to hold to, and the tier named in the person's prompt was for the
 * main loop. What there is instead is a confidence floor (`SUBAGENT_CONFIDENCE`),
 * below which the spawn is left on the model it would have had anyway.
 */
export function spawnAttemptOf(
  description: string,
  result: JevResult,
  offered: readonly Tier[],
  agent: AgentTag,
  ceiling: Ceiling = ceilingAt("max"),
): Attempt {
  const head = { prompt: kept(description), kind: "agent" as const, agent };
  if (!result.ok) return { ...head, ms: result.ms, skipped: result.reason };
  const fresh = decisionOf(result.answers, offered);
  if (!fresh) {
    return {
      ...head,
      ms: result.ms,
      skipped: "Jev answered but named no tier we offered",
    };
  }
  const decision = subagentDecision(fresh);
  if (!decision) {
    return {
      ...head,
      ms: result.ms,
      skipped: `Jev ${pct(fresh.confidence)} on ${fresh.tier}, needs ${pct(SUBAGENT_CONFIDENCE)}`,
    };
  }
  return { ...head, ms: result.ms, decision: capTo(decision, ceiling) };
}

/** The last few turns, newest first, so the report stays one screen. */
export const HISTORY_LIMIT = 5;

function shorten(text: string, width = 44): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/**
 * `Jev 57%`: how sure Jev was of the tier. Empty when Jev was not asked this
 * turn: a named tier, a go-ahead, or the engine's nudge.
 */
function sureOf(d: Decision, kind?: Attempt["kind"]): string {
  if (kind === "continue" || kind === "nudge") return "";
  if (d.forced && d.confidence === 0) return "";
  if (d.jevFailed !== undefined) return "";
  return `Jev ${pct(d.confidence)}`;
}

/** `opus-5-5` for `claude-opus-5-5-20260901`: the id without its prefix and date. */
function shortModel(model: string): string {
  // A usage record without a model id must not throw inside turn.step.
  if (typeof model !== "string" || model === "") return "unknown model";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function attemptLine(attempt: Attempt): string {
  const when = `${String(attempt.ms).padStart(4)}ms`;
  const origin = originOf(attempt);
  const what = `${origin ? `[${origin}] ` : ""}${shorten(attempt.prompt)}`;
  if ("skipped" in attempt) {
    // A subagent's row names the agent first, then why: "under the bar"
    // and "Jev timed out" are different stories.
    return attempt.kind === "agent"
      ? `  ${when}  not routed — ${what} · ${attempt.skipped}`
      : `  ${when}  not routed — ${attempt.skipped}`;
  }
  const d = attempt.decision;
  // A held turn's reason carries the confidence; saying it twice is noise.
  const notes = [
    ...(d.held === undefined ? [sureOf(d, attempt.kind)] : []),
    ...reasonsOf(attempt),
  ].filter((n) => n !== "");
  return `  ${when}  ${d.tier}·${d.effort}  ${notes.join("; ")}  ${what}`;
}

/** Thousands or millions, rounded, for token counts: 130k, 2k, 3.3M. */
function kOf(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * `fable-5-1 ✓`: the model the API says answered, and whether it is the one
 * the router asked for (a dated id still counts). A different model is the
 * one case worth looking at: `sonnet-5 ⚠ asked opus-5-5`.
 */
function answeredBy(attempt: Attempt): string {
  const usage = attempt.usage!;
  const got = shortModel(usage.model);
  if (!("decision" in attempt)) return got;
  const asked = attempt.decision.model;
  return sameModel(asked, usage.model)
    ? `${got} ✓`
    : `${got} ⚠ asked ${shortModel(asked)}`;
}

/**
 * Whether the model the API reports is the one asked for: the same id, give
 * or take the engine's `[1m]` and a trailing date. `claude-opus-5-5` does not
 * confirm `claude-opus-5`, although one begins with the other.
 */
function sameModel(asked: string, got: unknown): boolean {
  if (typeof got !== "string") return false;
  const base = baseModel(asked);
  return (
    got === asked ||
    got === base ||
    (got.startsWith(base) && /^-\d{8}$/.test(got.slice(base.length)))
  );
}

/** `$0.50 · 47k in (49% cached) · 0k out`. */
function costPhrase(usage: Usage, cost: number | undefined): string {
  const parts = [];
  if (cost !== undefined) parts.push(usd(cost));
  parts.push(
    `${kOf(carriedOf(usage))} in (${Math.round(cacheRatio(usage) * 100)}% cached)`,
    `${kOf(usage.output_tokens)} out`,
  );
  return parts.join(" · ");
}

/**
 * The line under a turn in /jev saying what the API reports actually
 * answered, and what the requests carried. This is the intrinsic check: the
 * route line is what we asked for; this is what we got.
 */
function usageLine(attempt: Attempt): string | null {
  if (!attempt.usage) return null;
  return `          → ${answeredBy(attempt)} · ${costPhrase(attempt.usage, attempt.cost)}`;
}

/**
 * The summary under a finished reply: one block for everything the reply
 * took, however many turns it spanned. A reply that spawns background work
 * is several turns — the one you typed, then one per task that finished and
 * woke the loop — and a block under each read as one reply changing model
 * three times. So the turns are gathered and written once, at the end.
 *
 * Two lines as a rule: what answered and what it cost, then why it did not
 * run as Jev asked, when it did not.
 *
 *   fable-5-1 ✓ xhigh · Jev 97% · $0.14 · 130k in (91% cached) · 2k out
 *   kept fable: haiku costs $4.41 vs $0.13
 *
 * Fenced, because markdown collapses leading whitespace and joins
 * consecutive lines into one paragraph: unfenced, the rows would render as
 * a single run-on.
 */
export function replySummary(turns: readonly Attempt[]): string | null {
  const main = turns.filter((t) => t.kind !== "agent");
  const agents = turns.filter((t) => t.kind === "agent");
  const priced = turns.filter((t) => t.usage !== undefined);
  if (main.length === 0 || priced.length === 0) return null;

  const rows: string[] = [];
  const head: string[] = [];

  // What answered.
  if (main.length === 1) {
    const only = main[0]!;
    if ("decision" in only) {
      const d = only.decision;
      head.push(
        `${only.usage ? answeredBy(only) : shortModel(d.model)} ${d.effort}`,
      );
      // How the tier was settled, always in this spot: Jev's confidence, the
      // prompt's own pick, or a go-ahead carrying the last one on.
      const how = d.forced
        ? "your pick"
        : only.kind === "continue" || only.kind === "nudge"
          ? "continuing"
          : sureOf(d, only.kind);
      if (how !== "") head.push(how);
    } else {
      head.push(only.usage ? answeredBy(only) : "session model");
      head.push(`not routed: ${only.skipped}`);
    }
  } else {
    const legs = main.map((t) =>
      "decision" in t
        ? `${t.decision.tier}${t.usage && !answeredBy(t).endsWith("✓") ? " ⚠" : ""}`
        : "session",
    );
    const woken = main.filter((t) => t.kind === "notify").length;
    const nudged = main.filter((t) => t.kind === "nudge").length;
    const because = [
      ...(woken > 0 ? [`${woken} woken by tasks`] : []),
      ...(nudged > 0 ? [`${nudged} nudged`] : []),
    ];
    head.push(
      `${main.length} turns: ${legs.join(", ")}` +
        (because.length > 0 ? ` (${because.join(", ")})` : ""),
    );
  }

  // The whole reply's cost.
  const sum = priced.reduce(
    (acc, t) => {
      const u = t.usage!;
      acc.input += u.input_tokens;
      acc.read += u.cache_read_input_tokens;
      acc.write += u.cache_creation_input_tokens;
      acc.output += u.output_tokens;
      if (t.cost !== undefined) acc.cost += t.cost;
      else acc.unpriced = true;
      return acc;
    },
    { input: 0, read: 0, write: 0, output: 0, cost: 0, unpriced: false },
  );
  const carried = sum.input + sum.read + sum.write;
  const cached = carried === 0 ? 0 : Math.round((100 * sum.read) / carried);
  if (!sum.unpriced) head.push(usd(sum.cost));
  head.push(`${kOf(carried)} in (${cached}% cached)`, `${kOf(sum.output)} out`);
  rows.push(head.join(" · "));

  // What its agents ran on and cost.
  if (agents.length > 0) {
    const legs = agents.map((a) => {
      const name = a.agent?.type ?? "agent";
      // What ran it: the model the API reported, else the tier routed to.
      const on = a.usage
        ? shortModel(a.usage.model)
        : "decision" in a
          ? a.decision.tier
          : "its own model";
      return `${name} ${on}${a.cost !== undefined ? ` ${usd(a.cost)}` : ""}`;
    });
    rows.push(`agents: ${legs.join(", ")}`);
  }

  // Why a turn did not run exactly as Jev asked.
  // (How the tier was settled is on the first line already; a multi-turn
  // reply counts its wake-ups and nudges there.)
  main.forEach((t, i) => {
    const why = reasonsOf(t).filter((r) => r !== "your pick");
    if (why.length === 0) return;
    rows.push(`${main.length > 1 ? `turn ${i + 1}: ` : ""}${why.join("; ")}`);
  });

  return ["```", ...rows, "```"].join("\n");
}

/** `medium for all`, or `medium (opus: xhigh, fable: xhigh)`. */
export function ceilingLine(ceiling: Ceiling): string {
  const counts = new Map<string, number>();
  for (const tier of TIERS)
    counts.set(ceiling[tier], (counts.get(ceiling[tier]) ?? 0) + 1);
  let common = ceiling.haiku;
  for (const tier of TIERS) {
    const effort = ceiling[tier];
    if ((counts.get(effort) ?? 0) > (counts.get(common) ?? 0)) common = effort;
  }
  const rest = TIERS.filter((t) => ceiling[t] !== common).map(
    (t) => `${t}: ${ceiling[t]}`,
  );
  return rest.length === 0
    ? `${common} for all`
    : `${common} (${rest.join(", ")})`;
}

/**
 * The report, as plain lines. Written so the first three tell you whether
 * the thing is on at all, which is the question that brings people here.
 */
export function statusReport(status: Status): string {
  // The engine prefixes the plugin's name; a header here said it twice.
  const lines: string[] = [""];

  lines.push(`  routing   ${status.enabled ? "on" : "off (/jev on)"}`);
  lines.push(`  surface   ${status.surface ?? "unknown"}`);

  if (status.provider.ok) {
    const key =
      status.provider.name === "typesafe"
        ? "TYPESAFE_API_KEY"
        : "AI_GATEWAY_API_KEY";
    lines.push(
      `  provider  ${status.provider.name} · ${key} is set · ${status.provider.model}`,
    );
  } else {
    lines.push(`  provider  NO KEYS — nothing will route`);
  }

  lines.push(`  budget    ${status.timeoutMs}ms`);
  lines.push(
    `  sticky    ${
      status.sticky === null
        ? "off (JEV_ROUTER_STICKY=0)"
        : `on, switch needs ${pct(status.sticky)} ` +
          `(${pct(upgradeBar(status.sticky, UPGRADE_CONTEXT_TOKENS))} up past ` +
          `${kOf(UPGRADE_CONTEXT_TOKENS)})`
    }`,
  );
  if (status.price !== undefined)
    lines.push(
      `  price     ${
        status.price
          ? "on, a downgrade has to pay" +
            (status.upgradeMax != null
              ? `, an upgrade may cost ${usd(status.upgradeMax)} over staying`
              : "")
          : "off (/jev price on)"
      }`,
    );
  lines.push(`  ceiling   ${ceilingLine(status.ceiling)}`);
  if (status.compactOn !== undefined)
    lines.push(
      `  compact   ${
        status.compactOn
          ? `on, Jev prunes tool calls${status.compaction ? ` · last: ${compactionLine(status.compaction)}` : ""}`
          : "off (/jev compact on)"
      }`,
    );
  lines.push(`  session   ${sessionLine(status)}`);
  lines.push(`  cache     ${cacheLine(status)}`);
  lines.push(`  tiers     ${status.offered.join(", ")}`);
  lines.push(
    `  announce  ${status.announce ? "on, a line per turn" : "off (/jev loud)"}`,
  );
  if (status.excluded.length > 0) {
    lines.push(`  excluded  ${status.excluded.join(", ")}`);
  }
  if (status.spent > 0) lines.push(`  spent     ${usd(status.spent)} this session`);

  lines.push("");
  if (status.attempts.length === 0) {
    lines.push("  No turns yet. Send a prompt, then run /jev again.");
    return lines.join("\n");
  }

  lines.push("  Recent turns, newest first:");
  for (const attempt of status.attempts) {
    lines.push(attemptLine(attempt));
    const usage = usageLine(attempt);
    if (usage !== null) lines.push(usage);
  }

  return lines.join("\n");
}

/** `claude-opus-5, running on fable` — the session's model and what is warm. */
function sessionLine(status: Status): string {
  const model = status.sessionModel ?? "unknown";
  if (status.running === null) return `${model}, nothing routed yet`;
  return status.running.model === model
    ? `${model}, still on it`
    : `${model}, running on ${status.running.tier}`;
}

/**
 * `1h writes · 201k context · fable→haiku pays below 3k`: which cache the
 * session writes, what the next turn carries, and where the cheapest
 * downgrade from the running tier stops paying, so a hold is predictable.
 */
function cacheLine(status: Status): string {
  const parts = [`${status.ttl} writes`];
  if (status.contextTokens === null) return `${parts[0]} · no context yet`;
  parts.push(`${kOf(status.contextTokens)} context`);
  const running = status.running;
  if (running !== null) {
    const from = running.tier;
    const to = TIERS.find((t) => isDowngrade(from, t));
    if (to !== undefined) {
      const last = status.attempts.find((a) => "decision" in a && a.usage);
      const out = Math.min(
        last?.usage?.output_tokens ?? TYPICAL_OUTPUT_TOKENS,
        TYPICAL_OUTPUT_TOKENS,
      );
      const be = breakEvenTokens(
        from,
        to,
        out,
        status.ttl,
        priceOfModel(running.model) ?? PRICE[from],
      );
      parts.push(
        be === 0
          ? `${from}→${to} never pays`
          : `${from}→${to} pays below ${be < 1000 ? "1k" : kOf(be)}`,
      );
    }
  }
  return parts.join(" · ");
}

/** The reply to `/jev on`, `/jev off` and anything unrecognised. */
export function toggleReply(enabled: boolean): string {
  return enabled
    ? "Jev routing on. The next turn picks its own model."
    : "Jev routing off. Turns run on the session model.";
}

/**
 * The line put at the top of each reply, as markdown.
 *
 * Markdown, because the line rides in the reply's own text and that is what
 * the transcript renders. A blockquote sets it off from prose with a rail
 * and dimmer text. Neither a render hook nor `$.ui.log` drew anything in the
 * desktop app, so this is the styling that is actually available.
 *
 *   > ✳️ fable · xhigh · Jev 57% · 324ms
 *   > ✳️ fable · low · kept fable: haiku costs $1.02 vs $0.020 · 352ms
 *   > ⚠️ not routed: typesafe said HTTP 401
 */
export function liveLine(attempt: Attempt): string {
  if ("skipped" in attempt) {
    return `> ⚠️ not routed: ${attempt.skipped}`;
  }
  const d = attempt.decision;
  const parts = [
    d.tier,
    d.effort,
    ...(d.held === undefined ? [sureOf(d, attempt.kind)] : []),
    ...reasonsOf(attempt),
    ...(originOf(attempt) ? [originOf(attempt)!] : []),
    `${attempt.ms}ms`,
  ].filter((p) => p !== "");
  return `> ✳️ ${parts.join(" · ")}`;
}

/**
 * The rule drawn under the line, closing it off from the reply.
 *
 * It needs the blank line before it: `---` on the line after text is a setext
 * heading underline, which would turn the route into a heading instead.
 */
export const REPLY_SEPARATOR = "\n\n---\n\n";

/**
 * What sits between the reply's last text and the summary. A blank line, so
 * the fence opens a block of its own instead of joining the last paragraph.
 */
export const FOOTER_SEPARATOR = "\n\n";

/** A route line the model wrote itself at the start of its text, with the rule under it. */
const IMITATED_LINE = /^> (?:✳️|⚠️) [^\n]*(?:\n+---(?:\n+|$)|\n+|$)/;

/**
 * A summary the model wrote itself at the end of its text: a fence whose
 * first line has the summary's shape, and nothing after the fence.
 */
const IMITATED_SUMMARY = /\n*```\n[^\n`]*\(\d+% cached\)[^\n`]*\n(?:[^\n`]*\n)*```\s*$/;

/**
 * The model's text without a route line or summary it wrote itself. Both
 * are in its past replies, so it copies them: seen 2026-09-23, a footer with
 * made-up figures ($0.21, 450k in) typed above the real one, which read as a
 * second copy of the plugin. Only the ends of the text are touched, so a
 * line or summary quoted in the middle of a reply stays.
 */
export function withoutImitations(text: string): string {
  return text.replace(IMITATED_LINE, "").replace(IMITATED_SUMMARY, "");
}

/** How a route line opens, for telling a partial one from ordinary text. */
const LINE_OPENERS = ["> ✳️ ", "> ⚠️ "];

/** The rule under a route line, after the line's own newline. */
const LINE_RULE = "\n---\n\n";

/** A summary's first line, once the fence has opened. */
const SUMMARY_HEAD = /^[^\n`]*\(\d+% cached\)/;

/**
 * `withoutImitations` for text that streams in pieces. The engine hands a
 * block's text over a few tokens at a time, so a copied line or summary is
 * spread across many chunks and no single one matches. This holds back only
 * what could still turn out to be one: the start of a block until its first
 * line is settled, and a fence until its first line shows whether it is a
 * summary (a summary fence is held to the end of the block). Everything else
 * passes straight through.
 *
 * Held text rides out on the latest held chunk, so the engine still gets a
 * chunk it streamed (with its `ref`) and the block's text stays whole.
 */
export class ImitationFilter<C extends { kind: "text"; index: number; text: string }> {
  private block = -1;
  private settled = false;
  private held = "";
  private carrier: C | null = null;

  /** A text piece in; the pieces to pass on now. */
  push(chunk: C): C[] {
    const out = chunk.index === this.block ? [] : this.end();
    if (chunk.index !== this.block) {
      this.block = chunk.index;
      this.settled = false;
    }
    this.held += chunk.text;
    this.carrier = chunk;
    const now = this.release(false);
    if (now !== "") out.push({ ...chunk, text: now });
    if (this.held === "") this.carrier = null;
    return out;
  }

  /** The block is over (another block, a non-text chunk, the end): what is still held. */
  end(): C[] {
    if (this.carrier === null) return [];
    const text = this.release(true);
    const carrier = this.carrier;
    this.carrier = null;
    return text === "" ? [] : [{ ...carrier, text }];
  }

  /** Takes what can go out now off `held`; with `final`, all of it. */
  private release(final: boolean): string {
    if (!this.settled) {
      const h = this.held;
      const opener = LINE_OPENERS.find((o) => h.startsWith(o));
      if (opener === undefined) {
        // Still possibly the start of a line: wait for more.
        if (!final && LINE_OPENERS.some((o) => o.startsWith(h))) return "";
      } else {
        const eol = h.indexOf("\n");
        if (eol === -1 && !final) return "";
        if (eol !== -1) {
          const rest = h.slice(eol + 1);
          // The rule under it may still be arriving.
          if (!final && LINE_RULE.startsWith(rest) && rest.length < LINE_RULE.length) return "";
        }
        this.held = h.replace(IMITATED_LINE, "");
      }
      this.settled = true;
    }
    if (final) {
      const all = this.held.replace(IMITATED_SUMMARY, "");
      this.held = "";
      return all;
    }
    const from = this.holdFrom(this.held);
    const now = this.held.slice(0, from);
    this.held = this.held.slice(from);
    return now;
  }

  /** Where text that could still be a summary starts; the length when none. */
  private holdFrom(text: string): number {
    for (let p = text.indexOf("```"); p !== -1; p = text.indexOf("```", p + 3)) {
      if (p > 0 && text[p - 1] !== "\n") continue;
      const after = text.slice(p + 3);
      if (!"\n".startsWith(after.slice(0, 1))) continue; // ```bash and the like
      if (after === "") return this.backToBlankLines(text, p);
      const eol = after.indexOf("\n", 1);
      const head = after.slice(1, eol === -1 ? undefined : eol);
      if (eol === -1 || SUMMARY_HEAD.test(head)) {
        if (eol === -1 && !/^[^\n`]*$/.test(head)) continue;
        // Closed, with text after it: quoted mid-reply, and it streams.
        const close = after.indexOf("\n```", eol);
        if (close !== -1 && /\S/.test(after.slice(close + 4))) continue;
        return this.backToBlankLines(text, p);
      }
    }
    // A fence may be starting at the very end.
    const tail = text.match(/(?:^|\n)`{1,2}$/);
    if (tail) return this.backToBlankLines(text, tail.index! + (tail[0].startsWith("\n") ? 1 : 0));
    // Trailing newlines wait for what follows: a fence after them would take
    // them with it.
    return this.backToBlankLines(text, text.length);
  }

  /** Holds the blank lines before a fence with it, so none dangle if it goes. */
  private backToBlankLines(text: string, p: number): number {
    while (p > 0 && text[p - 1] === "\n") p--;
    return p;
  }
}

/**
 * The reply to a `/jev` argument nothing reads. A removed toggle
 * (`/jev xhigh on`) is pointed at the ceiling that replaced it.
 */
export function unknownCommandReply(arg: string, legacy: boolean): string {
  const usage =
    "/jev (status), on, off, quiet, loud, sticky [off|0.6], price [on|off], " +
    "compact [on|off], ceiling <effort> [tiers], or an effort on its own (/jev xhigh fable).";
  return legacy
    ? `"/jev ${arg}" was one of the old effort toggles; the ceiling replaced them. ` +
        `Try /jev ceiling xhigh to allow up to xhigh, or /jev ceiling medium to cap there. ${usage}`
    : `"/jev ${arg}" is not a command. ${usage}`;
}

/** The reply to `/jev quiet` and `/jev loud`. */
export function announceReply(announce: boolean): string {
  return announce
    ? "Jev will announce each route in the transcript."
    : "Jev will route quietly. Run /jev to see what it has been doing.";
}

/**
 * Reads `/jev sticky`, `/jev sticky off`, `/jev sticky 0.6` and says what the
 * bar is now. `current` is the session's bar, or null when it is off.
 *
 * A bare `sticky` keeps a bar already set rather than resetting it to the
 * default, so turning it off and on again does not silently lose a tuned
 * value. A number that cannot be a confidence changes nothing and says so,
 * rather than falling back to the default: an unnoticed 0.75 is worse than a
 * refusal, since the point of the bar is knowing which one you are running.
 */
export function stickyCommand(
  rest: string,
  current: number | null,
): { sticky: number | null; text: string } {
  const arg = rest.trim().toLowerCase().replace(/%$/, "");

  if (arg === "off") {
    return {
      sticky: null,
      text: "No confidence bar: switches follow Jev, subject to the price checks (/jev price). /jev sticky brings the bar back.",
    };
  }

  if (arg === "" || arg === "on") {
    const bar = current ?? DEFAULT_STICKY_CONFIDENCE;
    return { sticky: bar, text: stuckAt(bar) };
  }

  const parsed = Number(arg);
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(parsed) || ratio <= 0 || ratio >= 1) {
    return {
      sticky: current,
      text:
        `"${rest.trim()}" is not a confidence. Give a number between 0 and 1 ` +
        "(0.6), or a percentage (60).",
    };
  }
  return { sticky: ratio, text: stuckAt(ratio) };
}

function stuckAt(bar: number): string {
  return (
    `Holding the tier until Jev is ${pct(bar)} sure of a switch, ` +
    "/jev sticky off removes the bar; the price checks are /jev price."
  );
}

/**
 * Reads `/jev ceiling`, `/jev ceiling xhigh`, `/jev ceiling xhigh fable opus`,
 * `/jev ceiling off`. A bare `ceiling` reports; an effort sets it on every
 * tier, or on the tiers named after it; `off` lifts every cap (which is max).
 * An unreadable effort or tier changes nothing and says so.
 */
export function ceilingCommand(
  rest: string,
  current: Ceiling,
): { ceiling: Ceiling; text: string } {
  const parts = rest.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { ceiling: current, text: ceilingReply(current) };
  }
  const effort = effortNamed(parts[0] ?? "");
  if (effort === null) {
    return {
      ceiling: current,
      text:
        `"${parts[0]}" is not an effort. Use ${EFFORTS.join(", ")} ` +
        "or off; /jev ceiling xhigh fable raises one tier.",
    };
  }
  const names = parts.slice(1);
  const unknown = names.filter((n) => !(TIERS as string[]).includes(n));
  if (unknown.length > 0) {
    return {
      ceiling: current,
      text:
        `"${unknown.join(", ")}" ${unknown.length === 1 ? "is" : "are"} not ` +
        `a tier. Use ${TIERS.join(", ")}.`,
    };
  }
  const next = withCeiling(
    current,
    effort,
    names.length === 0 ? TIERS : (names as Tier[]),
  );
  return { ceiling: next, text: ceilingReply(next) };
}

function ceilingReply(ceiling: Ceiling): string {
  return (
    `Effort ceiling: ${ceilingLine(ceiling)}. Jev's pick above it is capped ` +
    "and the line says what it wanted. /jev ceiling xhigh raises every " +
    "tier, /jev ceiling xhigh fable one, /jev ceiling off lifts them."
  );
}
