/**
 * Compaction by Jev: instead of the engine's summary, every tool call in the
 * transcript is scored — one Jev request for a typical conversation, split
 * into a few (capped at 2 in flight at once) once there are enough calls to
 * outgrow one request's token budget — and the stale ones are dropped or
 * cut, so what stays is the conversation itself, verbatim. The scoring is
 * the vendored fast-jev-compaction library (hooks/compaction/); this file is
 * what ties it to the plugin's provider, its settings and `/jev`.
 *
 * Only TypeSafe direct serves it: the questions are `noul` (a probability
 * for a yes/no), which the Vercel gateway rejects. Anything that goes wrong
 * — no key, the gateway, a timeout, too little removed — leaves the engine's
 * own compaction to run, and `/jev` says why.
 */

import { compact, reductionRatio, resolveOptions } from "./compaction/compact.ts";
import { buildJevRequest, parseJevResponse } from "./compaction/request.ts";
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from "./compaction/types.ts";
import { messageOf, type HttpInitLike, type HttpResponseLike } from "./jev.ts";
import { flagOff, PLAIN_DECIMAL } from "./policy.ts";
import type { ProviderResult } from "./provider.ts";

/** Below this share removed, the engine's summary does better; its default. */
export const MIN_REDUCTION = 0.25;

/**
 * How long the whole scoring may take before the engine's summary runs
 * instead. The hook itself has a 10-second budget that a wait counts
 * against, so the cap stays under it: a hook the engine kills leaves no
 * record and resets nothing.
 */
export const DEFAULT_COMPACT_TIMEOUT_MS = 8_000;
const MAX_COMPACT_TIMEOUT_MS = 8_000;

/** `JEV_ROUTER_COMPACT`: on unless `0`, `false`, `no`, `off` or `none`. */
export function compactOnOf(raw: string | undefined): boolean {
  return !flagOff(raw);
}

/**
 * Below this a scoring budget is taken for a mistake (seconds written as
 * `8`), as for JEV_ROUTER_TIMEOUT_MS; a small budget above it is honoured.
 */
export const MIN_COMPACT_TIMEOUT_MS = 100;

/** `JEV_ROUTER_COMPACT_TIMEOUT_MS`, clamped; the default when unset or bad. */
export function compactTimeoutOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  const n = Number(v);
  if (!PLAIN_DECIMAL.test(v) || n < MIN_COMPACT_TIMEOUT_MS)
    return DEFAULT_COMPACT_TIMEOUT_MS;
  return Math.min(n, MAX_COMPACT_TIMEOUT_MS);
}

/**
 * `JEV_ROUTER_COMPACT_MIN_REDUCTION`: a share 0–1; the default when unset or
 * bad. A number past 1 is a percentage, and so is anything written with `%`,
 * whatever its size: `1%` is a hundredth, not all of it.
 */
export function minReductionOf(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  const percent = trimmed.endsWith("%");
  const v = percent ? trimmed.slice(0, -1).trim() : trimmed;
  // Plain decimals, as the other settings: `0x19` or `1e1` is a mistake.
  if (!PLAIN_DECIMAL.test(v)) return MIN_REDUCTION;
  const n = Number(v);
  return percent || n > 1 ? Math.min(n / 100, 1) : n;
}

/** Why a pruning that removed too little does not stand; undefined when it does. */
export function shortOf(reduction: number, minReduction: number): string | undefined {
  if (reduction >= minReduction) return undefined;
  // The removed share rounded down and the needed one up, so they never
  // read "only 25% removed, needs 25%" (a bar of 25.4% needs 26%); the
  // epsilons keep 0.29 × 100 = 28.999… at 29 and 0.25 × 100 at 25.
  const needs = Math.ceil(minReduction * 100 - 1e-9);
  const removed = Math.min(Math.floor(reduction * 100 + 1e-9), needs - 1);
  return `only ${Math.max(0, removed)}% removed, needs ${needs}%`;
}

/** A transcript message as the engine hands it to `session.compact`. */
export type EngineMessage = Message & { handle?: string };

/** What one compaction came to, for `/jev` and the store. */
export type Compaction = {
  at: number;
  /** Messages after and before. */
  kept: number;
  of: number;
  /** Share of characters removed, 0–1. */
  reduction: number;
  /** Tool calls kept whole, cut to their head, and removed. */
  calls: { kept: number; cut: number; dropped: number };
  ms: number;
  /** Why the engine's own summary ran instead; absent when Jev's stood. */
  fallback?: string;
};

export type PruneResult =
  | { ok: true; messages: EngineMessage[]; compaction: Compaction }
  | { ok: false; compaction: Compaction };

/** A `JevAsker` over the plugin's provider and the engine's fetch. */
function askerOf(
  provider: Extract<ProviderResult, { ok: true }>,
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>,
  signal?: AbortSignal,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest(
        { apiKey: provider.apiKey, model: provider.model, baseUrl: provider.endpoint },
        state,
        questions,
      );
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // Passed for a fetch that honours it; the engine's does not yet,
        // so a timed-out request still runs to completion (at Jev's flat
        // per-call price).
        ...(signal !== undefined ? { signal } : {}),
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

/**
 * Maps the library's output back onto the engine's messages. A message the
 * library left alone is the engine's own object, handle and all, so the
 * engine keeps it whole; one it rebuilt has no handle, and the engine
 * takes its edited content.
 */
export function toEngineMessages(
  input: readonly EngineMessage[],
  output: readonly Message[],
): EngineMessage[] {
  const own = new Set<Message>(input);
  const uses = new Set<ToolUse>();
  const results = new Set<ToolResult>();
  for (const m of input) {
    for (const t of m.toolUses) uses.add(t);
    for (const r of m.toolResults ?? []) results.add(r);
  }
  return output.map((m) => {
    if (own.has(m)) return m as EngineMessage;
    const rebuilt: EngineMessage = {
      role: m.role,
      text: m.text,
      toolUses: m.toolUses.map((t) => (uses.has(t) ? t : withoutFalse(t))),
    };
    if (m.toolResults && m.toolResults.length > 0)
      // A result's isError is a plain boolean to the engine, false included.
      rebuilt.toolResults = m.toolResults.map((r) => (results.has(r) ? r : { ...r, isError: r.isError === true }));
    return rebuilt;
  });
}

/** A rebuilt tool use without `isError: false`: the engine spells a use's `true | undefined`. */
function withoutFalse<T extends { isError?: boolean }>(block: T): T {
  if (block.isError) return { ...block };
  const { isError: _, ...rest } = block;
  void _;
  return rest as T;
}

function compactionOf(result: CompactResult, ms: number): Compaction {
  return {
    at: Date.now(),
    kept: result.stats.messagesAfter,
    of: result.stats.messagesBefore,
    reduction: reductionRatio(result),
    calls: {
      kept: result.stats.kept,
      cut: result.stats.resultsDropped,
      dropped: result.stats.callsDropped,
    },
    ms,
  };
}

/**
 * Scores the transcript with Jev and returns what to keep, or why the
 * engine's summary should run instead. Never throws.
 */
export async function pruneTranscript(args: {
  messages: readonly EngineMessage[];
  provider: ProviderResult;
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  timeoutMs: number;
  minReduction: number;
  options?: CompactOptions;
  now?: () => number;
}): Promise<PruneResult> {
  const now = args.now ?? (() => Date.now());
  const started = now();
  const none = (fallback: string): PruneResult => ({
    ok: false,
    compaction: {
      at: Date.now(),
      kept: args.messages.length,
      of: args.messages.length,
      reduction: 0,
      calls: { kept: 0, cut: 0, dropped: 0 },
      ms: now() - started,
      fallback,
    },
  });
  if (!args.provider.ok) return none(args.provider.reason);
  if (args.provider.name !== "typesafe")
    return none("the gateway does not answer yes/no questions; needs TYPESAFE_API_KEY");

  const TIMED_OUT = Symbol("timed-out");
  const controller = new AbortController();
  // Ended in the finally, so the timeout does not run on after the scoring.
  const timer = new AbortController();
  try {
    const work = compact(
      args.messages,
      askerOf(args.provider, args.fetch, controller.signal),
      resolveOptions(args.options ?? {}),
      controller.signal,
    );
    const raced = await Promise.race([
      work,
      args.sleep(args.timeoutMs, { signal: timer.signal }).then(
        () => TIMED_OUT,
        () => new Promise<never>(() => {}),
      ),
    ]);
    if (raced === TIMED_OUT) {
      controller.abort();
      void work.catch(() => undefined);
      return none(`timed out after ${args.timeoutMs}ms`);
    }
    const result = raced as CompactResult;
    const compaction = compactionOf(result, now() - started);
    // A result the library marked for cutting is left whole when it is
    // already short: count what actually changed, not what was marked.
    const originals = new Set<ToolResult>(args.messages.flatMap((m) => m.toolResults ?? []));
    const cut = result.messages.flatMap((m) => m.toolResults ?? []).filter((r) => !originals.has(r)).length;
    compaction.calls = {
      kept: compaction.calls.kept + compaction.calls.cut - cut,
      cut,
      dropped: compaction.calls.dropped,
    };
    const short = shortOf(compaction.reduction, args.minReduction);
    if (short !== undefined) return { ok: false, compaction: { ...compaction, fallback: short } };
    return { ok: true, messages: toEngineMessages(args.messages, result.messages), compaction };
  } catch (error) {
    const detail = messageOf(error);
    // Shown in /jev and saved: plain words only, whatever the provider sent.
    return none(detail.replace(/\s+/g, " ").replace(/[`*_#<>\[\]()|]/g, "").slice(0, 120));
  } finally {
    timer.abort();
  }
}

/** `kept 41/87 messages, 63% smaller (12 calls kept, 9 cut, 30 dropped) · 2.1s`, or why not. */
export function compactionLine(c: Compaction): string {
  const when = c.ms >= 1000 ? `${(c.ms / 1000).toFixed(1)}s` : `${Math.round(c.ms)}ms`;
  if (c.fallback !== undefined) return `engine summary: ${c.fallback} · ${when}`;
  return (
    `kept ${c.kept}/${c.of} messages, ${Math.round(c.reduction * 100)}% smaller ` +
    `(${c.calls.kept} calls kept, ${c.calls.cut} cut, ${c.calls.dropped} dropped) · ${when}`
  );
}
