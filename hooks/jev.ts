/**
 * Asking Jev, TypeSafe's decision model, through the Vercel AI Gateway.
 *
 * The gateway speaks its own vocabulary at `/v1/evaluate`: question types are
 * `choice`, `score` and `boolean`, never TypeSafe's native `noul`, which it
 * rejects outright. Probabilities and confidences come back rounded to two
 * decimal places; TypeSafe direct gives four.
 *
 * `fetch` and `sleep` are arguments rather than imports so this file runs
 * under plain `node` in tests, with no engine and no network.
 */

import {
  EFFORT_CRITERIA,
  TIER_CRITERIA,
  type Tier,
} from './policy.ts'

export const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate'

export const JEV_MODEL = 'typesafe-ai/jev'

/**
 * Measured against the live gateway on 2026-09-20: ten prompts ran 402ms to
 * 839ms. An 800ms budget failed open on the slowest of them, so this leaves
 * real headroom while still capping what a turn waits before giving up.
 * `JEV_ROUTER_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 1500

/** A timeout from the environment, or the default when it is unusable. */
export function timeoutOf(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return parsed
}

export type HttpResponseLike = {
  ok: boolean
  status: number
  text: string
}

/**
 * What one attempt at Jev came to. A failure carries its reason so the
 * session can say why a turn went unrouted instead of going quiet.
 */
export type JevResult =
  | { ok: true; answers: unknown; ms: number }
  | { ok: false; reason: string; ms: number }

export type AskArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>
  sleep: (ms: number) => Promise<unknown>
  apiKey: string | undefined
  state: string
  offered: readonly Tier[]
  timeoutMs?: number
  /** Injected so tests can measure without a real clock. */
  now?: () => number
}

export type HttpInitLike = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * The request body for one routing decision: two questions Jev answers in
 * parallel, the tier as a Choice and the effort as a Score.
 */
export function requestBodyOf(state: string, offered: readonly Tier[]) {
  const criteria: Record<string, string> = {}
  for (const tier of offered) criteria[tier] = TIER_CRITERIA[tier]

  return {
    model: JEV_MODEL,
    state,
    questions: {
      tier: {
        type: 'choice',
        instructions:
          'A developer typed this request to a coding agent. Which model tier ' +
          'should answer it?',
        criteria,
      },
      effort: {
        type: 'score',
        instructions: 'How much thinking does answering this request take?',
        criteria: [...EFFORT_CRITERIA],
      },
    },
  }
}

/**
 * Asks Jev and answers with the response's `answers` object, or a reason.
 *
 * Every failure is still a pass for the turn, but it is a named one: the
 * caller reports the reason rather than leaving the person guessing whether
 * the router ran at all.
 */
export async function askJev(args: AskArgs): Promise<JevResult> {
  const { fetch, sleep, apiKey, state, offered, now = () => Date.now() } = args
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = now()
  const since = () => now() - started

  if (!apiKey) return { ok: false, reason: 'no AI_GATEWAY_API_KEY', ms: 0 }
  if (state.trim() === '') return { ok: false, reason: 'empty prompt', ms: 0 }
  if (offered.length === 0) return { ok: false, reason: 'no tiers offered', ms: 0 }

  const TIMED_OUT = Symbol('timed-out')

  const call = fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBodyOf(state, offered)),
  })

  let response: HttpResponseLike
  try {
    const raced = await Promise.race([
      call,
      sleep(timeoutMs).then(() => TIMED_OUT),
    ])
    if (raced === TIMED_OUT) {
      return { ok: false, reason: `timed out after ${timeoutMs}ms`, ms: since() }
    }
    response = raced as HttpResponseLike
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `request failed: ${detail}`, ms: since() }
  }

  if (!response) return { ok: false, reason: 'no response', ms: since() }

  if (!response.ok) {
    return {
      ok: false,
      reason: `gateway said HTTP ${response.status}${gatewayNoteOf(response)}`,
      ms: since(),
    }
  }

  try {
    const parsed = JSON.parse(response.text) as { answers?: unknown }
    if (typeof parsed !== 'object' || parsed === null || !parsed.answers) {
      return { ok: false, reason: 'response carried no answers', ms: since() }
    }
    return { ok: true, answers: parsed.answers, ms: since() }
  } catch {
    return { ok: false, reason: 'response was not JSON', ms: since() }
  }
}

/** The gateway's own error type, when it sent one, for the status line. */
function gatewayNoteOf(response: HttpResponseLike): string {
  try {
    const body = JSON.parse(response.text) as { error?: { type?: string } }
    const type = body?.error?.type
    return typeof type === 'string' ? ` (${type})` : ''
  } catch {
    return ''
  }
}
