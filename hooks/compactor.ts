/**
 * Compaction by Jev: instead of the engine's summary, every tool call in the
 * transcript is scored in one Jev request and the stale ones are dropped or
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
import type { HttpInitLike, HttpResponseLike } from "./jev.ts";
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

/** `JEV_ROUTER_COMPACT`: on unless `0`, `false`, `no` or `off`. */
export function compactOnOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no" || flag === "off");
}

/** `JEV_ROUTER_COMPACT_TIMEOUT_MS`, clamped; the default when unset or bad. */
export function compactTimeoutOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  const n = Number(v);
  if (v === "" || !Number.isFinite(n) || n <= 0) return DEFAULT_COMPACT_TIMEOUT_MS;
  return Math.min(n, MAX_COMPACT_TIMEOUT_MS);
}

/** `JEV_ROUTER_COMPACT_MIN_REDUCTION`: a share 0–1; the default when unset or bad. */
export function minReductionOf(raw: string | undefined): number {
  const v = (raw ?? "").trim().replace(/%$/, "");
  const n = Number(v);
  if (v === "" || !Number.isFinite(n) || n < 0) return MIN_REDUCTION;
  return n > 1 ? Math.min(n / 100, 1) : n;
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
      rebuilt.toolResults = m.toolResults.map((r) => (results.has(r) ? r : withoutFalse(r)));
    return rebuilt;
  });
}

/** A rebuilt block without `isError: false`: the engine spells it `true | undefined`. */
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
  sleep: (ms: number) => Promise<unknown>;
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
  try {
    const work = compact(
      args.messages,
      askerOf(args.provider, args.fetch),
      resolveOptions(args.options ?? {}),
    );
    const raced = await Promise.race([
      work,
      args.sleep(args.timeoutMs).then(() => TIMED_OUT),
    ]);
    if (raced === TIMED_OUT) {
      void work.catch(() => undefined);
      return none(`timed out after ${args.timeoutMs}ms`);
    }
    const result = raced as CompactResult;
    const compaction = compactionOf(result, now() - started);
    if (compaction.reduction < args.minReduction) {
      return {
        ok: false,
        compaction: {
          ...compaction,
          fallback: `only ${Math.round(compaction.reduction * 100)}% removed, needs ${Math.round(args.minReduction * 100)}%`,
        },
      };
    }
    return { ok: true, messages: toEngineMessages(args.messages, result.messages), compaction };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return none(detail.replace(/\s+/g, " ").slice(0, 120));
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
