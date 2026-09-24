/**
 * Asking Jev, TypeSafe's decision model, through either the Vercel AI
 * Gateway or TypeSafe's direct API.
 *
 * The gateway (POST /v1/evaluate) speaks its own vocabulary: question types
 * are `choice` and `score` (never TypeSafe's native `noul`, which it rejects
 * outright). Probabilities and confidences come back rounded to two decimal
 * places.
 *
 * TypeSafe direct (POST /v1/systemone) supports choice, score, and noul and
 * returns probabilities rounded to four decimal places.
 *
 * Both support the same `choice` and `score` question types and the same
 * `answers` response shape, so the request/response handling is identical.
 *
 * `fetch` and `sleep` are arguments rather than imports so this file runs
 * under plain `node` in tests, with no engine and no network.
 */

import { EFFORT_CRITERIA, TIER_CRITERIA, type Tier } from "./policy.ts";
import type { ProviderResult } from "./provider.ts";

/**
 * Measured against the live gateway on 2026-09-20: ten prompts ran 402ms to
 * 839ms. An 800ms budget failed open on the slowest of them, so this leaves
 * real headroom while still capping what a turn waits before giving up.
 * `JEV_ROUTER_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Jev takes 32k tokens of state and reads the whole of it; TypeSafe's own
 * guidance is that accuracy falls as the state grows with content unrelated
 * to the decision. A routing decision is made on how a request opens, so a
 * long paste is cut here rather than sent whole and refused with a 422.
 */
export const MAX_STATE_CHARS = 12_000;

/** The state Jev is sent: the prompt, cut at MAX_STATE_CHARS. */
export function stateOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_STATE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_STATE_CHARS)}…`;
}

/** A timeout from the environment, or the default when it is unusable. */
/**
 * An engine fetch error as a few words for the route line: without the
 * engine's "<plugin>: $.http.fetch(<url>) failed:" preamble, repeats and
 * advice, e.g. "ECONNREFUSED" or "getaddrinfo ENOTFOUND host".
 */
export function shortError(detail: string): string {
  const bare = detail
    .replace(/^[\w.-]+: \$\.http\.fetch\([^)]*\) failed: /, "")
    .split(/[.?!]\s/)[0]!
    .replace(/^(\w+): \1\b:?\s*/, "$1: ")
    .replace(/:\s*$/, "")
    .trim();
  return bare.length > 60 ? `${bare.slice(0, 57)}…` : bare;
}

export function timeoutOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/**
 * The longest a turn may wait for Jev. The wait runs on `$.clock`, which
 * counts against the hook's 10-second budget; a hook over it is skipped as
 * absent and its turn goes unrecorded. So the budget from the environment is
 * held under it, with room for the hook's own work.
 */
export const MAX_TIMEOUT_MS = 8000;

export type HttpResponseLike = {
  ok: boolean;
  status: number;
  text: string;
};

/**
 * What one attempt at Jev came to. A failure carries its reason so the
 * session can say why a turn went unrouted instead of going quiet.
 */
export type JevResult =
  | { ok: true; answers: unknown; ms: number }
  | { ok: false; reason: string; ms: number };

export type AskArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  sleep: (ms: number) => Promise<unknown>;
  provider: ProviderResult;
  state: string;
  offered: readonly Tier[];
  timeoutMs?: number;
  /**
   * Aborted by the caller when the answer is no longer wanted (the turn was
   * ceded to a newer copy before this resolved). Wired to the same fetch
   * signal as the timeout abort; whether it actually stops the request
   * depends on the fetch implementation honouring it — see the note below.
   */
  signal?: AbortSignal;
  /** Injected so tests can measure without a real clock. */
  now?: () => number;
};

export type HttpInitLike = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

/**
 * The request body for one routing decision: two questions Jev answers in
 * parallel, the tier as a Choice and the effort as a Score.
 *
 * The model field is added by askJev depending on which provider is used.
 */
export function requestBodyOf(state: string, offered: readonly Tier[]) {
  const criteria: Record<string, string> = {};
  for (const tier of offered) criteria[tier] = TIER_CRITERIA[tier];

  return {
    state,
    questions: {
      tier: {
        type: "choice",
        instructions:
          "A developer typed this request to a coding agent. Which model tier " +
          "should answer it?",
        criteria,
      },
      effort: {
        type: "score",
        instructions: "How much thinking does answering this request take?",
        criteria: [...EFFORT_CRITERIA],
      },
    },
  };
}

/**
 * Asks Jev and answers with the response's `answers` object, or a reason.
 *
 * Every failure is still a pass for the turn, but it is a named one: the
 * caller reports the reason rather than leaving the person guessing whether
 * the router ran at all.
 *
 * On timeout, or on the caller's own `signal` aborting (the turn was ceded
 * before this resolved), the turn moves on without the answer. The engine's
 * `$.http.fetch` takes no abort signal, so the request itself runs to
 * completion and is billed (about $0.00003) either way; the signal is
 * passed for a plain `fetch`, as the scripts use, which does honour it.
 */
export async function askJev(args: AskArgs): Promise<JevResult> {
  const {
    fetch,
    sleep,
    provider,
    state,
    offered,
    now = () => Date.now(),
  } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const since = () => now() - started;

  if (!provider.ok) return { ok: false, reason: provider.reason, ms: 0 };
  if (state.trim() === "") return { ok: false, reason: "empty prompt", ms: 0 };
  if (offered.length === 0)
    return { ok: false, reason: "no tiers offered", ms: 0 };
  if (args.signal?.aborted) return { ok: false, reason: "ceded", ms: 0 };

  const TIMED_OUT = Symbol("timed-out");
  const CEDED = Symbol("ceded");
  const controller = new AbortController();
  // The caller's signal cancels the same in-flight request the timeout does,
  // and resolves the race below the moment it fires.
  let onCeded: (() => void) | undefined;
  const ceded = new Promise<typeof CEDED>((resolve) => {
    onCeded = () => {
      controller.abort();
      resolve(CEDED);
    };
    args.signal?.addEventListener("abort", onCeded);
  });

  const body = {
    ...requestBodyOf(stateOf(state), offered),
    model: provider.model,
  };

  const call = fetch(provider.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  let response: HttpResponseLike;
  try {
    const raced = await Promise.race([
      call,
      sleep(timeoutMs).then(() => TIMED_OUT),
      ceded,
    ]);
    if (raced === CEDED) {
      void call.catch(() => undefined);
      return { ok: false, reason: "ceded", ms: since() };
    }
    if (raced === TIMED_OUT) {
      controller.abort();
      void call.catch(() => undefined);
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ms: since(),
      };
    }
    response = raced as HttpResponseLike;
  } catch (error) {
    if (args.signal?.aborted) {
      return { ok: false, reason: "ceded", ms: since() };
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ms: since(),
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `request failed: ${shortError(detail)}`, ms: since() };
  } finally {
    if (onCeded) args.signal?.removeEventListener("abort", onCeded);
  }

  if (!response) return { ok: false, reason: "no response", ms: since() };

  if (!response.ok) {
    const who = provider.name;
    return {
      ok: false,
      reason: `${who} said HTTP ${response.status}${providerNoteOf(response)}`,
      ms: since(),
    };
  }

  try {
    const parsed = JSON.parse(response.text) as { answers?: unknown };
    if (typeof parsed !== "object" || parsed === null || !parsed.answers) {
      return { ok: false, reason: "response carried no answers", ms: since() };
    }
    return { ok: true, answers: parsed.answers, ms: since() };
  } catch {
    return { ok: false, reason: "response was not JSON", ms: since() };
  }
}

/** The provider's own error type, when it sent one, for the status line. */
function providerNoteOf(response: HttpResponseLike): string {
  try {
    const body = JSON.parse(response.text) as { error?: { type?: string } };
    const type = body?.error?.type;
    return typeof type === "string" ? ` (${type})` : "";
  } catch {
    return "";
  }
}
