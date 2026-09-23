/**
 * What `/jev` prints. This is the router's only guaranteed-visible surface:
 * a command's output row draws on every surface, where a footer label may
 * not, so anything you need to be sure of belongs here.
 */

import type { JevResult } from "./jev.ts";
import { LOW_CONFIDENCE } from "./label.ts";
import {
  capTo,
  ceilingAt,
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
  type Ceiling,
  type Decision,
  type Tier,
} from "./policy.ts";
import {
  breakEvenTokens,
  isDowngrade,
  switchVerdict,
  usageCost,
  usd,
  type Ttl,
} from "./pricing.ts";
import type { ProviderResult } from "./provider.ts";

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
   * ran on the previous turn's decision without asking Jev.
   */
  kind?: "notify" | "agent" | "continue";
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

/**
 * The tags for a turn that did not run exactly as Jev asked: held on its
 * previous tier (`held:haiku`, with the two prices when it was the price
 * that held it: `held:haiku·$0.47>$0.06`), held on its previous Sonnet
 * effort (`held-effort:low`), forced to a tier the prompt named (`forced`),
 * and/or capped at the tier's ceiling (`capped:xhigh`). Stacked when more
 * than one applies.
 */
export function heldMark(attempt: Attempt): string | null {
  if (!("decision" in attempt)) return null;
  const { held, heldCost, heldEffort, forced, cappedEffort } =
    attempt.decision;
  const tags: string[] = [];
  if (held !== undefined) {
    tags.push(
      heldCost === undefined
        ? `held:${held}`
        : `held:${held}·${usd(heldCost.go)}>${usd(heldCost.stay)}`,
    );
  }
  if (heldEffort !== undefined) tags.push(`held-effort:${heldEffort}`);
  if (forced) tags.push("forced");
  if (cappedEffort !== undefined) tags.push(`capped:${cappedEffort}`);
  return tags.length > 0 ? tags.join(" · ") : null;
}

/** The short tag for a turn nobody typed: `notify`, `agent:Explore`, `agent`, `continue`. */
export function kindMark(
  attempt: Pick<Attempt, "kind" | "agent">,
): string | null {
  if (attempt.kind === "notify") return "notify";
  if (attempt.kind === "continue") return "continue";
  if (attempt.kind === "agent")
    return attempt.agent?.type ? `agent:${attempt.agent.type}` : "agent";
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

/**
 * Folds one step's usage into its turn: counts sum, the model is the last
 * step's, as the engine defines a turn's usage, and the dollars are re-priced
 * from the sum. Mutates, because the same object sits in the history and in
 * the by-turn lookup.
 */
export function addUsage(
  attempt: Attempt,
  usage: Usage,
  ttl: Ttl = "1h",
): void {
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
  const cost = usageCost(attempt.usage.model, attempt.usage, ttl);
  if (cost === null) delete attempt.cost;
  else attempt.cost = cost;
}

/**
 * How much of what the turn's requests carried was read from cache, 0 to 1.
 * Everything carried is uncached input plus cache reads plus cache writes;
 * this is the cost-relevant measure, since reads bill at a tenth.
 */
export function cacheRatio(usage: Usage): number {
  const carried =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
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

export type Status = {
  enabled: boolean;
  surface: string | null;
  provider: ProviderResult;
  timeoutMs: number;
  /** The confidence a switch must clear, or null when stickiness is off. */
  sticky: number | null;
  /** The most effort each tier may be asked for. */
  ceiling: Ceiling;
  /** Which prompt cache the session writes; the price of a switch depends on it. */
  ttl: Ttl;
  /** The context size the next turn would carry, or null before the first reply. */
  contextTokens: number | null;
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
export type Economics = {
  contextTokens: number;
  outputTokens: number;
  ttl: Ttl;
};

/**
 * What settles a main-loop turn beyond Jev's answer. `sticky` is the bar a
 * switch must clear, or null when switches are free; `running` what the last
 * routed turn ran on; `forced` a tier the prompt itself named, which takes
 * the tier question away from Jev and from stickiness both; `ceiling` the
 * most effort each tier may be asked for; `economics` what a downgrade is
 * priced against, absent when nothing is known about the context yet.
 */
export type Hold = {
  sticky: number | null;
  running: Decision | null;
  forced?: Tier | null;
  ceiling?: Ceiling;
  economics?: Economics;
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
      ? { prompt: text }
      : { prompt: summary, kind: "notify" as const };
  const forced = hold.forced ?? null;

  if (!result.ok && forced === null)
    return { ...head, ms: result.ms, skipped: result.reason };

  const fresh = result.ok ? decisionOf(result.answers, offered) : null;
  let decision = forced !== null ? forcedDecision(forced, fresh) : fresh;
  if (!decision) {
    return {
      ...head,
      ms: result.ms,
      skipped: "Jev answered but named no tier we offered",
    };
  }
  if (hold.sticky !== null && !decision.forced) {
    const running = hold.running;
    const downgrade =
      running !== null && isDowngrade(running.tier, decision.tier);
    const verdict =
      downgrade && hold.economics !== undefined
        ? switchVerdict(
            running.tier,
            decision.tier,
            hold.economics.contextTokens,
            hold.economics.outputTokens,
            hold.economics.ttl,
          )
        : null;
    // An upgrade writes the whole context to the dearer tier; past 100k it
    // has to be surer than the bar. A downgrade is priced instead.
    const bar =
      !downgrade && hold.economics !== undefined
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
    holdsSonnetEffort(decision, hold.running, hold.sticky)
  ) {
    decision = {
      ...decision,
      effort: hold.running.effort,
      heldEffort: decision.effort,
    };
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
): Attempt {
  const { tier, model, effort, confidence, effortConfidence } = running;
  return {
    prompt: text,
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
    prompt: text,
    ms: 0,
    kind: "continue",
    skipped: "go-ahead with nothing to continue; left on session model",
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
  const head = { prompt: description, kind: "agent" as const, agent };
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
      skipped: `${fresh.tier} at ${fresh.confidence.toFixed(2)}, under the ${SUBAGENT_CONFIDENCE} bar; left on its own model`,
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

function attemptLine(attempt: Attempt): string {
  const when = `${String(attempt.ms).padStart(4)}ms`;
  const mark = kindMark(attempt);
  const what = `${mark ? `[${mark}] ` : ""}${shorten(attempt.prompt)}`;
  if ("skipped" in attempt) {
    // A subagent's row names the agent first, then why: "under the bar"
    // and "Jev timed out" are different stories.
    return attempt.kind === "agent"
      ? `  ${when}  unrouted — ${what} · ${attempt.skipped}`
      : `  ${when}  unrouted — ${attempt.skipped}`;
  }
  const { tier, effort, confidence } = attempt.decision;
  // A held turn is low-confidence by construction, so saying both is noise;
  // the hold is the more useful of the two.
  const held = heldMark(attempt);
  const doubt = held ?? (confidence < LOW_CONFIDENCE ? "(low confidence)" : "");
  return `  ${when}  ${tier}·${effort} ${confidence.toFixed(2)}${doubt ? ` ${doubt}` : ""}  ${what}`;
}

/** Thousands, rounded, for token counts: 130k, 2k, 0k. */
function kOf(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

/** `cache 83% · 214k in · 2k out · $0.14`, the dollars when the model has a price. */
function costOf(attempt: Attempt, sep: string): string {
  const usage = attempt.usage!;
  const parts = [
    `cache ${Math.round(cacheRatio(usage) * 100)}%`,
    `${kOf(carriedOf(usage))} in`,
    `${kOf(usage.output_tokens)} out`,
  ];
  if (attempt.cost !== undefined) parts.push(usd(attempt.cost));
  return parts.join(sep);
}

/**
 * The line under a turn saying what the API reports actually answered, and
 * what the requests carried. This is the intrinsic check: the route line is
 * what we asked for; this is what we got.
 *
 * A dated id (`claude-opus-5-20260901`) still confirms `claude-opus-5`. A
 * different model is marked `≠`, which is the one case worth looking at.
 */
function usageLine(attempt: Attempt): string | null {
  const usage = attempt.usage;
  if (!usage) return null;

  let verdict = "";
  if ("decision" in attempt) {
    const asked = attempt.decision.model;
    const matches =
      usage.model === asked || usage.model.startsWith(`${asked}-`);
    verdict = matches ? " ✓" : ` ≠ ${asked}`;
  }

  return `          answered ${usage.model}${verdict}  ${costOf(attempt, "  ")}`;
}

/**
 * The footer put at the end of a completed reply: what was asked for, and
 * what the API says answered.
 *
 * It goes at the end because `usage` only exists once the response is whole —
 * the stop chunk carries it. The route line at the top of the reply is the
 * immediate signal; this is the settled one.
 *
 * Fenced, because markdown collapses leading whitespace and joins consecutive
 * lines into one paragraph: unfenced, the rule and the two lines would render
 * as a single run-on. A fence keeps the alignment and reads as data, not prose.
 */
export function usageFooter(attempt: Attempt): string | null {
  const usage = attempt.usage;
  if (!usage) return null;

  const cost = costOf(attempt, " · ");

  let jev: string;
  let api: string;

  if ("decision" in attempt) {
    const { tier, effort, confidence, model: asked } = attempt.decision;
    const matches =
      usage.model === asked || usage.model.startsWith(`${asked}-`);
    const tags = [heldMark(attempt), kindMark(attempt)].filter(
      (t) => t !== null,
    );
    jev =
      `${tier}·${effort} · ${Math.round(confidence * 100)}%` +
      `${tags.map((t) => ` · ${t}`).join("")} · ${attempt.ms}ms`;
    api = `${usage.model}${matches ? " ✓" : ` ≠ ${asked}`} · ${cost}`;
  } else {
    jev = `unrouted — ${attempt.skipped}`;
    api = `${usage.model} · ${cost}`;
  }

  const rows = [`jev  ${jev}`, `api  ${api}`];
  // Count code points: the separators and check marks are multi-byte, and a
  // rule measured in UTF-16 units would overshoot the text it sits above.
  const width = Math.max(...rows.map((r) => [...r].length));
  return ["```", "─".repeat(width), ...rows, "```"].join("\n");
}

/**
 * `medium for all`, or `medium (opus: xhigh, fable: xhigh)`: the effort most
 * tiers share, then the exceptions in ladder order. A tie goes to the lower
 * tier's effort, so the line reads from the bottom of the ladder up.
 */
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
  const lines: string[] = ["jev-router"];

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
        : `on, switch needs ${Math.round(status.sticky * 100)}% ` +
          `(${Math.round(upgradeBar(status.sticky, UPGRADE_CONTEXT_TOKENS) * 100)}% up past ` +
          `${kOf(UPGRADE_CONTEXT_TOKENS)}), and a downgrade has to pay`
    }`,
  );
  lines.push(`  ceiling   ${ceilingLine(status.ceiling)}`);
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

/**
 * `1h writes · 201k context · fable→haiku pays below 6k`: which cache the
 * session writes, what the next turn carries, and where the cheapest
 * downgrade from the running tier stops paying, so a hold is predictable.
 */
function cacheLine(status: Status): string {
  const parts = [`${status.ttl} writes`];
  if (status.contextTokens === null) return `${parts[0]} · no context yet`;
  parts.push(`${kOf(status.contextTokens)} context`);
  const running = status.attempts.find((a) => "decision" in a);
  if (running !== undefined && "decision" in running) {
    const from = running.decision.tier;
    const to = TIERS.find((t) => isDowngrade(from, t));
    if (to !== undefined) {
      const out = running.usage?.output_tokens ?? TYPICAL_OUTPUT_TOKENS;
      const be = breakEvenTokens(from, to, out, status.ttl);
      parts.push(
        be === 0
          ? `${from}→${to} never pays`
          : `${from}→${to} pays below ${kOf(be)}`,
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
 * and dimmer text; the tier is inline code, which the theme colours. Neither
 * a render hook nor `$.ui.log` drew anything in the desktop app, so this is
 * the styling that is actually available.
 */
export function liveLine(attempt: Attempt): string {
  if ("skipped" in attempt) {
    return `> ⚠️ \`unrouted\` · ${attempt.skipped}`;
  }

  const { tier, effort, confidence } = attempt.decision;
  const held = heldMark(attempt);
  const doubt = held === null && confidence < LOW_CONFIDENCE ? "?" : "";
  const pct = Math.round(confidence * 100);
  const tags = [held, kindMark(attempt)].filter((t) => t !== null);
  return (
    `> ✳️ \`${tier}\` · ${effort} · ${pct}${"%"}${doubt}` +
    `${tags.map((t) => ` · ${t}`).join("")} · ${attempt.ms}ms`
  );
}

/**
 * The rule drawn under the line, closing it off from the reply.
 *
 * It needs the blank line before it: `---` on the line after text is a setext
 * heading underline, which would turn the route into a heading instead.
 */
export const REPLY_SEPARATOR = "\n\n---\n\n";

/**
 * What sits between the reply's last text and the footer. A blank line, so
 * the fence opens a block of its own instead of joining the last paragraph.
 */
export const FOOTER_SEPARATOR = "\n\n";

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
      text: "Switching freely again. /jev sticky holds a shaky switch.",
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
    `Holding the tier until Jev is ${Math.round(bar * 100)}% sure of a switch, ` +
    "and holding a downgrade that costs more than it saves. " +
    "/jev sticky off to switch freely."
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
    "and tagged capped:<what it wanted>. /jev ceiling xhigh raises every " +
    "tier, /jev ceiling xhigh fable one, /jev ceiling off lifts them."
  );
}
