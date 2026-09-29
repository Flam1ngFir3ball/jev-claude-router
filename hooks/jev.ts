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

import { EFFORT_CRITERIA, PLAIN_DECIMAL, TIER_CRITERIA, type Tier } from "./policy.ts";
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

/**
 * The first `n` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: half an emoji is not valid Unicode, and a strict JSON
 * parser on the other end refuses the whole body.
 */
export function headOf(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** The state Jev is sent: the prompt, cut at MAX_STATE_CHARS. */
export function stateOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_STATE_CHARS
    ? trimmed
    : `${headOf(trimmed, MAX_STATE_CHARS)}…`;
}

/**
 * An error's message as text, whatever was thrown: a fetch may reject with
 * something that is not an Error, or one whose message is not a string, and
 * turning that into text must not itself throw.
 */
export function messageOf(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message || "unknown error";
    if (typeof error === "string") return error || "unknown error";
    if (typeof error === "number" || typeof error === "boolean") return String(error);
    // `undefined`, `[object Object]` and the like say nothing to a person.
    return "unknown error";
  } catch {
    return "unknown error";
  }
}

/** A `Bearer` header value that looks like a key, for redacting from error text. */
export const BEARER_VALUE = /\bBearer\s+(?=[^\s"']*[\d_])[^\s"']{8,}/gi;

/**
 * An engine fetch error as a few words for the route line: without the
 * engine's "<plugin>: $.http.fetch(<url>) failed:" preamble, repeats and
 * advice, e.g. "ECONNREFUSED" or "getaddrinfo ENOTFOUND host".
 */
export function shortError(detail: string): string {
  // Cut first, and newlines folded by splitting: `\s*\n\s*` is quadratic
  // on a long run of spaces with no newline in it.
  const bare = detail
    .slice(0, 2000)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0e-\x1f\x7f-\x84\x86-\x9f]/g, "")
    .split(/[\n\r\v\f\u0085\u2028\u2029]/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join(" ")
    .replace(/^[\w.-]+: \$\.http\.fetch\([^)]*\) failed: /, "")
    // An error that quotes the request's header quotes the key with it.
    // Only a value that looks like a key (long, with a digit or underscore):
    // "Missing bearer token." is advice, not a key.
    .replace(BEARER_VALUE, "Bearer …")
    .split(/[.?!]\s/)[0]!
    .replace(/^(\w+): \1\b:?\s*/, "$1: ")
    .replace(/:\s*$/, "")
    .trim();
  return bare.length > 60 ? `${bare.slice(0, 57)}…` : bare;
}

/**
 * Below this a budget is taken for a mistake, most likely seconds written
 * where milliseconds are read (`1.5`), which would time every turn out.
 */
export const MIN_TIMEOUT_MS = 100;

/** A timeout from the environment, or the default when it is unusable. */
export function timeoutOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  const parsed = Number(v);
  if (!PLAIN_DECIMAL.test(v) || parsed < MIN_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
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
  /** The engine's `$.clock.sleep`; `signal` ends the wait early, so no timer outlives the call. */
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  provider: ProviderResult;
  state: string;
  offered: readonly Tier[];
  /** Who wrote `state`, which the question to Jev says; `prompt` when absent. */
  source?: StateSource;
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

/** What the text Jev grades is: a typed prompt, a subagent's task, a finished task's report. */
export type StateSource = "prompt" | "task" | "notification";

/**
 * How the text is introduced to Jev. A subagent's task is written by the
 * model, and a finished task's report is a line about work done, not the
 * work to do next: graded as a developer's request, "Agent X completed"
 * reads as trivial when the turn is about to work through its results.
 */
const TIER_QUESTION: Record<StateSource, string> = {
  prompt: "A developer typed this request to a coding agent. Which model tier should answer it?",
  task:
    "A coding agent handed this task to a subagent of its own. Which model tier " +
    "should the subagent run on?",
  notification:
    "A background task the coding agent started has finished and reported back; " +
    "this is its report. The agent now works through the result and decides what " +
    "to do next. Which model tier should do that?",
};

/**
 * The request body for one routing decision: two questions Jev answers in
 * parallel, the tier as a Choice and the effort as a Score.
 *
 * The model field is added by askJev depending on which provider is used.
 */
export function requestBodyOf(state: string, offered: readonly Tier[], source: StateSource = "prompt") {
  const criteria: Record<string, string> = {};
  for (const tier of offered) criteria[tier] = TIER_CRITERIA[tier];

  return {
    state,
    questions: {
      tier: {
        type: "choice",
        instructions: TIER_QUESTION[source],
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
    ...requestBodyOf(stateOf(state), offered, args.source),
    model: provider.model,
  };

  // Called inside an async function, so a fetch that throws at once is a
  // rejection handled below, not an escape past the finally.
  const call = (async () =>
    fetch(provider.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }))();
  // Ended in the finally, so the timeout does not keep running (and a
  // script's process alive) after the answer is in.
  const timer = new AbortController();

  let response: HttpResponseLike;
  try {
    const raced = await Promise.race([
      call,
      sleep(timeoutMs, { signal: timer.signal }).then(
        () => TIMED_OUT,
        () => new Promise<never>(() => {}),
      ),
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
    return { ok: false, reason: `request failed: ${shortError(messageOf(error))}`, ms: since() };
  } finally {
    timer.abort();
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
    // It lands in the reply's route line: a short, plain word or nothing.
    if (typeof type !== "string") return "";
    const plain = type.replace(/[^\w.-]/g, "").slice(0, 40);
    return plain === "" ? "" : ` (${plain})`;
  } catch {
    return "";
  }
}
