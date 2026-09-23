/**
 * What a turn costs, and what a switch would cost, in dollars.
 *
 * Prices are Anthropic's public list, per million tokens, read from
 * platform.claude.com/docs/en/about-claude/pricing on PRICE_DATE. A cache
 * read is a tenth of input on most models, a fortieth on Fable 5.1 and a
 * twentieth on Opus 5.5; a cache write is 1.25× input for the five-minute
 * cache and 2× for the one-hour one. Claude Code writes the one-hour cache
 * (every one of 18,204 writes in a week of this machine's transcripts), so
 * that is the default here.
 *
 * Nothing here touches the engine or the network.
 */

import type { Tier } from "./policy.ts";

export const PRICE_DATE = "2026-09-23";

/** Dollars per million tokens. */
export type Price = {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
};

export type Ttl = "5m" | "1h";

/** The ladder's models. */
export const PRICE: Record<Tier, Price> = {
  haiku: { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 },
  sonnet: { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
  opus: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  fable: { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
};

/**
 * Models the session may run on that are not on the ladder, so an unrouted
 * turn's cost is still right. Matched by prefix of the id the API reports.
 */
const OTHER_PRICE: readonly (readonly [string, Price])[] = [
  ["claude-opus-5-5", PRICE.opus],
  ["claude-opus-5", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  ["claude-opus-4", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  ["claude-sonnet-5", PRICE.sonnet],
  ["claude-sonnet-4", { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 }],
  ["claude-haiku-4", PRICE.haiku],
  ["claude-fable-5", PRICE.fable],
  ["claude-mythos-5", PRICE.fable],
];

/** The cache TTL from the environment; `1h` unless told `5m`. */
export function ttlOf(raw: string | undefined): Ttl {
  return (raw ?? "").trim().toLowerCase() === "5m" ? "5m" : "1h";
}

/** The price of the model the API named, or null for one we do not know. */
export function priceOfModel(model: string): Price | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase();
  for (const [prefix, price] of OTHER_PRICE)
    if (id.startsWith(prefix)) return price;
  return null;
}

/** Token counts as the engine's `TurnUsage` carries them. */
export type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * What one turn's requests cost, from the API's own counts. Null when the
 * model is one we have no price for, which is better than a wrong number.
 */
export function usageCost(
  model: string,
  usage: Tokens,
  ttl: Ttl = "1h",
): number | null {
  const p = priceOfModel(model);
  if (p === null) return null;
  const write = ttl === "1h" ? p.write1h : p.write5m;
  return (
    (usage.input_tokens * p.input +
      usage.cache_creation_input_tokens * write +
      usage.cache_read_input_tokens * p.read +
      usage.output_tokens * p.output) /
    1e6
  );
}

/** Ladder order, low to high, for telling a downgrade from an upgrade. */
const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

export function isDowngrade(from: Tier, to: Tier): boolean {
  return RANK[to] < RANK[from];
}

/**
 * The two prices a shaky downgrade is decided between.
 *
 * `stay` is the next turn on the tier already running, warm: its context
 * read from cache plus its output. `go` is the same turn on the cheaper
 * tier, cold: the whole context written to that tier's cache, its output,
 * and then the write that comes due when the session returns to the tier it
 * left, whose cache the detour let go cold (measured over a week of
 * transcripts: 31 of 38 returns from haiku to fable paid it in full).
 *
 * A downgrade that costs more than it saves is held. Output tokens are the
 * only term where the cheaper tier wins, so the balance tips with context:
 * at a few thousand tokens the cheaper output carries it; at the sizes a
 * working session actually runs (150k–330k at the median, measured) the
 * writes are tens of times the output and no downgrade pays.
 */
export type SwitchVerdict = {
  /** Dollars for this turn on the running tier, cache warm. */
  stay: number;
  /** Dollars for this turn on the new tier, cache cold, return write included. */
  go: number;
  /** True when going costs at least as much as staying. */
  hold: boolean;
};

export function switchVerdict(
  from: Tier,
  to: Tier,
  contextTokens: number,
  outputTokens: number,
  ttl: Ttl = "1h",
): SwitchVerdict {
  const write = (t: Tier) =>
    ttl === "1h" ? PRICE[t].write1h : PRICE[t].write5m;
  const ctx = contextTokens / 1e6;
  const out = outputTokens / 1e6;
  const stay = ctx * PRICE[from].read + out * PRICE[from].output;
  const go = ctx * write(to) + out * PRICE[to].output + ctx * write(from);
  return { stay, go, hold: go >= stay };
}

/**
 * The context size below which a downgrade from `from` to `to` still pays,
 * for a turn of `outputTokens`. Shown in the status report so the bar is
 * visible; zero when no context is small enough.
 */
export function breakEvenTokens(
  from: Tier,
  to: Tier,
  outputTokens: number,
  ttl: Ttl = "1h",
): number {
  const write = (t: Tier) =>
    ttl === "1h" ? PRICE[t].write1h : PRICE[t].write5m;
  // stay = ctx·read(from) + out·output(from); go = ctx·(write(to)+write(from)) + out·output(to)
  // go < stay  ⇔  ctx·(write(to)+write(from)−read(from)) < out·(output(from)−output(to))
  const perCtx = write(to) + write(from) - PRICE[from].read;
  const perOut = PRICE[from].output - PRICE[to].output;
  if (perOut <= 0 || perCtx <= 0) return 0;
  return Math.floor((outputTokens * perOut) / perCtx);
}

/** `$0.0123` style, with enough places to show a small turn. */
export function usd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
