import type { On } from "claude-code";

import {
  askJev,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
  type StateSource,
} from "./jev.ts";
import { labelOf, withLabel } from "./label.ts";
import {
  asAsked,
  ceilingAt,
  ceilingOf,
  effortNamed,
  excludedTiers,
  firstTurnEffort,
  isContinuation,
  isEngineNudge,
  notifyContinueOf,
  priceCheckOf,
  upgradeMaxOf,
  offeredTiers,
  overrideAllowedOf,
  parseOverride,
  sessionDecision,
  stickyOf,
  thresholdOf,
  tierFilter,
  DEFAULT_CEILING,
  EFFORTS,
  TIERS,
  type Ceiling,
  type Decision,
  type Effort,
  type Tier,
} from "./policy.ts";
import { baseModel, ttlOf, usageCost, type Ttl } from "./pricing.ts";
import {
  pack,
  SNAPSHOT_PREFIX,
  orphanOwnerKeys,
  savedAtOf,
  SNAPSHOTS_KEPT,
  staleKeys,
  unpack,
  OVERRIDABLE,
  type Overridable,
  type State,
} from "./persist.ts";
import { providerOf, type ProviderResult } from "./provider.ts";
import {
  compactOnOf,
  compactTimeoutOf,
  minReductionOf,
  pruneTranscript,
  shortOf,
  type Compaction,
} from "./compactor.ts";
import {
  addUsage,
  announceReply,
  attemptOf,
  carriedOf,
  ceilingCommand,
  normalUsage,
  continuationOf,
  continuationSkipped,
  HISTORY_LIMIT,
  kept,
  liveLine,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  notificationOf,
  notificationStateOf,
  notificationTaskOf,
  replySummary,
  spawnAttemptOf,
  statusReport,
  stickyCommand,
  tiersCommand,
  toggleReply,
  TYPICAL_OUTPUT_TOKENS,
  unknownCommandReply,
  ImitationFilter,
  isRouteLine,
  type AgentTag,
  type Attempt,
} from "./status.ts";

/** The slice of the engine a Jev call needs; every hook's `$` has it. */
type Engine = {
  env: { get: (key: string) => Promise<string | undefined> };
  http: {
    fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  };
  clock: { sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown> };
};

/** The stamp of the copy that holds a session, from its owner record, or null. */
async function ownerOf(
  $: { store: { get: (key: string) => Promise<unknown> } },
  key: string,
): Promise<number | null> {
  try {
    return stampOf(await $.store.get(`${OWNER_PREFIX}${key}`));
  } catch {
    return null;
  }
}

/** How much later than a copy's own last save a stored snapshot must be to count as another's. */
const HANDOFF_SLACK_MS = 1000;

/** Turns a reply keeps for its summary; past this the oldest go. */
const REPLY_LIMIT = 64;

/** Whether two ceilings cap every tier the same. */
const sameCeiling = (a: Ceiling, b: Ceiling) => TIERS.every((t) => a[t] === b[t]);

/** Turns kept in the decision cache before the oldest are dropped. */
const CACHE_LIMIT = 32;

/** A summary block, as `replySummary` writes it after `FOOTER_SEPARATOR`. */
const SUMMARY = /^\n\n```\n[^\n]*\(\d+% cached\)/;

/** Store key prefix for a claim on one turn, by its text. */
const TURN_PREFIX = "turn:";

/**
 * How long a claim on a turn's text stands. Copies of the module that see
 * the same turn see it within a second or two of each other; a prompt the
 * person repeats minutes later is a turn of its own.
 */
const TURN_CLAIM_MS = 60_000;

/** Turn claims kept in the store before the oldest are dropped. */
const TURN_CLAIMS_KEPT = 50;

/** A short stable hash of a turn's text, for its claim key. */
function textHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The claim key for a turn: its text, context, and session id, when known.
 * Two different, unrelated warm sessions that happen to report the exact
 * same token count for the same short prompt within the claim window no
 * longer collide, since the session id is always folded in here (closed
 * 2026-09-24; see the audit note in CHANGELOG-worthy commits for the
 * measured collision).
 *
 * Why this stays safe for the case the id itself was chosen to solve: on
 * 2026-09-23, one *live* copy kept routing a resumed conversation under its
 * old session id after the app rotated it. `turn.start` re-reads
 * `$.session.id()` on every turn (not only at `session.start`) and follows
 * it when it changes, so that one copy's own claim key tracks the new id
 * from its very next turn — nothing about folding the id in here breaks
 * that, since it is still the *same* copy computing both the old and the
 * new key over time, one after the other, not two copies racing on
 * different ids at once.
 *
 * What remains open: two genuinely *separate* copies (a same-process
 * module reload, or two processes) that each read a *different*, and
 * non-converging, id for what is really one conversation. A same-process
 * reload is already handled independently of this key, by `superseded` and
 * `ownsSession` sharing `globalThis` — the newer copy wins outright and the
 * older never even reaches a claim. A cross-process case with no shared
 * `globalThis` has no such fallback: each copy's turn key now differs (it
 * did not before this change either, once one of them reports a nonzero
 * context, which a resumed conversation typically does immediately), so
 * both may claim and both may write a line. This was not reproduced
 * independently of the regression test that first covered it, and closing
 * the far more easily reached collision — any two different sessions, same
 * prompt, same reported context — was judged the higher-value fix.
 */
function turnKey(
  text: string,
  contextTokens: number | string | null,
  sessionId: string | null = null,
): string {
  const base = `${textHash(text)}-${
    typeof contextTokens === "string" ? textHash(contextTokens) : (contextTokens ?? 0)
  }`;
  return sessionId !== null ? `${base}-${textHash(sessionId)}` : base;
}

/** Store key prefix for which copy of the module owns a session. */
const OWNER_PREFIX = "owner:";

/**
 * A claim unrefreshed for this long belongs to a copy that is gone. The
 * holder refreshes it on every turn, so only a copy that died (a process
 * killed without its session.end) lets it age this far.
 */
const OWNER_TTL_MS = 30 * 60 * 1000;

/** How often the holder refreshes its claim, well inside `OWNER_TTL_MS`. */
const OWNER_REFRESH_MS = 5 * 60 * 1000;

/** Store key prefix for when a session's holder last claimed it. */
const SEEN_PREFIX = "seen:";

/**
 * The holding copy's stamp from an owner record: a bare number, as every
 * version writes it (and `{ birth }` from a short-lived one that did not).
 */
function stampOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "object" && raw !== null && typeof (raw as { birth?: unknown }).birth === "number")
    return (raw as { birth: number }).birth;
  return null;
}

/** A `seen:` record: which copy claimed, and when. */
function seenOf(raw: unknown): { birth: number; at: number } | null {
  if (
    typeof raw === "object" && raw !== null &&
    typeof (raw as { birth?: unknown }).birth === "number" &&
    typeof (raw as { at?: unknown }).at === "number"
  )
    return { birth: (raw as { birth: number }).birth, at: (raw as { at: number }).at };
  return null;
}

/** How old a claim on a session with no snapshot must be before it is dropped. */
const ORPHAN_OWNER_MS = 24 * 60 * 60 * 1000;

/** How often a turn still running saves its state. */
const MID_TURN_SAVE_MS = 5_000;

/**
 * How many messages a transcript may have gained since it was scored for
 * the scoring to be reused with them appended: within the newest messages
 * pruning leaves alone (fast-jev-compaction's `preserveRecentMessages`).
 */
const PRUNE_TAIL_REUSED = 6;

/**
 * The decision a session is running on, from the model id the API reports
 * answered: a dated id (`claude-opus-5-5-20260901`) is its undated model.
 * Null for an id off the ladder or not a string.
 */
function warmDecision(model: unknown, effort: unknown): Decision | null {
  if (typeof model !== "string" || model === "") return null;
  const warm = sessionDecision(model.replace(/-\d{8}$/, ""));
  if (warm === null) return null;
  // The effort the step actually ran at, so a Sonnet effort hold does not
  // bind to a placeholder; a numeric or absent effort leaves the default.
  const name = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  const ran = (EFFORTS as readonly string[]).includes(name) ? (name as Effort) : null;
  return ran === null ? warm : { ...warm, effort: ran };
}

/**
 * Stop reasons that mean the turn continues: the engine will step again, so
 * a summary would land in the middle of a reply. `tool_use` and `pause_turn`
 * are the usual two; `compaction` is the engine compacting mid-turn and
 * carrying on, which wrote a second summary under one reply when it was
 * taken for an end (seen 2026-09-23). Every other reason ends the turn.
 */
const MID_TURN: ReadonlySet<string> = new Set([
  "tool_use",
  "pause_turn",
  "compaction",
]);

/**
 * Everything the router reads from the environment, read once. None of it
 * changes within a session, and reading them all on every turn was an await
 * each ahead of the Jev call. `sticky`, `ceiling`, `offered` and
 * `excluded` start here and are then owned by `/jev sticky`, `/jev ceiling`
 * and `/jev tiers`.
 */
type Settings = {
  provider: ProviderResult;
  timeoutMs: number;
  offered: readonly Tier[];
  excluded: readonly Tier[];
  sticky: number | null;
  ceiling: Ceiling;
  ttl: Ttl;
  allowOverride: boolean;
  notifyContinue: boolean;
  upgradeMax: number | null;
  /** The downgrade and upgrade price checks; `/jev price` owns it after the environment. */
  priceCheck: boolean;
  /** Compaction by Jev: on, how long it may take, how much it must remove. */
  compactOn: boolean;
  compactTimeoutMs: number;
  compactMinReduction: number;
};

/**
 * Reads the settings from the environment on first use. A top-level
 * function on purpose: the engine follows where `$` goes when it loads a
 * module, and only lets it into a function declared here at the top, so a
 * closure taking `$` inside `register` fails the whole module (measured
 * 2026-09-23: it loaded nothing and every turn went unrouted).
 */
async function seedSettings(
  $: Engine,
  current: Settings | null,
): Promise<Settings> {
  if (current !== null) return current;
  // Normalized together: JEV_ROUTER_EXCLUDE naming every tier falls back to
  // the full ladder in `offered`, and `excluded` must agree with that or
  // `/jev` can end up saying a tier is both offered and excluded.
  const tiers = tierFilter(excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE")));
  return {
    provider: providerOf({
      TYPESAFE_API_KEY: await $.env.get("TYPESAFE_API_KEY"),
      AI_GATEWAY_API_KEY: await $.env.get("AI_GATEWAY_API_KEY"),
      JEV_ROUTER_PROVIDER: await $.env.get("JEV_ROUTER_PROVIDER"),
      TYPESAFE_BASE_URL: await $.env.get("TYPESAFE_BASE_URL"),
      JEV_ROUTER_ALLOW_CUSTOM_BASE: await $.env.get(
        "JEV_ROUTER_ALLOW_CUSTOM_BASE",
      ),
      JEV_ROUTER_JEV_MODEL: await $.env.get("JEV_ROUTER_JEV_MODEL"),
    }),
    timeoutMs: timeoutOf(await $.env.get("JEV_ROUTER_TIMEOUT_MS")),
    offered: tiers.offered,
    excluded: tiers.excluded,
    sticky: stickyOf(await $.env.get("JEV_ROUTER_STICKY"))
      ? thresholdOf(await $.env.get("JEV_ROUTER_STICKY_CONFIDENCE"))
      : null,
    ceiling: ceilingOf(await $.env.get("JEV_ROUTER_CEILING")),
    ttl: ttlOf(await $.env.get("JEV_ROUTER_CACHE_TTL")),
    allowOverride: overrideAllowedOf(
      await $.env.get("JEV_ROUTER_ALLOW_OVERRIDE"),
    ),
    notifyContinue: notifyContinueOf(
      await $.env.get("JEV_ROUTER_NOTIFY_CONTINUE"),
    ),
    upgradeMax: upgradeMaxOf(await $.env.get("JEV_ROUTER_UPGRADE_MAX")),
    priceCheck: priceCheckOf(await $.env.get("JEV_ROUTER_PRICE_CHECK")),
    compactOn: compactOnOf(await $.env.get("JEV_ROUTER_COMPACT")),
    compactTimeoutMs: compactTimeoutOf(
      await $.env.get("JEV_ROUTER_COMPACT_TIMEOUT_MS"),
    ),
    compactMinReduction: minReductionOf(
      await $.env.get("JEV_ROUTER_COMPACT_MIN_REDUCTION"),
    ),
  };
}

/**
 * Asks Jev about one piece of text. Top-level, for the same reason as above.
 * `signal`, when given, is aborted by the caller if the turn is ceded to a
 * newer copy before this resolves — a saving only where the fetch honours
 * it (see askJev's own note); harmless to pass otherwise.
 */
async function classify(
  $: Engine,
  text: string,
  offered: readonly Tier[],
  settings: Settings,
  signal?: AbortSignal,
  source: StateSource = "prompt",
) {
  return askJev({
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms, options) => $.clock.sleep(ms, options),
    provider: settings.provider,
    state: text,
    offered,
    source,
    timeoutMs: settings.timeoutMs,
    signal,
  });
}

/**
 * The context the next turn will carry, in tokens, from the engine's own
 * count of the last response, or null when it has none yet (a fresh
 * session, or one just compacted, which is also when there is no cache to
 * protect). Older engines have no `usage()`; that reads as null too.
 */
async function contextTokensOf($: {
  session: {
    usage: () => Promise<{ context?: { tokens?: number } } | undefined>;
  };
}): Promise<number | null> {
  try {
    const usage = await $.session.usage();
    const tokens = usage?.context?.tokens;
    return typeof tokens === "number" && tokens > 0 ? tokens : null;
  } catch {
    return null;
  }
}

/** The store key for this session's snapshot, or null when the engine has no id. */
async function snapshotKeyOf($: {
  session: { id: () => Promise<string> };
}): Promise<string | null> {
  try {
    const id = await $.session.id();
    return typeof id === "string" && id !== "" ? `${SNAPSHOT_PREFIX}${id}` : null;
  } catch {
    return null;
  }
}

/** The snapshot saved under `key`, or null. Never throws. */
async function loadSnapshot(
  $: { store: { get: (key: string) => Promise<unknown> } },
  key: string,
): Promise<State | null> {
  try {
    return unpack(await $.store.get(key));
  } catch {
    return null;
  }
}

/**
 * Saves `state` under `key`. A session's first save drops the oldest
 * snapshots past `SNAPSHOTS_KEPT`. Never throws: losing a snapshot costs
 * what a reload cost before, and must not cost the turn.
 */
async function saveSnapshot(
  $: {
    store: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      keys: () => Promise<string[]>;
      delete: (key: string) => Promise<void>;
    };
  },
  key: string,
  state: State,
  first: boolean,
): Promise<void> {
  try {
    if (first) {
      const keys = await $.store.keys();
      // Only read when there is something to prune: one get per session.
      const sessions = keys.filter((k) => k.startsWith(SNAPSHOT_PREFIX) && k !== key);
      const savedAt = new Map<string, number>();
      if (sessions.length + 1 > SNAPSHOTS_KEPT)
        for (const k of sessions) {
          const at = savedAtOf(await $.store.get(k));
          if (at !== null) savedAt.set(k, at);
        }
      for (const stale of staleKeys(keys, key, savedAt)) {
        await $.store.delete(stale);
        await $.store.delete(`${OWNER_PREFIX}${stale}`);
        await $.store.delete(`${SEEN_PREFIX}${stale}`);
      }
      // A claim on a session that never saved (left at once for a /resume
      // or a /clear) has no snapshot to be pruned with; one a day old is
      // nobody's live session any more.
      for (const owner of orphanOwnerKeys(keys, OWNER_PREFIX, key)) {
        const seenKey = `${SEEN_PREFIX}${owner.slice(OWNER_PREFIX.length)}`;
        const stamp = stampOf(await $.store.get(owner));
        const seen = seenOf(await $.store.get(seenKey));
        const last = seen !== null && seen.birth === stamp ? seen.at : stamp;
        if (last === null || Date.now() - last > ORPHAN_OWNER_MS) {
          await $.store.delete(owner);
          await $.store.delete(seenKey);
        }
      }
      // Keys are kept in the order they were first written, and the oldest
      // are dropped; moving this session to the end makes that the order
      // of last use, so a long-lived session in use is never the one dropped.
      // The old snapshot is put back if the new one cannot be written.
      const previous = await $.store.get(key);
      await $.store.delete(key);
      try {
        await $.store.set(key, pack(state));
      } catch (error) {
        if (previous !== undefined) await $.store.set(key, previous).catch(() => undefined);
        throw error;
      }
      return;
    }
    await $.store.set(key, pack(state));
  } catch {
    // The store refused (over 4 MiB, a disk error): carry on unsaved.
  }
}

/**
 * Whether this copy of the module owns the session. When the plugin's files
 * change, the engine loads a fresh copy without retiring the old one, and
 * both then handle every turn: two Jev calls, two route lines, a summary
 * from each (seen 2026-09-23, from 14:54 on in one session). The newest copy
 * wins: each is stamped with its load time, the highest stamp is kept in the
 * store under `owner:<session>`, and a copy that finds a newer stamp there
 * stands aside. `claim` writes this copy's stamp when it is the newer one.
 * A store that cannot be read leaves every copy in charge, as before.
 */
async function ownsSession(
  $: {
    store: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
  key: string,
  birth: number,
  claim: boolean,
): Promise<boolean> {
  try {
    const ownerKey = `${OWNER_PREFIX}${key}`;
    const seenKey = `${SEEN_PREFIX}${key}`;
    const owner = stampOf(await $.store.get(ownerKey));
    const seen = seenOf(await $.store.get(seenKey));
    // When the holder last claimed, if it says: a copy of an earlier version
    // writes no `seen:` record, and its claim never goes stale here, as it
    // never did before.
    const lastSeen = owner !== null && seen !== null && seen.birth === owner ? seen.at : null;
    // A newer copy that has not been seen for a while is gone (a process
    // killed without its session.end): it no longer holds the session.
    const gone = lastSeen !== null && Date.now() - lastSeen >= OWNER_TTL_MS;
    if (owner !== null && owner > birth && !gone) return false;
    if (claim) {
      // The owner record stays a bare stamp, which earlier versions read.
      if (owner === null || owner < birth || gone) {
        await $.store.set(ownerKey, birth);
        await $.store.set(seenKey, { birth, at: Date.now() });
      } else if (owner === birth && (lastSeen === null || Date.now() - lastSeen >= OWNER_REFRESH_MS)) {
        // The holder refreshes every few minutes, not on every step.
        await $.store.set(seenKey, { birth, at: Date.now() });
      }
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Claims a turn for this copy, by the turn's text, context, and session id
 * (see `turnKey` for what that key does and does not close). The newest
 * copy wins: an older one that claimed first is overridden, and checks
 * again before it writes. False means a newer copy holds the turn. A store
 * that cannot be read lets the copy through, as before.
 */
async function claimTurn(
  $: {
    store: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      keys: () => Promise<string[]>;
      delete: (key: string) => Promise<void>;
    };
  },
  text: string,
  contextTokens: number | string | null,
  birth: number,
  sessionId: string | null = null,
): Promise<boolean> {
  try {
    const at = `${TURN_PREFIX}${turnKey(text, contextTokens, sessionId)}`;
    const now = Date.now();
    const held = (await $.store.get(at)) as { birth?: unknown; at?: unknown } | undefined;
    if (
      held &&
      typeof held.at === "number" &&
      typeof held.birth === "number" &&
      now - held.at < TURN_CLAIM_MS &&
      held.birth > birth
    ) {
      return false;
    }
    await $.store.set(at, { birth, at: now });
    // Another process may have written between the read and the write;
    // whichever claim the store holds now decides, newest winning.
    const after = (await $.store.get(at)) as { birth?: unknown } | undefined;
    if (typeof after?.birth === "number" && after.birth > birth) return false;
    const claims = (await $.store.keys()).filter((k) => k.startsWith(TURN_PREFIX));
    for (const old of claims.slice(0, Math.max(0, claims.length - TURN_CLAIMS_KEPT)))
      await $.store.delete(old);
    return true;
  } catch {
    return true;
  }
}

/** Whether this copy still holds a turn it claimed. Never throws; true when unreadable. */
async function holdsTurn(
  $: { store: { get: (key: string) => Promise<unknown> } },
  key: string,
  birth: number,
): Promise<boolean> {
  try {
    const held = (await $.store.get(`${TURN_PREFIX}${key}`)) as
      | { birth?: unknown }
      | undefined;
    return typeof held?.birth !== "number" || held.birth === birth;
  } catch {
    return true;
  }
}

/** Drops this copy's claim on the session, if it still holds it. Never throws. */
async function releaseSession(
  $: {
    store: {
      get: (key: string) => Promise<unknown>;
      delete: (key: string) => Promise<void>;
    };
  },
  key: string,
  birth: number,
): Promise<void> {
  try {
    const at = `${OWNER_PREFIX}${key}`;
    if (stampOf(await $.store.get(at)) === birth) {
      await $.store.delete(at);
      await $.store.delete(`${SEEN_PREFIX}${key}`);
    }
  } catch {
    // Nothing to release, or the store is unreadable: the next claim decides.
  }
}

/** Where the session draws first (`terminal`, `desktop`, ...), or null in a plain -p run. */
async function surfaceOf($: {
  session: { surfaces: () => Promise<readonly string[]> };
}): Promise<string | null> {
  try {
    return (await $.session.surfaces())[0] ?? null;
  } catch {
    return null;
  }
}

/** The main loop's model as `/model` shows it, or null when the engine has none. */
async function sessionModelOf($: {
  session: { model: () => Promise<string> };
}): Promise<string | null> {
  try {
    const model = await $.session.model();
    return typeof model === "string" && model !== "" ? model : null;
  } catch {
    return null;
  }
}

/**
 * True while any of `ids` is still running: the reply that spawned them is
 * not over. Only the reply's own agents count — one from an earlier reply,
 * or a long-lived one, must not hold every later summary hostage.
 */
async function agentsRunning(
  $: { agent: { list: () => Promise<readonly { id: string; status: string }[]> } },
  ids: ReadonlySet<string>,
): Promise<boolean> {
  if (ids.size === 0) return false;
  const rows = await $.agent.list().catch(() => []);
  return rows.some((r) => ids.has(r.id) && r.status === "running");
}

/**
 * Names the subagent a step runs in, from the session's agent list. A row may
 * not be there yet for a loop that only just started; then the id stands in,
 * which still says "not the main loop", the part that matters.
 */
async function agentTagOf(
  $: {
    agent: {
      list: () => Promise<
        readonly { id: string; type: string; description: string }[]
      >;
    };
  },
  agentId: string,
): Promise<AgentTag> {
  const rows = await $.agent.list().catch(() => []);
  const row = rows.find((r) => r.id === agentId);
  return row ? { type: row.type, label: row.description } : { label: agentId };
}

/**
 * Registers the router: one Jev call per turn, applied to every model request
 * that turn makes, and announced as it happens.
 *
 * The decision is made once in `turn.start`, where the person's text is, and
 * read back in `turn.step`, which fires again after each tool result. Asking
 * per step would pay Jev's latency several times over and could land two
 * steps of one turn on different models.
 *
 * Every turn's outcome is kept, routed or not, because "did this do anything"
 * is unanswerable otherwise: a router that fails open looks exactly like one
 * that is not loaded.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  /** When this copy was loaded; the newest copy owns the session. */
  // Copies loaded into one runtime share `globalThis`; the newest stands, and
  // this holds even for a copy that cannot read a session id to claim with.
  // A copy's stamp is always above every one already there, so two loaded
  // in the same millisecond still have an order; the fraction keeps copies
  // in different processes, which share only the store, from tying.
  const runtime = globalThis as {
    __jevRouterNewest?: number;
    /** The newest copy's live state, for the copy that replaces it. */
    __jevRouterLive?: () => { key: string; state: unknown; savedAt: number; birth: number } | null;
  };
  const birth = Math.max(
    Date.now() + Math.random() * 0.001,
    (runtime.__jevRouterNewest ?? 0) + 0.001,
  );
  runtime.__jevRouterNewest = birth;
  const superseded = () => birth < (runtime.__jevRouterNewest ?? 0);
  // A reload mid-turn: the copy being replaced holds what it has not saved
  // yet (mid-turn saves are throttled), so this copy takes its live state
  // for the same session, once, over the store's older snapshot.
  let previousLive = runtime.__jevRouterLive;
  runtime.__jevRouterLive = () =>
    snapshotKey ? { key: snapshotKey, state: pack(stateNow()), savedAt: lastSavedAt, birth } : null;
  // Only from the copy that holds the session in this store (its claim is
  // the owner record), so a copy for another store or a session that was
  // never this one's is not taken for a reload; and only when the store's
  // snapshot is no newer than that copy's own last save: one saved later
  // came from another process that went on in the session.
  // Whatever is restored, its save time is this copy's starting point, so
  // the next reload can tell it from a newer one in turn.
  const restoredFrom = (key: string, stored: State | null, owner: number | null): State | null => {
    const previous = previousLive?.();
    previousLive = undefined;
    const fromStore = () => {
      lastSavedAt = stored?.savedAt ?? lastSavedAt;
      return stored;
    };
    if (!previous || previous.key !== key || owner !== previous.birth) return fromStore();
    if (stored?.savedAt !== undefined && stored.savedAt > previous.savedAt + HANDOFF_SLACK_MS) return fromStore();
    const live = unpack(JSON.parse(JSON.stringify(previous.state)));
    if (live === null) return fromStore();
    lastSavedAt = previous.savedAt;
    return live;
  };
  /** True once a newer copy has claimed the session: this one stands aside. */
  let inert = false;
  /** The engine said the resumed session's cache has expired, and no response has written it since. */
  let cacheExpired = false;
  /** A resume or fork event has said whether the cache expired: that outranks a snapshot's word. */
  let resumeSpoke = false;
  /**
   * A response has been received in this conversation. The engine runs some
   * efforts as others on a conversation's first request only
   * (FIRST_TURN_EFFORT); measured 2026-09-23, the first request after a
   * compaction runs the effort asked for, so a compaction does not reset
   * this. A `/clear` does: it is a new conversation.
   */
  let answered = false;
  /** The last compaction Jev was asked about, for /jev. */
  let lastCompaction: Compaction | null = null;
  /**
   * The last transcript Jev pruned and what it kept: the engine compacts
   * ahead of time (`precompute`) and then for real over the same messages,
   * and each dispatch would otherwise be another scoring.
   */
  let prunedCache: {
    handles: readonly string[];
    messages: readonly unknown[];
    reduction: number;
    compaction: Compaction;
  } | null = null;
  /** Turns a newer copy claimed: this one passes them through untouched. */
  const ceded = new Set<string>();
  /** Agents whose reply's summary has been written: their wake-up joins no other. */
  const summarisedAgents = new Set<string>();
  /** Each claimed turn's text, to check the claim again before writing. */
  const claimed = new Map<string, string>();
  let settings: Settings | null = null;
  const decisions = new Map<string, Decision>();
  /**
   * Turns whose reply has yet to open with its route line. The line itself is
   * built at the first text chunk, not here: by then the step has said which
   * loop the turn runs in, which the line names.
   */
  const pending = new Set<string>();
  const attempts: Attempt[] = [];
  /**
   * turnId → its attempt, so each step's `stop` chunk can add what the API
   * reported to the right turn. The same objects as in `attempts`.
   */
  const byTurn = new Map<string, Attempt>();
  /**
   * Every turn since the last one the person typed, agents included: what
   * one reply took, written under it once, at the end. A reply that spawns
   * background work is several turns — the typed one, then one per task
   * that finished and woke the loop — and a block under each read as one
   * reply changing model three times.
   */
  let reply: Attempt[] = [];
  /** The agents the current reply spawned; its summary waits for them. */
  let replyAgents = new Set<string>();
  let latest: Decision | null = null;
  /** The tier the last routed turn ran on; what a shaky switch is held to. */
  let running: Decision | null = null;
  /**
   * What was running before this turn moved `running` to a new model, until
   * a response on it confirms the new model's cache was written. A turn
   * interrupted or failed before any response wrote nothing, so the next
   * turn goes back to pricing against what is actually warm.
   */
  let unconfirmed: { was: Decision | null } | null = null;
  /** What that turn carried and produced, for pricing the next switch. */
  let lastUsage: { context: number; output: number } | null = null;
  /** The main loop's model as `/model` shows it, read when first needed. */
  let sessionModel: string | null = null;
  /**
   * What a bare go-ahead continues. Cleared on an unrouted turn: that turn
   * ran on the session model, so re-applying the older routed decision would
   * be wrong. Stickiness still holds to `running` (last routed).
   */
  let continueFrom: Decision | null = null;
  let enabled = true;
  let announce = true;
  let surface: string | null = null;
  /** Dollars across every turn seen this session, at list price. */
  let spent = 0;
  /** When the state was last saved mid-turn; end-of-turn saves are not throttled. */
  let lastMidTurnSave = 0;
  /**
   * agentId → what its spawn settled on, for the subagent's own steps to
   * apply and for /jev to show. Keyed by the id `next(e)` hands back from
   * `agent.spawn`, which is the same id the loop's `turn.step` carries.
   */
  const spawned = new Map<string, Attempt>();
  /** Agents the router left alone (forks, a named model), for one history row each. */
  const unrouted = new Map<string, Attempt>();
  /** Agents whose first step has run, so later steps get Jev's effort. */
  const stepped = new Set<string>();

  const trim = (map: Map<string, unknown>) => {
    while (map.size > CACHE_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  /**
   * Drop idle turn rows, but never an in-flight one still in `pending` or
   * `decisions` — those still need the route line and usage fold-in. If every
   * entry is protected, the map is allowed to grow past the limit.
   */
  const trimByTurn = () => {
    let scanned = 0;
    while (byTurn.size > CACHE_LIMIT && scanned < byTurn.size) {
      const oldest = byTurn.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      if (pending.has(key) || decisions.has(key)) {
        touch(byTurn, key, byTurn.get(key)!);
        scanned++;
        continue;
      }
      byTurn.delete(key);
      scanned = 0;
    }
  };

  /** Move a live entry to the end so FIFO trim drops idle keys first. */
  const touch = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
  };

  const trimSet = (set: Set<string>) => {
    while (set.size > CACHE_LIMIT) {
      const oldest = set.values().next();
      if (oldest.done) break;
      set.delete(oldest.value);
    }
  };

  /**
   * Forget what the main loop was running on and the turns in flight. After
   * `/jev off` the session model answers, and after `/clear` or a resume
   * into another session the cache the hold was protecting is not this
   * conversation's, so the next routed turn starts from Jev's word. (A
   * compaction forgets only what was warm; see session.compact.)
   */
  const clearRouting = () => {
    decisions.clear();
    byTurn.clear();
    pending.clear();
    // spawned is kept: turn.step already ignores it while off, and clearing
    // it made /jev on mid-agent invent "not routed at spawn" and drop effort.
    latest = null;
    continueFrom = null;
    running = null;
    unconfirmed = null;
    lastUsage = null;
  };

  /**
   * This session's snapshot key: undefined until looked up, null when the
   * engine gives no session id (then nothing is saved or restored).
   */
  let snapshotKey: string | null | undefined = undefined;
  let savedOnce = false;
  /** False right after `/clear`: the next key lookup must not restore. */
  let restoreOnKey = true;

  /** When this copy last saved, for a replacing copy to tell its snapshot from a newer one. */
  let lastSavedAt = 0;
  /** The state to save, noting when. */
  const stateToSave = (): State => {
    lastSavedAt = Date.now();
    return stateNow();
  };

  /** The settings a `/jev` command set this session, which outrank the environment. */
  const overridden = new Set<Overridable>();

  const stateNow = (): State => ({
    attempts,
    reply,
    replyAgents: [...replyAgents],
    spawned: [...spawned.entries()],
    unrouted: [...unrouted.entries()],
    turns: [...byTurn.entries()],
    decisions: [...decisions.entries()],
    pending: [...pending],
    stepped: [...stepped],
    running,
    continueFrom,
    latest,
    lastUsage,
    sessionModel,
    spent,
    enabled,
    announce,
    answered,
    sticky: settings?.sticky ?? null,
    ceiling: settings?.ceiling ?? ceilingAt(DEFAULT_CEILING),
    excludedTiers: [...(settings?.excluded ?? [])],
    compactOn: settings?.compactOn ?? true,
    priceCheck: settings?.priceCheck ?? true,
    overridden: [...overridden],
    summarisedAgents: [...summarisedAgents],
    compaction: lastCompaction,
    unconfirmed,
    cacheExpired,
  });

  /** Puts a restored snapshot back, over what the environment seeded. */
  const applyState = (s: State | null) => {
    if (s === null) return;
    attempts.splice(0, attempts.length, ...s.attempts);
    reply = s.reply;
    replyAgents = new Set(s.replyAgents);
    spawned.clear();
    for (const [id, a] of s.spawned) spawned.set(id, a);
    unrouted.clear();
    for (const [id, a] of s.unrouted) unrouted.set(id, a);
    byTurn.clear();
    for (const [id, a] of s.turns) byTurn.set(id, a);
    decisions.clear();
    for (const [id, d] of s.decisions) decisions.set(id, d);
    pending.clear();
    for (const id of s.pending) pending.add(id);
    stepped.clear();
    for (const id of s.stepped) stepped.add(id);
    running = s.running;
    continueFrom = s.continueFrom;
    latest = s.latest;
    lastUsage = s.lastUsage;
    sessionModel = s.sessionModel ?? sessionModel;
    spent = s.spent;
    enabled = s.enabled;
    announce = s.announce;
    answered = s.answered;
    lastCompaction = s.compaction;
    unconfirmed = s.unconfirmed;
    // A resume event this copy saw speaks for the session now; a snapshot
    // saved before it does not.
    if (!resumeSpoke) cacheExpired = s.cacheExpired;
    summarisedAgents.clear();
    for (const id of s.summarisedAgents) summarisedAgents.add(id);
    // Only what a command set outranks the environment; the rest stays as
    // the environment seeded it, so a changed JEV_ROUTER_* holds on reload.
    // A snapshot from before `overridden` existed restores them all.
    const restore = new Set<Overridable>(s.overridden ?? OVERRIDABLE);
    overridden.clear();
    for (const k of restore) overridden.add(k);
    if (settings !== null) {
      if (restore.has("sticky")) settings.sticky = s.sticky;
      if (restore.has("ceiling")) settings.ceiling = s.ceiling;
      // undefined means the snapshot predates this field: leave the
      // environment's own JEV_ROUTER_EXCLUDE seeding in place rather than
      // overwrite it with "nothing excluded" (see State.excludedTiers).
      if (restore.has("excludedTiers") && s.excludedTiers !== undefined) {
        const tiers = tierFilter(s.excludedTiers as Tier[]);
        settings.excluded = tiers.excluded;
        settings.offered = tiers.offered;
      }
      if (restore.has("compactOn")) settings.compactOn = s.compactOn;
      if (restore.has("priceCheck")) settings.priceCheck = s.priceCheck;
    }
  };

  /** Whether this save is the session's first, which prunes old sessions. */
  const firstSave = () => {
    const first = !savedOnce;
    savedOnce = true;
    return first;
  };

  const record = (attempt: Attempt) => {
    attempts.unshift(attempt);
    attempts.length = Math.min(attempts.length, HISTORY_LIMIT);
    reply.push(attempt);
    // A reply that never closes (the engine's nudges alone, or quiet) must
    // not grow the snapshot without end: past the limit the oldest turns
    // after its first go. The first is kept: it is the one the person typed,
    // which lets the summary be written at all.
    if (reply.length > REPLY_LIMIT) reply.splice(1, reply.length - REPLY_LIMIT);
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description: "Jev routing: status, on/off, sticky, price, ceiling, compact, quiet/loud.",
    });
    surface = await surfaceOf($);
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    // A reloaded copy gets its own session.start, so it claims the session
    // the moment it loads; an older copy then stands aside from the next
    // turn on, instead of both asking Jev on the first one.
    if (snapshotKey) inert = !(await ownsSession($, snapshotKey, birth, true));
    sessionModel = await sessionModelOf($);
    return next(e);
  });

  // The session ending releases its claim, so a copy in another process
  // that resumes the same session later is not left standing aside behind
  // an owner that no longer exists.
  on("session.end", async ($, e, next) => {
    if (snapshotKey && !inert) await releaseSession($, snapshotKey, birth);
    return next(e);
  });

  // A resumed session is already running on something, with a cache the
  // first routed turn's switch should be priced against — unless the engine
  // says that cache has expired, in which case there is nothing to protect.
  // `/clear` starts a new conversation: nothing is running.
  on("classic.SessionStart", async ($, e, next) => {
    if (e.source === "clear") {
      // The old conversation is saved as it stands, and its claim goes; the
      // next lookup claims afresh.
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      if (snapshotKey && !inert) await releaseSession($, snapshotKey, birth);
      // A new conversation, and a new transcript id: its state is saved
      // under that, so a later resume of the old session restores the old
      // session's. The engine does not say when the id rotates, so the key
      // is looked up again on the next hook, when it has — and that lookup
      // must not restore, or it would undo the clear.
      clearRouting();
      reply = [];
      replyAgents = new Set();
      snapshotKey = undefined;
      restoreOnKey = false;
      attempts.length = 0;
      spent = 0;
      answered = false;
      savedOnce = false;
      // Compaction cache: the next turn starts fresh, so any previous prune
      // score is invalid.
      prunedCache = null;
      // A new conversation has no cache to have expired.
      cacheExpired = false;
      // Nor a compaction, or finished agents of its own. An agent still
      // running from before the clear keeps its routing.
      lastCompaction = null;
      summarisedAgents.clear();
      // An unreadable list keeps them all: it says nothing about which run.
      const rows = await $.agent.list().catch(() => null);
      if (rows !== null) {
        const live = new Set(rows.filter((a) => a.status === "running").map((a) => a.id));
        for (const id of [...spawned.keys()]) if (!live.has(id)) spawned.delete(id);
        for (const id of [...stepped]) if (!live.has(id)) stepped.delete(id);
      }
      unrouted.clear();
    }
    // A resume or fork into a different session, in a process already
    // running one: the old session's routing must not carry over. Its state
    // is dropped, and the next hook restores the resumed session's own.
    // Also right after a /clear, which left the key to be looked up again
    // and the restore off: a resume is a restore, whatever came before it.
    if (e.source === "resume" || e.source === "fork") {
      const key = await snapshotKeyOf($);
      if (snapshotKey === undefined || key !== snapshotKey) {
        // This copy leaves the old session: what it has not saved is saved
        // first, and its claim goes with it, or a process that resumes that
        // session later stands aside for good.
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
        if (snapshotKey && !inert) await releaseSession($, snapshotKey, birth);
        // Settings too: what a command set in the old session is not the
        // resumed one's. The environment seeds them again, and the resumed
        // session's snapshot puts back only what its own commands set.
        settings = null;
        overridden.clear();
        enabled = true;
        announce = true;
        // The old session's expired cache is not this one's; the resume
        // event below says whether this one's has.
        cacheExpired = false;
        // Its compaction, scoring and agents are the old session's too.
        lastCompaction = null;
        prunedCache = null;
        spawned.clear();
        unrouted.clear();
        stepped.clear();
        summarisedAgents.clear();
        // The resumed session's model is read afresh, not the one this
        // process was on (a resume's own model switch is not reported).
        sessionModel = null;
        clearRouting();
        reply = [];
        replyAgents = new Set();
        attempts.length = 0;
        spent = 0;
        answered = typeof e.context_tokens === "number" && e.context_tokens > 0;
        snapshotKey = undefined;
        restoreOnKey = true;
        savedOnce = false;
      }
    }
    // The cache has expired: what is running is still known, and the next
    // switch is priced with staying as a write too, snapshot or not.
    // Every resume says afresh whether its own cache has expired; what an
    // earlier one said is not this session's.
    if (e.source === "resume" || e.source === "fork") {
      cacheExpired = e.prompt_cache_likely_expired === true;
      resumeSpoke = true;
    }
    if (
      (e.source === "resume" || e.source === "fork") &&
      running === null &&
      typeof e.context_tokens === "number" &&
      e.context_tokens > 0 &&
      typeof e.model === "string"
    ) {
      running = sessionDecision(e.model);
      unconfirmed = null;
      if (running !== null) {
        lastUsage = { context: e.context_tokens, output: TYPICAL_OUTPUT_TOKENS };
      }
    }
    return next(e);
  });

  // The cache the hold was protecting does not survive a compaction, and the
  // context is small again, so switches are cheap: start over from Jev. Only
  // what the next turn is priced against is dropped: the engine compacts
  // mid-turn too, and the turn in flight keeps its route, its line and its
  // usage. A subagent compacting its own transcript is not the main loop's.
  on("session.compact", async ($, e, next) => {
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    // Jev prunes the transcript instead of the engine summarising it:
    // every tool call is scored, stale ones go or are cut, and what stays
    // is verbatim. One copy does it; anything short of a good result
    // leaves the engine's summary to run.
    let pruned: { messages: readonly typeof e.messages[number][] } | null = null;
    let reduction = 0;
    // Characters removed from the transcript, for what the next turn carries.
    let removedChars = 0;
    const transcript = Array.isArray(e.messages) ? e.messages : [];
    // `/compact <what to keep>` is an instruction to the summariser; Jev's
    // pruning has no way to follow it, so the summary runs.
    const instructed = typeof e.instructions === "string" && e.instructions.trim() !== "";
    // A transcript already scored, or one it is a prefix of: the engine
    // compacts ahead of time and then for real a message or two later, and
    // those messages are inside the zone pruning never touches anyway.
    const handles = transcript.map((m) => m.handle ?? "");
    // The cache is the main loop's: a subagent's transcript is another
    // conversation, and must neither reuse nor replace its scoring.
    const cached =
      e.agentId === undefined &&
      prunedCache !== null &&
      handles.every((h) => h !== "") &&
      handles.length >= prunedCache.handles.length &&
      handles.length - prunedCache.handles.length <= PRUNE_TAIL_REUSED &&
      prunedCache.handles.every((h, i) => h === handles[i])
        ? prunedCache
        : null;
    const mine =
      !inert &&
      !superseded() &&
      !(snapshotKey && !(await ownsSession($, snapshotKey, birth, false)));
    if (enabled && settings.compactOn && !instructed && transcript.length > 0 && cached !== null && mine) {
      const tail = transcript.slice(cached.handles.length);
      pruned = {
        messages: [...(cached.messages as unknown as typeof e.messages), ...tail],
      };
      // The scoring's reduction covers the part it scored; the appended
      // tail is kept whole, so the share removed overall is smaller.
      const size = (ms: readonly (typeof e.messages)[number][]) =>
        ms.reduce((n, m) => n + m.text.length + JSON.stringify(m.toolUses).length + JSON.stringify(m.toolResults ?? []).length, 0);
      const all = size(transcript);
      reduction = all > 0 ? cached.reduction * (1 - size(tail) / all) : cached.reduction;
      removedChars = Math.round(reduction * all);
      // The tail can dilute it below the bar the scoring cleared: then the
      // engine's summary runs, as it would have for a fresh scoring.
      const short = shortOf(reduction, settings.compactMinReduction);
      const compaction: Compaction = {
        ...cached.compaction,
        at: Date.now(),
        kept: pruned.messages.length,
        of: transcript.length,
        reduction,
        ms: 0,
        ...(short !== undefined ? { fallback: short } : {}),
      };
      if (e.agentId === undefined) lastCompaction = compaction;
      if (short !== undefined) {
        pruned = null;
        reduction = 0;
        removedChars = 0;
      }
    } else if (
      enabled &&
      settings.compactOn &&
      !instructed &&
      transcript.length > 0 &&
      mine
    ) {
      const result = await pruneTranscript({
        messages: transcript,
        provider: settings.provider,
        fetch: (url, init) => $.http.fetch(url, init),
        sleep: (ms, options) => $.clock.sleep(ms, options),
        timeoutMs: settings.compactTimeoutMs,
        minReduction: settings.compactMinReduction,
      });
      // The main conversation's, for /jev; a subagent's transcript is its own.
      if (e.agentId === undefined) lastCompaction = result.compaction;
      // The library's message shape is the engine's, less the engine's own
      // `true | undefined` spelling of isError (rebuilt blocks carry false).
      if (result.ok) {
        pruned = { messages: result.messages as unknown as typeof e.messages };
        if (e.agentId === undefined) prunedCache = {
          handles,
          messages: result.messages,
          reduction: result.compaction.reduction,
          compaction: result.compaction,
        };
        reduction = result.compaction.reduction;
        removedChars = Math.round(
          reduction *
            transcript.reduce(
              (n, m) =>
                n +
                m.text.length +
                JSON.stringify(m.toolUses).length +
                JSON.stringify(m.toolResults ?? []).length,
              0,
            ),
        );
      }
    }
    // A copy that does not own the session leaves its state alone.
    if (!mine) {
      inert = true;
      return next(e);
    }
    if (e.trigger !== "precompute" && e.agentId === undefined) {
      if (pruned === null) {
        // The engine's summary: a new prefix, nothing warm, a small context.
        // What a go-ahead continues is the work, not the cache, so it stays:
        // "yes" after a compaction still runs on the tier that proposed it.
        running = null;
        unconfirmed = null;
        lastUsage = null;
      } else if (lastUsage !== null) {
        // Pruned: the opening of the transcript stays verbatim, so the
        // cache is partly warm on the same model and the context is only
        // as much smaller as was removed. The hold stands; what the next
        // turn carries is scaled, so the window guard and the price checks
        // still see a large context, not none.
        // Only the transcript shrank; the system prompt and tools did not.
        // Characters over four is the generous side of a token count, so
        // the estimate errs large, which holds rather than switches.
        lastUsage = {
          context: Math.max(0, Math.round(lastUsage.context - removedChars / 4)),
          output: lastUsage.output,
        };
      }
    }
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
    return pruned ?? next(e);
  });

  // `/model` moved the main loop: what was running is not any more, and the
  // next routed turn is priced against the new model, which the turn seeds
  // from the session when the engine reports context.
  on("classic.PostModelSwitch", async ($, e, next) => {
    // A resume restores the model it left on; that is not a move, and the
    // resume hook has just seeded what is running on it.
    if (e.source === "resume") return next(e);
    // A switch right after a resume into another session: that session's
    // snapshot is restored first, or the next hook's restore would put its
    // old model back over this switch.
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    if (typeof e.to_model === "string") sessionModel = e.to_model;
    running = null;
    unconfirmed = null;
    continueFrom = null;
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e, next) => {
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    // An older copy hands /jev to the owner: answering itself would report
    // its frozen state and change settings the owner never sees.
    if (
      inert ||
      superseded() ||
      (snapshotKey && !(await ownsSession($, snapshotKey, birth, false)))
    ) {
      inert = true;
      return next(e);
    }
    // One space between words, whatever was typed (tabs, runs of spaces),
    // and a leading dash or two dropped with any space after it: `/jev -- off`.
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, " ");
    const sub = arg.replace(/^-+\s*/, "");

    // The dash-stripped spelling throughout, so `/jev --on` works as
    // `/jev --sticky` does.
    if (sub === "on" || sub === "off") {
      enabled = sub === "on";
      if (!enabled) clearRouting();
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      return { text: toggleReply(enabled) };
    }

    if (sub === "price" || sub.startsWith("price ")) {
      const want = sub.slice("price".length).trim();
      if (want === "on" || want === "off") {
        settings.priceCheck = want === "on";
        overridden.add("priceCheck");
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      } else if (want !== "") {
        return { text: unknownCommandReply(sub, false) };
      }
      return {
        text: settings.priceCheck
          ? "price checks on: a move to a cheaper tier has to save money, cache included, and a move to a dearer one may cost at most the upgrade limit over staying. /jev price off switches on Jev's word and the confidence bar alone."
          : "price checks off: switches follow Jev and the confidence bar, whatever the cache costs. /jev price on to weigh the cost again.",
      };
    }

    if (sub === "compact" || sub.startsWith("compact ")) {
      const want = sub.slice("compact".length).trim();
      if (want === "on" || want === "off") {
        settings.compactOn = want === "on";
        overridden.add("compactOn");
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      } else if (want !== "") {
        return { text: unknownCommandReply(sub, false) };
      }
      return {
        text:
          `compaction by Jev ${settings.compactOn ? "on" : "off"}` +
          (settings.compactOn
            ? ": at each compaction, Jev scores every tool call and the stale ones are dropped or cut; the conversation stays verbatim. /jev compact off restores the engine's summary."
            : ": the engine's own summary runs. /jev compact on to prune with Jev instead."),
      };
    }

    if (sub === "quiet" || sub === "loud") {
      announce = sub === "loud";
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      return { text: announceReply(announce) };
    }

    // `--sticky` as well as `sticky`: the flag spelling is what people reach
    // for, and refusing it would teach nothing.
    if (sub === "sticky" || sub.startsWith("sticky ")) {
      const result = stickyCommand(sub.slice("sticky".length), settings.sticky);
      if (result.sticky !== settings.sticky) overridden.add("sticky");
      settings.sticky = result.sticky;
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      return { text: result.text };
    }

    if (sub === "ceiling" || sub.startsWith("ceiling ")) {
      const result = ceilingCommand(
        sub.slice("ceiling".length),
        settings.ceiling,
      );
      if (!sameCeiling(result.ceiling, settings.ceiling)) overridden.add("ceiling");
      settings.ceiling = result.ceiling;
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      return { text: result.text };
    }

    if (sub === "tiers" || sub.startsWith("tiers ")) {
      const result = tiersCommand(sub.slice("tiers".length), settings.excluded);
      const tiers = tierFilter(result.excluded);
      if (tiers.excluded.join() !== settings.excluded.join()) overridden.add("excludedTiers");
      settings.excluded = tiers.excluded;
      settings.offered = tiers.offered;
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      return { text: result.text };
    }

    // `/jev medium`, `/jev xhigh fable`: an effort on its own is the ceiling
    // command's shorthand. The removed toggles (`/jev xhigh on`) are named
    // and pointed at their replacement rather than silently read as status.
    const [head, ...rest] = sub.split(/\s+/);
    if (head !== undefined && head !== "") {
      const legacy = rest[0] === "on" || rest[0] === "off";
      if ((effortNamed(head) !== null || head === "ultra") && !legacy) {
        const result = ceilingCommand(sub, settings.ceiling);
        if (!sameCeiling(result.ceiling, settings.ceiling)) overridden.add("ceiling");
        settings.ceiling = result.ceiling;
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
        return { text: result.text };
      }
      return { text: unknownCommandReply(sub, legacy) };
    }

    if (surface === null) surface = await surfaceOf($);
    if (sessionModel === null) sessionModel = await sessionModelOf($);
    const contextTokens =
      (await contextTokensOf($)) ?? lastUsage?.context ?? null;
    return {
      text: statusReport({
        enabled,
        surface,
        provider: settings.provider,
        timeoutMs: settings.timeoutMs,
        sticky: settings.sticky,
        upgradeMax: settings.upgradeMax,
        price: settings.priceCheck,
        ceiling: settings.ceiling,
        compactOn: settings.compactOn,
        compaction: lastCompaction,
        ttl: settings.ttl,
        cold: cacheExpired,
        contextTokens,
        sessionModel,
        running,
        offered: settings.offered,
        excluded: settings.excluded,
        announce,
        attempts,
        spent,
      }),
    };
  });

  on("turn.start", async ($, e, next) => {
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    // After the restore: a resumed session's own /jev off or on is what
    // decides this turn, not the one this process was in before.
    if (!enabled) return next(e);
    // The newest copy of the module handles the turn; an older one stands aside.
    // The session's id can change under a live copy (a resume into a new
    // id); keep the state and follow the id, so every copy claims one key.
    if (snapshotKey !== undefined) {
      const current = await snapshotKeyOf($);
      if (current !== null && current !== snapshotKey) {
        // The old id's claim is released, as on a resume.
        if (snapshotKey && !inert) await releaseSession($, snapshotKey, birth);
        snapshotKey = current;
        savedOnce = false;
      }
    }
    // Decided afresh each turn: standing aside is about who holds the
    // session now, so a turn that stood aside does not switch routing off
    // for the rest of a session with no id to claim.
    if (superseded()) inert = true;
    else inert = snapshotKey ? !(await ownsSession($, snapshotKey, birth, true)) : false;
    if (inert) return next(e);
    // The last turn switched and then ended with no response on the new
    // model: nothing was written there, so what was warm before still is.
    if (unconfirmed !== null) {
      running = unconfirmed.was;
      unconfirmed = null;
    }
    const { offered, ceiling } = settings;
    // Jev is the long pole of the turn, so it is asked before anything
    // else is read. A copy that then cedes the turn drops the answer: one
    // wasted call, only when a stale copy is loaded, is cheaper than a
    // round trip ahead of Jev on every turn. `askAbort` lets a cede cancel
    // it in flight, where the fetch honours that (see classify's note);
    // where it does not, the call still completes and is billed regardless.
    const notification = notificationOf(e.text) !== null;
    const nudge = isEngineNudge(e.text) || e.text.trim() === "";
    // A task's notification is the engine's words, not the person's.
    const forced =
      settings.allowOverride && !notification
        ? parseOverride(e.text, offered)
        : null;
    // A tier `/jev tiers off` dropped since it started running is nothing
    // safe to continue without asking Jev either: skipping straight to
    // continuationOf's own check (which would fall back to unrouted anyway)
    // means Jev is never asked about this notification at all, when a fresh
    // classify would have routed it properly.
    const softNotify =
      settings.notifyContinue &&
      notification &&
      continueFrom !== null &&
      offered.includes(continueFrom.tier);
    const askAbort = new AbortController();
    const asking =
      isContinuation(e.text) || nudge || softNotify || forced !== null
        ? null
        // A task's notification carries the agent's whole result, which can
        // quote files it read: Jev is told only the task's one-line summary.
        : notification
          ? classify($, notificationStateOf(e.text), offered, settings, askAbort.signal, "notification")
          : classify($, e.text, offered, settings, askAbort.signal);
    const reported = await contextTokensOf($);
    // With no context yet (a fresh session) nothing tells two sessions
    // apart, so their claims are kept apart by the session's own key.
    const scope = reported ?? snapshotKey ?? null;
    // The session id: always folded into the claim (see turnKey) so a
    // genuinely different warm session that happens to carry the same
    // context does not collide with this one.
    const sessionId =
      snapshotKey !== null && snapshotKey.startsWith(SNAPSHOT_PREFIX)
        ? snapshotKey.slice(SNAPSHOT_PREFIX.length)
        : null;
    if (!(await claimTurn($, e.text, scope, birth, sessionId))) {
      askAbort.abort();
      ceded.add(e.turnId);
      trimSet(ceded);
      return next(e);
    }
    claimed.set(e.turnId, turnKey(e.text, scope, sessionId));
    if (claimed.size > 200) claimed.delete(claimed.keys().next().value as string);

    // A turn the person typed starts a reply; one the engine started — a
    // finished task's notification, its own nudge (which carries no text
    // at all) — continues the last one, and its summary folds into that
    // reply's.
    // A prompt typed while the last reply's agents still run starts a new
    // reply anyway: the old one's summary is given up (its turns stay in
    // /jev), rather than an agent that never finishes holding every later
    // summary.
    if (!notification && !nudge) {
      reply = [];
      replyAgents = new Set();
    }

    // A bare go-ahead continues the previous turn's work on the previous
    // turn's decision, without a round trip: Jev is confidently wrong about
    // these (it grades the text, which is trivial, not the task, which is
    // whatever was just proposed). The engine's nudge is the same: the task
    // is mid-flight, and grading the nudge's text would move the model
    // under it. When there is nothing to continue (first turn, or the
    // previous turn left the session model), still do not ask Jev — that
    // would clear sticky with a ~1.00 haiku pick.
    // A task that finished before its reply's last response was summarised
    // (its agent read as completed at that stop) wakes the loop after the
    // summary. That turn is the tail of a reply already closed: it is
    // counted and listed, and writes no second block.
    const task = notificationTaskOf(e.text);
    // Whether or not the notification continues without asking Jev: a
    // reply is closed once its summary is written, whatever this turn does.
    const afterSummary =
      notification && task !== null && summarisedAgents.has(task);

    if (surface === null) surface = await surfaceOf($);
    let attempt: Attempt;
    if (isContinuation(e.text) || nudge || softNotify) {
      attempt =
        continueFrom !== null
          ? continuationOf(
              e.text,
              continueFrom,
              ceiling,
              reported ?? lastUsage?.context ?? null,
              offered,
            )
          : continuationSkipped(e.text);
      if (nudge) attempt.kind = "nudge";
      // A task notification that continues is still the task waking the
      // loop: the row and the summary say so, with the task's summary in
      // place of the XML.
      if (softNotify) {
        attempt.kind = "notify";
        attempt.prompt = kept(notificationOf(e.text) ?? attempt.prompt);
      }
    } else {
      // What a downgrade is priced against: the engine's count of what the
      // last response carried, or ours from its usage; the last output, or
      // a typical one, whichever is smaller — a downgrade is weighed exactly
      // when the coming prompt looks trivial, so a long last output would
      // overstate it, and overstating output is the side that pays for a
      // switch it should not have made. Nothing known means nothing to
      // protect, so no hold.
      const context = reported ?? lastUsage?.context ?? 0;
      // A session already running on something the router did not route —
      // resumed without the resume event, `/jev on` after a stretch off, a
      // plugin loaded into a live session — has a warm cache on its model,
      // and that is what the first routed switch is priced against.
      if (running === null && context > 0) {
        if (sessionModel === null) sessionModel = await sessionModelOf($);
        if (sessionModel !== null) running = sessionDecision(sessionModel);
      }
      const economics =
        context > 0
          ? {
              contextTokens: context,
              outputTokens: Math.min(
                lastUsage?.output ?? TYPICAL_OUTPUT_TOKENS,
                TYPICAL_OUTPUT_TOKENS,
              ),
              ttl: settings.ttl,
              ...(cacheExpired ? { cold: true } : {}),
            }
          : undefined;
      attempt = attemptOf(
        e.text,
        asking === null
          ? { ok: false, reason: "you named the tier, so Jev was not asked", ms: 0 }
          : await asking,
        offered,
        {
          sticky: settings.sticky,
          running,
          forced,
          ceiling,
          upgradeMax: settings.upgradeMax,
          price: settings.priceCheck,
          ...(economics !== undefined ? { economics } : {}),
        },
      );
      // The conversation's first request runs some efforts as others
      // (FIRST_TURN_EFFORT). The engine has no count of a response yet
      // exactly when there has been none: a fresh session, or one just
      // compacted. A resumed session reports its context, and the engine
      // honours the ask there. An engine without the count is read the
      // same way from our own record. The route line and the request say
      // what will run; `running`, below, keeps what Jev asked.
      if (
        !answered &&
        reported === null &&
        lastUsage === null &&
        "decision" in attempt
      ) {
        attempt.decision = firstTurnEffort(attempt.decision);
      }
    }

    // A reply is still open after its turn only while its summary waits on
    // agents it spawned; one that ended without a summary (interrupted,
    // failed, quiet) is not waiting for anything.
    const replyOpen = reply.length > 0 && replyAgents.size > 0;
    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened.
    if (afterSummary) {
      attempts.unshift(attempt);
      attempts.length = Math.min(attempts.length, HISTORY_LIMIT);
    } else {
      record(attempt);
    }
    byTurn.set(e.turnId, attempt);
    trimByTurn();

    // The line goes into the reply's own text, in turn.step below. Render
    // hooks and $.ui.log both drew nothing in the desktop app; the model's
    // text is the one channel that reaches every surface. The engine's nudge
    // gets no line and no summary: it is the engine prodding a task that is
    // mid-flight, not a reply to the person, and a block under it was the
    // middle of the three that stacked under one reply (seen 2026-09-23).
    // A task's notification that wakes a reply still open, or one already
    // summarised, gets none either, routed or not: that reply has its line
    // (and its summary names every tier it ran on). One that wakes an idle
    // session opens a reply of its own, and says so.
    if (announce && !nudge && !softNotify && !(notification && (replyOpen || afterSummary))) {
      pending.add(e.turnId);
      trimSet(pending);
    }

    if ("decision" in attempt) {
      decisions.set(e.turnId, attempt.decision);
      trim(decisions);
      latest = attempt.decision;
      // What the next turn holds to is the tier actually running, which on a
      // held turn is the previous one, not the one Jev named — at the effort
      // Jev asked for, not the one a first turn ran instead.
      const was = running;
      running = asAsked(attempt.decision);
      continueFrom = running;
      if (unconfirmed === null && (was === null || baseModel(was.model) !== baseModel(running.model)))
        unconfirmed = { was };
    } else {
      // Unrouted: the session model answered. A following go-ahead must not
      // re-apply the last routed tier as if that were the previous turn.
      continueFrom = null;
    }

    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());

    return next(e);
  });

  // turn.step streams, so it is an async generator. The model rewrite goes
  // down in `e`; the line comes back up in the first text chunk of the turn,
  // and the `stop` chunk's usage, which names the model the API says answered,
  // is kept on the turn. That is the check on the rewrite: the route line is
  // what was asked for, the summary and /jev show what was got.
  //
  // Text chunks concatenate per block, so prefixing the first one puts the
  // line at the top of the reply. This is the recorded text too, so the model
  // sees its past replies open with the line; that is the price of a marker
  // that reaches a surface which draws neither render sites nor ui.log.
  on("turn.step", async function* ($, e, next) {
    settings = await seedSettings($, settings);

    // A turn a newer copy claimed is that copy's to route and announce.
    const holdsTurnOf = async (turnId: string) => {
      const key = claimed.get(turnId);
      if (key === undefined) return true;
      if (await holdsTurn($, key, birth)) return true;
      ceded.add(turnId);
      return false;
    };
    if (ceded.has(e.turnId)) {
      for await (const chunk of next(e)) yield chunk;
      return;
    }
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    if (
      inert ||
      superseded() ||
      (snapshotKey && !(await ownsSession($, snapshotKey, birth, true)))
    ) {
      inert = true;
      for await (const chunk of next(e)) yield chunk;
      return;
    }

    // Routing off is authoritative for every step, including subagents whose
    // spawn decision was cached before /jev off. What the session spends is
    // still counted, or `spent` would say less than the truth.
    if (!enabled) {
      for await (const chunk of next(e)) {
        if (chunk.kind === "stop" && chunk.usage) {
          const u = normalUsage(chunk.usage);
          spent += usageCost(u.model, u, settings.ttl) ?? 0;
          // What answers while routing is off is what is warm when it
          // comes back on: /jev on then prices against that, not a guess
          // from the session model.
          if (e.agentId === undefined) {
            cacheExpired = false;
            answered = true;
            unconfirmed = null;
            const warm = warmDecision(u.model, e.effort);
            if (warm !== null) {
              running = warm;
              lastUsage = { context: carriedOf(u), output: u.output_tokens };
            }
          }
          // Saved as a routed step's usage is, or a reload loses it.
          const now = Date.now();
          if (!MID_TURN.has(chunk.stopReason ?? "") || now - lastMidTurnSave >= MID_TURN_SAVE_MS) {
            lastMidTurnSave = now;
            if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
          }
        }
        yield chunk;
      }
      return;
    }

    // A subagent's loop gets no turn.start (probed live: its steps arrive
    // with agentId set and nothing in byTurn), so its turn is first seen
    // here. Its decision was made at agent.spawn, keyed by the id the spawn
    // handed back, and the steps apply it: the spawn set the model, but
    // effort is per request, and this is where requests are made. A line in
    // its reply would land in the tool result its parent reads, so it gets
    // none; it is recorded, though, or /jev would show one prompt and hide
    // the four requests it caused.
    let attempt = byTurn.get(e.turnId);
    if (attempt !== undefined) {
      touch(byTurn, e.turnId, attempt);
    } else if (e.agentId !== undefined) {
      // A spawn the router saw was recorded then; this only links the turn
      // to it, so a resumed agent's later turns add their usage to the same
      // row rather than opening one each. Recording it again here listed
      // every routed subagent twice.
      attempt = spawned.get(e.agentId) ?? unrouted.get(e.agentId);
      if (attempt !== undefined) {
        // Touch keeps the row warm, so a busy agent is the last evicted when
        // a spawn trims the map: dropping an in-flight agent would revert its
        // later steps to the session model.
        touch(spawned, e.agentId, attempt);
      } else {
        // A fork, or a spawn from before the router loaded: nothing was
        // decided for it, and it runs on whatever the engine resolved.
        const agent = await agentTagOf($, e.agentId);
        attempt = {
          prompt: agent.label,
          ms: 0,
          skipped: "not routed at spawn",
          kind: "agent",
          agent,
        };
        record(attempt);
        // One row per agent, as a routed spawn has: its later turns join it.
        // Kept apart from `spawned` and capped on its own, so forks neither
        // grow the snapshot nor crowd out routed agents.
        unrouted.set(e.agentId, attempt);
        trim(unrouted);
      }
      byTurn.set(e.turnId, attempt);
      trimByTurn();
    }
    let decision = decisions.get(e.turnId);
    if (decision !== undefined) {
      touch(decisions, e.turnId, decision);
    } else if (attempt && "decision" in attempt) {
      decision = attempt.decision;
    }
    // A subagent's conversation starts at its first step, which runs some
    // efforts as others (FIRST_TURN_EFFORT); every step after is deep in
    // that conversation and gets what Jev asked.
    if (decision !== undefined && e.agentId !== undefined) {
      decision = stepped.has(e.agentId)
        ? asAsked(decision)
        : firstTurnEffort(decision);
      stepped.add(e.agentId);
      if (stepped.size > CACHE_LIMIT * 4) {
        for (const id of stepped) if (!spawned.has(id)) stepped.delete(id);
      }
    }
    // The main loop's first-request effort is for that one request: once a
    // response has come back, later steps of the same turn are deep in the
    // conversation and get what Jev asked.
    if (decision !== undefined && e.agentId === undefined && answered) decision = asAsked(decision);
    const step = decision
      ? next({ ...e, model: decision.model, effort: decision.effort })
      : next(e);

    // The block the summary joins, so it lands at the end of the reply's
    // text rather than opening a block of its own.
    // The highest block index streamed so far, any kind: the summary must
    // open a block past it, or the engine drops it silently.
    let lastIndex = 0;
    // Whether an inner copy's summary has already passed through this step:
    // copies are chained, so an outer copy sees what an inner one wrote, and
    // writes nothing a second time, whatever put two copies in the chain.
    let summarised = false;

    // What the model streams carries a ref; a route line or summary in it is
    // one the model copied from its past replies, not one a copy wrote. The
    // filter takes those out as the text streams. Only the copy holding the
    // turn filters: an older copy chained around it would take the holder's
    // real line for a copy. Decided at the first text piece.
    type StepChunk = typeof step extends AsyncIterable<infer C> ? C : never;
    type TextChunk = Extract<StepChunk, { kind: "text" }>;
    let filter: ImitationFilter<TextChunk> | null | undefined;
    // Whether this copy still holds the turn and the session, read from the
    // store once per step: the filter, the line and the summary all ask, and
    // a step is short enough that one answer serves all three.
    let holds: boolean | undefined;
    // The session's ownership was checked as this step began, above.
    const holdsNow = async () =>
      (holds ??= !superseded() && (await holdsTurnOf(e.turnId)));

    for await (const raw of step) {
      // The model answering at all means the request was read, and its
      // cache written on the new model, whether or not usage ever arrives.
      if (
        unconfirmed !== null &&
        e.agentId === undefined &&
        (raw.kind === "text" || raw.kind === "thinking" || raw.kind === "tool" || raw.kind === "input")
      ) {
        unconfirmed = null;
        // Saved now: a turn cut short after this writes nothing else, and a
        // reload would otherwise take back a switch that did happen.
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
      }
      const at = (raw as { index?: unknown }).index;
      if (typeof at === "number" && at > lastIndex) lastIndex = at;
      let pieces: StepChunk[] = [raw];
      if (raw.kind === "text" && raw.ref !== undefined && attempt && !inert) {
        if (filter === undefined)
          filter = (await holdsNow()) ? new ImitationFilter<TextChunk>() : null;
        if (filter) pieces = filter.push(raw);
      } else if (filter) {
        pieces = [...filter.end(), raw];
      }

      for (const chunk of pieces) {
      if (chunk.kind === "text") {
        if (chunk.ref === undefined && SUMMARY.test(chunk.text)) summarised = true;
        if (attempt && pending.has(e.turnId)) {
          // The line is this turn's either way; a copy that lost the session
          // since the turn began leaves it to the owner, once, and a line an
          // inner copy already wrote is not written again.
          pending.delete(e.turnId);
          // `/jev quiet` since the turn began: no line after all.
          if (!announce) {
            yield chunk;
            continue;
          }
          // The line's whole shape, not its opening: a reply that opens
          // with its own "> ⚠️ " warning is not a line a copy wrote.
          if (isRouteLine(chunk.text) || !(await holdsNow())) {
            inert = true;
            yield chunk;
            continue;
          }
          yield {
            ...chunk,
            text: `${liveLine(attempt)}${REPLY_SEPARATOR}${chunk.text}`,
          };
          // Saved now, so a reload later in the turn does not write it twice.
          if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
          continue;
        }
      }

      if (chunk.kind === "stop") {
        if (chunk.usage) {
          const usage = normalUsage(chunk.usage);
          if (attempt) {
            // addUsage's return, not a before/after diff of attempt.cost:
            // that field is cleared to undefined the moment any one step of
            // the turn is unpriced (a display choice, so a partial total
            // never reads as the whole), and diffing across that clear
            // either double-subtracted a step already billed or dropped an
            // entire turn from the total. See addUsage's own note.
            spent += addUsage(attempt, usage, settings.ttl);
          } else {
            // A step whose turn.start this copy never saw still cost money.
            spent += usageCost(usage.model, usage, settings.ttl) ?? 0;
          }
          // The main loop's last carried size and output price its next
          // switch; a subagent's are its own conversation.
          if (e.agentId === undefined) {
            lastUsage = {
              context: carriedOf(usage),
              output: usage.output_tokens,
            };
            // What answered is what is warm now. An unrouted turn (Jev
            // timed out) runs on the session model and rewrites the cache
            // there; holding to the tier routed before it would send the
            // next turn to a cold cache while calling it a stay.
            // Whatever the resume said had expired, this response wrote,
            // and no later request is the conversation's first.
            cacheExpired = false;
            answered = true;
            unconfirmed = null;
            const warm = warmDecision(usage.model, e.effort);
            const unrouted = attempt === undefined || !("decision" in attempt);
            if (
              warm !== null &&
              (running === null ||
                baseModel(running.model) !== baseModel(warm.model))
            ) {
              running = warm;
            }
            // A compaction in the middle of this turn cleared what a
            // go-ahead continues; the turn's own decision is still it.
            if (!unrouted && continueFrom === null && attempt !== undefined && "decision" in attempt)
              continueFrom = asAsked(attempt.decision);
            if (warm !== null && running !== null && unrouted) {
              // Same model, but the session's own effort ran and is what
              // the cache holds; Jev's earlier effort is no longer warm.
              const { effortConfidence: _, ...rest } = running;
              void _;
              running = { ...rest, effort: warm.effort };
            }
          }
          // A step that ends the turn always saves; one that continues it
          // saves at most every few seconds. A tool-using turn has dozens
          // of steps, and each save rewrites the whole store file.
          const now = Date.now();
          if (!MID_TURN.has(chunk.stopReason ?? "") || now - lastMidTurnSave >= MID_TURN_SAVE_MS) {
            lastMidTurnSave = now;
            if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
          }
        }

        // The summary goes under the reply once it is over: this step ends
        // the turn, and no background task is still running that will wake
        // the loop and add to it. The index must be one past the last text
        // block, and this is load-bearing. A chunk yielded at an index the
        // engine already streamed is dropped on the floor, silently: probed
        // live, a chunk at the last block's index never reached the transcript,
        // one at one past it did. It opens a block of its own,
        // which is what a summary wants anyway — the reply above it stays
        // untouched.
        //
        // No `ref`, because the engine's handle belongs to a chunk the
        // engine streamed; one a hook built has none and is taken at its
        // word. It goes before the stop chunk, the last thing the engine
        // expects to see. Not in a subagent's reply: that is a tool result
        // its parent reads.
        if (
          attempt &&
          announce &&
          e.agentId === undefined &&
          attempt.kind !== "agent" &&
          // A nudge alone is not a reply to the person; one that finishes a
          // reply the person started still closes it.
          (attempt.kind !== "nudge" ||
            reply.some((a) => a.kind !== "nudge" && a.kind !== "agent")) &&
          // null: the request failed, and there is no response to sum up.
          chunk.stopReason != null &&
          !MID_TURN.has(chunk.stopReason) &&
          !summarised &&
          !(await agentsRunning($, replyAgents)) &&
          // Still the copy holding the turn: one loaded mid-turn may have
          // claimed since.
          (await holdsNow())
        ) {
          const summary = replySummary(reply);
          if (summary !== null) {
            yield {
              kind: "text" as const,
              index: lastIndex + 1,
              text: `${FOOTER_SEPARATOR}${summary}`,
            };
            // Written once; what comes after is a new reply's worth. The
            // reply's agents are noted, so a wake-up that arrives after
            // this joins no other reply's block.
            for (const id of replyAgents) summarisedAgents.add(id);
            trimSet(summarisedAgents);
            reply = [];
            replyAgents = new Set();
            if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
          }
        }
      }

      yield chunk;
      }
    }
    // A stream that ended without a stop chunk still gets what was held.
    if (filter) for (const chunk of filter.end()) yield chunk;
  });

  // A subagent is routed at its spawn, the one moment its task is in hand as
  // text. Only the model is set here: the Agent tool has no effort, but the
  // subagent's own turn.step does, and it reads the decision kept under the
  // id `next(e)` hands back. Two spawns are left alone: a fork, whose model
  // the engine ignores (it inherits context and model both), and a call that
  // named a model itself, which is the caller's decision to make.
  //
  // The parent's tier is not a hold: a subagent starts with an empty
  // conversation, so there is no cache to keep warm, and the one measured
  // cost of a different model is its ~17k-token system prefix, which a
  // haiku loop pays back in its first tool call.
  on("agent.spawn", async ($, e, next) => {
    // A spawn the router leaves alone still belongs to the reply that made
    // it, and the reply's summary waits for it like any other.
    if (!enabled || e.fork || e.model !== undefined) {
      const started = await next(e);
      if (started.agentId !== undefined) replyAgents.add(started.agentId);
      return started;
    }
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(restoredFrom(snapshotKey, await loadSnapshot($, snapshotKey), await ownerOf($, snapshotKey)));
      restoreOnKey = true;
    }
    if (
      inert ||
      superseded() ||
      (snapshotKey && !(await ownsSession($, snapshotKey, birth, true)))
    ) {
      inert = true;
      return next(e);
    }

    const attempt = spawnAttemptOf(
      e.description,
      await classify($, e.prompt, settings.offered, settings, undefined, "task"),
      settings.offered,
      { type: e.subagentType, label: e.description },
      settings.ceiling,
    );

    const started = await next(
      "decision" in attempt ? { ...e, model: attempt.decision.model } : e,
    );
    // Recorded once it started: a spawn another hook denied ran nowhere,
    // and is not an agent of the reply.
    if (started.agentId !== undefined) record(attempt);
    if (started.agentId !== undefined) {
      // Prefer dropping finished agents over FIFO: blind eviction silently
      // dropped effort routing for resumed agents. Always keep the id we
      // just set — list() may not include it yet.
      const justStarted = started.agentId;
      replyAgents.add(justStarted);
      spawned.set(justStarted, attempt);
      if (spawned.size > CACHE_LIMIT) {
        // The list holds every agent so far, finished ones too. What goes
        // first is what cannot come back (gone from the list, failed,
        // killed); then, oldest first, completed ones, which a message could
        // still resume. Running agents, and any status not known here, stay.
        const status = new Map(
          (await $.agent.list().catch(() => [])).map((a) => [a.id, a.status] as const),
        );
        const evict = (drop: (s: string | undefined) => boolean) => {
          for (const id of [...spawned.keys()]) {
            if (spawned.size <= CACHE_LIMIT) break;
            if (id !== justStarted && drop(status.get(id))) spawned.delete(id);
          }
        };
        evict((s) => s === "failed" || s === "killed");
        evict((s) => s === "completed");
        // Not in the list yet (spawned a moment ago, in parallel) or the list
        // unreadable: last, and oldest first, so a fresh one outlives the rest.
        evict((s) => s === undefined);
      }
    }
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateToSave(), firstSave());
    return started;
  });

  // The footer, where a surface draws one. The announcement above is what
  // carries on surfaces that draw no footer, which is most of them.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    if (inert) return next(e);
    const last = attempts.find((a) => a.kind !== "agent");
    const modes = withLabel(e.props.modes, labelOf(latest, enabled, last?.kind, last?.continued));
    return next({ ...e, props: { ...e.props, modes } });
  });
}
