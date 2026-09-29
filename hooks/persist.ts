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
import { EFFORTS, TIERS, type Ceiling, type Decision } from "./policy.ts";
import type { Attempt } from "./status.ts";

export const SNAPSHOT_VERSION = 1;

/** Keys under which snapshots are kept, one per session. */
export const SNAPSHOT_PREFIX = "session:";

/** Sessions whose snapshots are kept; older ones are dropped on save. */
export const SNAPSHOTS_KEPT = 20;

/** The settings a `/jev` command can set, which then outrank the environment. */
export const OVERRIDABLE = ["sticky", "ceiling", "excludedTiers", "compactOn", "priceCheck"] as const;
export type Overridable = (typeof OVERRIDABLE)[number];

export type State = {
  attempts: Attempt[];
  reply: Attempt[];
  replyAgents: string[];
  spawned: [string, Attempt][];
  /** Agents the router left alone, one history row each. */
  unrouted: [string, Attempt][];
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
  /**
   * Tiers `/jev tiers off` dropped from the question Jev is asked.
   * `undefined` only comes back from `unpack` on a snapshot from before this
   * field existed — never from `pack`, which always writes the live array —
   * and means "this snapshot has no opinion", not "nothing is excluded": the
   * caller should leave the environment's own `JEV_ROUTER_EXCLUDE` seeding
   * in place rather than overwrite it with an empty array.
   */
  excludedTiers: string[] | undefined;
  /** Compaction by Jev is on. */
  compactOn: boolean;
  /** The downgrade and upgrade price checks are on. */
  priceCheck: boolean;
  /**
   * The settings above that a `/jev` command set this session; only these
   * are restored over the environment, so a reload or resume still follows
   * a changed `JEV_ROUTER_*` for everything no command touched.
   * `undefined` only from `unpack` on a snapshot from before this field
   * existed, which restores every setting, as those snapshots always did.
   */
  overridden: Overridable[] | undefined;
  /** Agents whose reply's summary was written: their late wake-up joins no block. */
  summarisedAgents: string[];
  /** The last compaction Jev was asked about, for /jev. */
  compaction: Compaction | null;
  /**
   * What was running before the last turn switched, while no response has
   * confirmed the switch; null when there is nothing to take back.
   */
  unconfirmed: { was: Decision | null } | null;
  /** The engine said the resumed session's cache expired, and no response has written it since. */
  cacheExpired: boolean;
  /** When the snapshot was written; only from `unpack`, since `pack` stamps its own. */
  savedAt?: number;
};

type Packed = Omit<State, "attempts" | "reply" | "spawned" | "unrouted" | "turns"> & {
  v: number;
  /** When it was written, for pruning the least recently used first. */
  savedAt: number;
  pool: Attempt[];
  attempts: number[];
  reply: number[];
  spawned: [string, number][];
  unrouted: [string, number][];
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
    savedAt: Date.now(),
    pool,
    attempts: state.attempts.map(ref),
    reply: state.reply.map(ref),
    replyAgents: [...state.replyAgents],
    spawned: state.spawned.map(([id, a]) => [id, ref(a)]),
    unrouted: (state.unrouted ?? []).map(([id, a]) => [id, ref(a)]),
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
    excludedTiers: state.excludedTiers,
    compactOn: state.compactOn,
    priceCheck: state.priceCheck,
    overridden: state.overridden,
    summarisedAgents: state.summarisedAgents,
    compaction: state.compaction,
    unconfirmed: state.unconfirmed,
    cacheExpired: state.cacheExpired,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number no smaller than 0. */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * A decision as the router writes one: a tier and effort it knows, a model
 * id, a confidence 0–1.
 */
function isValidDecision(v: unknown): v is Decision {
  return (
    isRecord(v) &&
    (TIERS as readonly unknown[]).includes(v.tier) &&
    typeof v.model === "string" &&
    (EFFORTS as readonly unknown[]).includes(v.effort) &&
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    v.confidence >= 0 &&
    v.confidence <= 1 &&
    // What `/jev` and the route line print from: a number where one is read.
    [v.effortConfidence, v.heldWindow, v.heldBar].every((n) => n === undefined || isCount(n)) &&
    (v.heldCost === undefined ||
      (isRecord(v.heldCost) &&
        isCount(v.heldCost.stay) &&
        isCount(v.heldCost.go) &&
        (v.heldCost.limit === undefined || isCount(v.heldCost.limit)))) &&
    [v.jevFailed, v.heldModel].every((t) => t === undefined || typeof t === "string") &&
    [v.held, v.outgrew, v.wanted].every((t) => t === undefined || (TIERS as readonly unknown[]).includes(t)) &&
    [v.heldEffort, v.cappedEffort].every((t) => t === undefined || (EFFORTS as readonly unknown[]).includes(t))
  );
}

/** An attempt as the router writes one: a prompt, a time, a decision or a reason, usage in numbers. */
function isValidAttempt(v: unknown): boolean {
  if (!isRecord(v) || typeof v.prompt !== "string" || typeof v.ms !== "number" || !Number.isFinite(v.ms)) return false;
  if ("decision" in v ? !isValidDecision(v.decision) : typeof v.skipped !== "string") return false;
  if (v.cost !== undefined && !isCount(v.cost)) return false;
  if (
    v.agent !== undefined &&
    !(isRecord(v.agent) && typeof v.agent.label === "string" && (v.agent.type === undefined || typeof v.agent.type === "string"))
  )
    return false;
  if (v.usage !== undefined) {
    const u = v.usage;
    if (
      !isRecord(u) ||
      typeof u.model !== "string" ||
      ![u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].every(isCount)
    )
      return false;
  }
  return true;
}

/**
 * The state back from what the store returned, or null for anything that is
 * not a snapshot this version wrote. A bad snapshot is ignored, never
 * trusted: the router then starts over, which is what it did before this
 * file existed.
 */
export function unpack(raw: unknown): State | null {
  if (!isRecord(raw) || raw.v !== SNAPSHOT_VERSION) return null;
  const pool = raw.pool;
  // Every attempt is checked as a decision is: a corrupt one reaches the
  // route line, the summary and the spend total, which trust its fields.
  if (!Array.isArray(pool) || !pool.every(isValidAttempt)) return null;
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
  const unrouted = pairs(raw.unrouted);
  const turns = pairs(raw.turns);
  if (spawned === null || unrouted === null || turns === null) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  // Invalid decisions are dropped rather than trusted to their detriment.
  const decisions: [string, Decision][] = Array.isArray(raw.decisions)
    ? raw.decisions.filter(
        (p): p is [string, Decision] =>
          Array.isArray(p) && typeof p[0] === "string" && isValidDecision(p[1]),
      )
    : [];
  const decision = (v: unknown) => (isValidDecision(v) ? v : null);
  const lastUsage =
    isRecord(raw.lastUsage) &&
    isCount(raw.lastUsage.context) &&
    isCount(raw.lastUsage.output)
      ? { context: raw.lastUsage.context, output: raw.lastUsage.output }
      : null;
  // Every tier's cap must be an effort: one missing or misspelled would
  // cap that tier to nothing, and the request would go out with no effort.
  const ceiling = raw.ceiling;
  if (
    !isRecord(ceiling) ||
    !TIERS.every((t) => (EFFORTS as readonly unknown[]).includes(ceiling[t]))
  )
    return null;
  return {
    attempts,
    reply,
    replyAgents: raw.replyAgents.filter(
      (id): id is string => typeof id === "string",
    ),
    spawned,
    unrouted,
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
    spent: isCount(raw.spent) ? raw.spent : 0,
    enabled: raw.enabled !== false,
    announce: raw.announce !== false,
    // A snapshot from before this field exists has turns behind it.
    answered: raw.answered !== false,
    // A bar outside 0–1 would hold every switch, or none.
    sticky: typeof raw.sticky === "number" && raw.sticky > 0 && raw.sticky < 1 ? raw.sticky : null,
    ceiling: Object.fromEntries(TIERS.map((t) => [t, ceiling[t]])) as Ceiling,
    // Absent (a snapshot from before this field existed) is left undefined
    // — a signal to leave the environment's own JEV_ROUTER_EXCLUDE seeding
    // alone — rather than defaulted to an empty array, which used to
    // silently clear an env-seeded exclusion the moment such a snapshot was
    // restored (the field never existed to preserve it).
    excludedTiers:
      raw.excludedTiers === undefined
        ? undefined
        : strings(raw.excludedTiers).filter((t) =>
            (TIERS as readonly string[]).includes(t),
          ),
    compactOn: raw.compactOn !== false,
    priceCheck: raw.priceCheck !== false,
    overridden:
      raw.overridden === undefined
        ? undefined
        : strings(raw.overridden).filter((k): k is Overridable =>
            (OVERRIDABLE as readonly string[]).includes(k),
          ),
    summarisedAgents: Array.isArray(raw.summarisedAgents)
      ? raw.summarisedAgents.filter((a): a is string => typeof a === "string")
      : [],
    compaction: compactionOf(raw.compaction),
    unconfirmed:
      isRecord(raw.unconfirmed) && (raw.unconfirmed.was === null || isValidDecision(raw.unconfirmed.was))
        ? { was: raw.unconfirmed.was as Decision | null }
        : null,
    cacheExpired: raw.cacheExpired === true,
    ...(typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? { savedAt: raw.savedAt } : {}),
  };
}

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

/**
 * Claims (`<ownerPrefix><snapshot key>`) on a session that has no snapshot
 * and is not the current one: candidates to drop once they are old.
 */
export function orphanOwnerKeys(keys: readonly string[], ownerPrefix: string, current: string): string[] {
  const snapshots = new Set(keys.filter((k) => k.startsWith(SNAPSHOT_PREFIX)));
  return keys.filter((k) => {
    if (!k.startsWith(ownerPrefix)) return false;
    const target = k.slice(ownerPrefix.length);
    return target.startsWith(SNAPSHOT_PREFIX) && target !== current && !snapshots.has(target);
  });
}

/** When a stored snapshot was written, or null for one from before the field or not a snapshot. */
export function savedAtOf(raw: unknown): number | null {
  return isRecord(raw) && typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? raw.savedAt : null;
}

/**
 * The snapshot keys to drop so `SNAPSHOTS_KEPT` remain, least recently saved
 * first when `savedAt` says (a session saved on every turn is never the one
 * dropped, however long ago it started), else in the store's key order.
 */
export function staleKeys(
  keys: readonly string[],
  current: string,
  savedAt?: ReadonlyMap<string, number>,
): string[] {
  const sessions = keys.filter(
    (k) => k.startsWith(SNAPSHOT_PREFIX) && k !== current,
  );
  const excess = sessions.length + 1 - SNAPSHOTS_KEPT;
  if (excess <= 0) return [];
  const order = sessions
    .map((k, i) => ({ k, i, at: savedAt?.get(k) ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  return order.slice(0, excess).map((x) => x.k);
}
