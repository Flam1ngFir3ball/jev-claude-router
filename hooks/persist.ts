/**
 * What of a session's routing survives a reload of this module.
 *
 * The engine reloads a hooks module when its files change (an update, a
 * `git pull`), and every `let` in `register` starts over: the history empty,
 * `spent` at zero, and — the part that costs money — nothing held, so the
 * first switch after a reload was priced against the session model instead
 * of the tier actually warm. `$.store` is the engine's own JSON store for
 * the plugin, kept across reloads and sessions; this file turns the state
 * into data for it and back. Nothing here touches the engine.
 *
 * Attempts are shared: one object sits in the history, in the open reply
 * and in the agent map at once, and usage folded into it must show in all
 * three. JSON would copy each, so they are written once, as a pool, and
 * referred to by index.
 */

import type { Compaction } from "./compactor.ts";
import type { Ceiling, Decision } from "./policy.ts";
import type { Attempt } from "./status.ts";

export const SNAPSHOT_VERSION = 1;

/** Keys under which snapshots are kept, one per session. */
export const SNAPSHOT_PREFIX = "session:";

/** Sessions whose snapshots are kept; older ones are dropped on save. */
export const SNAPSHOTS_KEPT = 20;

export type State = {
  attempts: Attempt[];
  reply: Attempt[];
  replyAgents: string[];
  spawned: [string, Attempt][];
  /**
   * The turns in flight: their attempts, their decisions, and which still
   * await their route line. A reload mid-turn used to leave the rest of
   * that turn unrouted, since its next step found nothing under its id.
   */
  turns: [string, Attempt][];
  decisions: [string, Decision][];
  pending: string[];
  /** Agents whose first request has run, so a resumed one is not re-snapped. */
  stepped: string[];
  running: Decision | null;
  continueFrom: Decision | null;
  latest: Decision | null;
  lastUsage: { context: number; output: number } | null;
  sessionModel: string | null;
  spent: number;
  enabled: boolean;
  announce: boolean;
  /** A response has been received in this conversation: no request is its first any more. */
  answered: boolean;
  sticky: number | null;
  ceiling: Ceiling;
  /** Compaction by Jev is on. */
  compactOn: boolean;
  /** The downgrade and upgrade price checks are on. */
  priceCheck: boolean;
  /** Agents whose reply's summary was written: their late wake-up joins no block. */
  summarisedAgents: string[];
  /** The last compaction Jev was asked about, for /jev. */
  compaction: Compaction | null;
};

type Packed = Omit<State, "attempts" | "reply" | "spawned" | "turns"> & {
  v: number;
  pool: Attempt[];
  attempts: number[];
  reply: number[];
  spawned: [string, number][];
  turns: [string, number][];
};

/** The state as JSON data, attempts written once each. */
export function pack(state: State): Packed {
  const pool: Attempt[] = [];
  const index = new Map<Attempt, number>();
  const ref = (a: Attempt) => {
    let i = index.get(a);
    if (i === undefined) {
      i = pool.length;
      pool.push(a);
      index.set(a, i);
    }
    return i;
  };
  return {
    v: SNAPSHOT_VERSION,
    pool,
    attempts: state.attempts.map(ref),
    reply: state.reply.map(ref),
    replyAgents: [...state.replyAgents],
    spawned: state.spawned.map(([id, a]) => [id, ref(a)]),
    turns: state.turns.map(([id, a]) => [id, ref(a)]),
    decisions: state.decisions,
    pending: [...state.pending],
    stepped: [...state.stepped],
    running: state.running,
    continueFrom: state.continueFrom,
    latest: state.latest,
    lastUsage: state.lastUsage,
    sessionModel: state.sessionModel,
    spent: state.spent,
    enabled: state.enabled,
    announce: state.announce,
    answered: state.answered,
    sticky: state.sticky,
    ceiling: state.ceiling,
    compactOn: state.compactOn,
    priceCheck: state.priceCheck,
    summarisedAgents: state.summarisedAgents,
    compaction: state.compaction,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The state back from what the store returned, or null for anything that is
 * not a snapshot this version wrote. A bad snapshot is ignored, never
 * trusted: the router then starts over, which is what it did before this
 * file existed.
 */
export function unpack(raw: unknown): State | null {
  if (!isRecord(raw) || raw.v !== SNAPSHOT_VERSION) return null;
  const pool = raw.pool;
  if (!Array.isArray(pool) || !pool.every(isRecord)) return null;
  const at = (i: unknown): Attempt | null =>
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i < pool.length
      ? (pool[i] as Attempt)
      : null;
  const refs = (v: unknown): Attempt[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.map(at);
    return out.every((a) => a !== null) ? (out as Attempt[]) : null;
  };
  const attempts = refs(raw.attempts);
  const reply = refs(raw.reply);
  if (attempts === null || reply === null) return null;
  if (!Array.isArray(raw.spawned) || !Array.isArray(raw.replyAgents))
    return null;
  const pairs = (v: unknown): [string, Attempt][] | null => {
    // Absent in a snapshot from before the field existed: nothing in flight.
    if (v === undefined) return [];
    if (!Array.isArray(v)) return null;
    const out: [string, Attempt][] = [];
    for (const pair of v) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string") return null;
      const a = at(pair[1]);
      if (a === null) return null;
      out.push([pair[0], a]);
    }
    return out;
  };
  const spawned = pairs(raw.spawned);
  const turns = pairs(raw.turns);
  if (spawned === null || turns === null) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  // Validate Decision fields to catch corruption in the store: tier, model,
  // effort are expected strings; confidence is 0–1. Fail open: invalid
  // decisions are dropped rather than trusted to their detriment.
  const isValidDecision = (v: unknown): v is Decision =>
    isRecord(v) &&
    typeof v.tier === "string" &&
    typeof v.model === "string" &&
    typeof v.effort === "string" &&
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    v.confidence >= 0 &&
    v.confidence <= 1;
  const decisions: [string, Decision][] = Array.isArray(raw.decisions)
    ? raw.decisions.filter(
        (p): p is [string, Decision] =>
          Array.isArray(p) && typeof p[0] === "string" && isValidDecision(p[1]),
      )
    : [];
  const decision = (v: unknown) => (isValidDecision(v) ? v : null);
  const lastUsage =
    isRecord(raw.lastUsage) &&
    typeof raw.lastUsage.context === "number" &&
    typeof raw.lastUsage.output === "number"
      ? { context: raw.lastUsage.context, output: raw.lastUsage.output }
      : null;
  if (!isRecord(raw.ceiling)) return null;
  return {
    attempts,
    reply,
    replyAgents: raw.replyAgents.filter(
      (id): id is string => typeof id === "string",
    ),
    spawned,
    turns,
    decisions,
    pending: strings(raw.pending),
    stepped: strings(raw.stepped),
    running: decision(raw.running),
    continueFrom: decision(raw.continueFrom),
    latest: decision(raw.latest),
    lastUsage,
    sessionModel:
      typeof raw.sessionModel === "string" ? raw.sessionModel : null,
    spent: typeof raw.spent === "number" ? raw.spent : 0,
    enabled: raw.enabled !== false,
    announce: raw.announce !== false,
    // A snapshot from before this field exists has turns behind it.
    answered: raw.answered !== false,
    sticky: typeof raw.sticky === "number" ? raw.sticky : null,
    ceiling: raw.ceiling as Ceiling,
    compactOn: raw.compactOn !== false,
    priceCheck: raw.priceCheck !== false,
    summarisedAgents: Array.isArray(raw.summarisedAgents)
      ? raw.summarisedAgents.filter((a): a is string => typeof a === "string")
      : [],
    compaction: compactionOf(raw.compaction),
  };
}

/** The snapshot keys to drop so `SNAPSHOTS_KEPT` remain, oldest first. */
/** A saved compaction with every field it needs, or null. */
function compactionOf(raw: unknown): Compaction | null {
  if (!isRecord(raw) || !isRecord(raw.calls)) return null;
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const c = raw.calls;
  if (![raw.at, raw.kept, raw.of, raw.reduction, raw.ms, c.kept, c.cut, c.dropped].every(n)) return null;
  return {
    at: raw.at as number,
    kept: raw.kept as number,
    of: raw.of as number,
    reduction: raw.reduction as number,
    ms: raw.ms as number,
    calls: { kept: c.kept as number, cut: c.cut as number, dropped: c.dropped as number },
    ...(typeof raw.fallback === "string" ? { fallback: raw.fallback } : {}),
  };
}

export function staleKeys(keys: readonly string[], current: string): string[] {
  const sessions = keys.filter(
    (k) => k.startsWith(SNAPSHOT_PREFIX) && k !== current,
  );
  const excess = sessions.length + 1 - SNAPSHOTS_KEPT;
  return excess > 0 ? sessions.slice(0, excess) : [];
}
