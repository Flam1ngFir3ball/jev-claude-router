import type { On } from "claude-code";

import {
  askJev,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
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
  upgradeMaxOf,
  offeredTiers,
  overrideAllowedOf,
  parseOverride,
  sessionDecision,
  stickyOf,
  thresholdOf,
  EFFORTS,
  type Ceiling,
  type Decision,
  type Effort,
  type Tier,
} from "./policy.ts";
import { baseModel, ttlOf, usageCost, type Ttl } from "./pricing.ts";
import {
  pack,
  SNAPSHOT_PREFIX,
  staleKeys,
  unpack,
  type State,
} from "./persist.ts";
import { providerOf, type ProviderResult } from "./provider.ts";
import {
  compactOnOf,
  compactTimeoutOf,
  minReductionOf,
  pruneTranscript,
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
  notificationTaskOf,
  replySummary,
  spawnAttemptOf,
  statusReport,
  stickyCommand,
  toggleReply,
  TYPICAL_OUTPUT_TOKENS,
  unknownCommandReply,
  ImitationFilter,
  type AgentTag,
  type Attempt,
} from "./status.ts";

/** The slice of the engine a Jev call needs; every hook's `$` has it. */
type Engine = {
  env: { get: (key: string) => Promise<string | undefined> };
  http: {
    fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  };
  clock: { sleep: (ms: number) => Promise<unknown> };
};

/** Turns kept in the decision cache before the oldest are dropped. */
const CACHE_LIMIT = 32;

/** A reply's route line, as `liveLine` writes it: what an inner copy already put in. */
const ROUTE_LINE = /^> (?:✳️|⚠️) /;

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
 * The claim key for a turn: its text and the context it carries. Copies of
 * one conversation read the same engine, so they agree on both; two
 * conversations that get the same short prompt ("yes", the engine's nudge)
 * within a minute almost never carry the same context, so neither cedes
 * to the other.
 */
function turnKey(text: string, contextTokens: number | null): string {
  return `${textHash(text)}-${contextTokens ?? 0}`;
}

/** Store key prefix for which copy of the module owns a session. */
const OWNER_PREFIX = "owner:";

/** How often a turn still running saves its state. */
const MID_TURN_SAVE_MS = 5_000;

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
 * changes within a session, and reading fourteen variables on every turn was
 * fourteen awaits ahead of the Jev call. `sticky` and `ceiling` start here
 * and are then owned by `/jev sticky` and `/jev ceiling`.
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
  const excluded = excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE"));
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
    offered: offeredTiers(excluded),
    excluded: [...excluded],
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
    compactOn: compactOnOf(await $.env.get("JEV_ROUTER_COMPACT")),
    compactTimeoutMs: compactTimeoutOf(
      await $.env.get("JEV_ROUTER_COMPACT_TIMEOUT_MS"),
    ),
    compactMinReduction: minReductionOf(
      await $.env.get("JEV_ROUTER_COMPACT_MIN_REDUCTION"),
    ),
  };
}

/** Asks Jev about one piece of text. Top-level, for the same reason as above. */
async function classify(
  $: Engine,
  text: string,
  offered: readonly Tier[],
  settings: Settings,
) {
  return askJev({
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms) => $.clock.sleep(ms),
    provider: settings.provider,
    state: text,
    offered,
    timeoutMs: settings.timeoutMs,
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
      for (const stale of staleKeys(await $.store.keys(), key)) {
        await $.store.delete(stale);
        await $.store.delete(`${OWNER_PREFIX}${stale}`);
      }
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
    const at = `${OWNER_PREFIX}${key}`;
    const stored = await $.store.get(at);
    const owner = typeof stored === "number" ? stored : 0;
    if (owner > birth) return false;
    if (claim && owner < birth) await $.store.set(at, birth);
    return true;
  } catch {
    return true;
  }
}

/**
 * Claims a turn for this copy, by the turn's text. One conversation has been
 * seen handled by copies that each read a different session id (the app
 * resumed it under a new id and a copy kept the old one, 2026-09-23), so the
 * session-keyed claim could not pair them and every copy wrote a line. What
 * they share is the store and the turn's text. The newest copy wins: an
 * older one that claimed first is overridden, and checks again before it
 * writes. False means a newer copy holds the turn. A store that cannot be
 * read lets the copy through, as before.
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
  contextTokens: number | null,
  birth: number,
): Promise<boolean> {
  try {
    const at = `${TURN_PREFIX}${turnKey(text, contextTokens)}`;
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
    if ((await $.store.get(at)) === birth) await $.store.delete(at);
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
  const runtime = globalThis as { __jevRouterNewest?: number };
  const birth = Math.max(
    Date.now() + Math.random() * 0.001,
    (runtime.__jevRouterNewest ?? 0) + 0.001,
  );
  runtime.__jevRouterNewest = birth;
  const superseded = () => birth < (runtime.__jevRouterNewest ?? 0);
  /** True once a newer copy has claimed the session: this one stands aside. */
  let inert = false;
  /** The engine said the resumed session's cache has expired, and no response has written it since. */
  let cacheExpired = false;
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
  let prunedCache: { key: string; messages: readonly unknown[] } | null = null;
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
   * Forget what the main loop was running on. After `/jev off` the session
   * model answers, and after a compaction or `/clear` the cache the hold was
   * protecting is gone either way, so the next routed turn starts from Jev's
   * word.
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

  const stateNow = (): State => ({
    attempts,
    reply,
    replyAgents: [...replyAgents],
    spawned: [...spawned.entries()],
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
    ceiling: settings?.ceiling ?? ceilingAt("medium"),
    compactOn: settings?.compactOn ?? true,
    compaction: lastCompaction,
  });

  /** Puts a restored snapshot back, over what the environment seeded. */
  const applyState = (s: State | null) => {
    if (s === null) return;
    attempts.splice(0, attempts.length, ...s.attempts);
    reply = s.reply;
    replyAgents = new Set(s.replyAgents);
    spawned.clear();
    for (const [id, a] of s.spawned) spawned.set(id, a);
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
    if (settings !== null) {
      settings.sticky = s.sticky;
      settings.ceiling = s.ceiling;
      settings.compactOn = s.compactOn;
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
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description: "Jev routing: status, on/off, sticky, ceiling, quiet/loud.",
    });
    surface = await surfaceOf($);
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(await loadSnapshot($, snapshotKey));
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
    }
    // The cache has expired: what is running is still known, and the next
    // switch is priced with staying as a write too, snapshot or not.
    if (
      (e.source === "resume" || e.source === "fork") &&
      e.prompt_cache_likely_expired === true
    )
      cacheExpired = true;
    if (
      (e.source === "resume" || e.source === "fork") &&
      running === null &&
      typeof e.context_tokens === "number" &&
      e.context_tokens > 0 &&
      typeof e.model === "string"
    ) {
      running = sessionDecision(e.model);
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
        applyState(await loadSnapshot($, snapshotKey));
      restoreOnKey = true;
    }
    // Jev prunes the transcript instead of the engine summarising it:
    // every tool call is scored, stale ones go or are cut, and what stays
    // is verbatim. One copy does it; anything short of a good result
    // leaves the engine's summary to run.
    let pruned: { messages: readonly typeof e.messages[number][] } | null = null;
    const transcript = Array.isArray(e.messages) ? e.messages : [];
    // The same transcript, scored once: its length and the engine's handles.
    const cacheKey = `${transcript.length}:${textHash(transcript.map((m) => m.handle ?? "").join(","))}`;
    if (
      enabled &&
      settings.compactOn &&
      transcript.length > 0 &&
      prunedCache !== null &&
      prunedCache.key === cacheKey
    ) {
      pruned = { messages: prunedCache.messages as unknown as typeof e.messages };
    } else if (
      enabled &&
      settings.compactOn &&
      transcript.length > 0 &&
      !inert &&
      !superseded() &&
      !(snapshotKey && !(await ownsSession($, snapshotKey, birth, false)))
    ) {
      const result = await pruneTranscript({
        messages: transcript,
        provider: settings.provider,
        fetch: (url, init) => $.http.fetch(url, init),
        sleep: (ms) => $.clock.sleep(ms),
        timeoutMs: settings.compactTimeoutMs,
        minReduction: settings.compactMinReduction,
      });
      lastCompaction = result.compaction;
      // The library's message shape is the engine's, less the engine's own
      // `true | undefined` spelling of isError (rebuilt blocks carry false).
      if (result.ok) {
        pruned = { messages: result.messages as unknown as typeof e.messages };
        prunedCache = { key: cacheKey, messages: result.messages };
      }
    }
    if (e.trigger !== "precompute" && e.agentId === undefined) {
      running = null;
      continueFrom = null;
      lastUsage = null;
    }
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
    return pruned ?? next(e);
  });

  // `/model` moved the main loop: what was running is not any more, and the
  // next routed turn is priced against the new model, which the turn seeds
  // from the session when the engine reports context.
  on("classic.PostModelSwitch", async ($, e, next) => {
    // A resume restores the model it left on; that is not a move, and the
    // resume hook has just seeded what is running on it.
    if (e.source === "resume") return next(e);
    if (typeof e.to_model === "string") sessionModel = e.to_model;
    running = null;
    continueFrom = null;
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e, next) => {
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(await loadSnapshot($, snapshotKey));
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
    const arg = e.args.trim().toLowerCase();
    const sub = arg.replace(/^-+/, "");

    if (arg === "on" || arg === "off") {
      enabled = arg === "on";
      if (!enabled) clearRouting();
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
      return { text: toggleReply(enabled) };
    }

    if (sub === "compact" || sub.startsWith("compact ")) {
      const want = sub.slice("compact".length).trim();
      if (want === "on" || want === "off") {
        settings.compactOn = want === "on";
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
      } else if (want !== "") {
        return { text: unknownCommandReply(sub, false) };
      }
      return {
        text:
          `jev-router: compaction by Jev ${settings.compactOn ? "on" : "off"}` +
          (settings.compactOn
            ? ": at each compaction, Jev scores every tool call and the stale ones are dropped or cut; the conversation stays verbatim. /jev compact off restores the engine's summary."
            : ": the engine's own summary runs. /jev compact on to prune with Jev instead."),
      };
    }

    if (arg === "quiet" || arg === "loud") {
      announce = arg === "loud";
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
      return { text: announceReply(announce) };
    }

    // `--sticky` as well as `sticky`: the flag spelling is what people reach
    // for, and refusing it would teach nothing.
    if (sub === "sticky" || sub.startsWith("sticky ")) {
      const result = stickyCommand(sub.slice("sticky".length), settings.sticky);
      settings.sticky = result.sticky;
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
      return { text: result.text };
    }

    if (sub === "ceiling" || sub.startsWith("ceiling ")) {
      const result = ceilingCommand(
        sub.slice("ceiling".length),
        settings.ceiling,
      );
      settings.ceiling = result.ceiling;
      if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
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
        settings.ceiling = result.ceiling;
        if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
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
        ceiling: settings.ceiling,
        compactOn: settings.compactOn,
        compaction: lastCompaction,
        ttl: settings.ttl,
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
    if (!enabled) return next(e);
    settings = await seedSettings($, settings);
    if (snapshotKey === undefined) {
      snapshotKey = await snapshotKeyOf($);
      if (snapshotKey !== null && restoreOnKey)
        applyState(await loadSnapshot($, snapshotKey));
      restoreOnKey = true;
    }
    // The newest copy of the module handles the turn; an older one stands aside.
    // The session's id can change under a live copy (a resume into a new
    // id); keep the state and follow the id, so every copy claims one key.
    if (snapshotKey !== undefined) {
      const current = await snapshotKeyOf($);
      if (current !== null && current !== snapshotKey) {
        snapshotKey = current;
        savedOnce = false;
      }
    }
    if (superseded()) inert = true;
    else if (snapshotKey) inert = !(await ownsSession($, snapshotKey, birth, true));
    if (inert) return next(e);
    const { offered, ceiling } = settings;
    // Jev is the long pole of the turn, so it is asked before anything
    // else is read. A copy that then cedes the turn drops the answer: one
    // wasted call, only when a stale copy is loaded, is cheaper than a
    // round trip ahead of Jev on every turn.
    const notification = notificationOf(e.text) !== null;
    const nudge = isEngineNudge(e.text) || e.text.trim() === "";
    const forced = settings.allowOverride
      ? parseOverride(e.text, offered)
      : null;
    const softNotify =
      settings.notifyContinue && notification && continueFrom !== null;
    const asking =
      isContinuation(e.text) || nudge || softNotify || forced !== null
        ? null
        : classify($, e.text, offered, settings);
    const reported = await contextTokensOf($);
    if (!(await claimTurn($, e.text, reported, birth))) {
      ceded.add(e.turnId);
      trimSet(ceded);
      return next(e);
    }
    claimed.set(e.turnId, turnKey(e.text, reported));
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
    const afterSummary =
      softNotify && task !== null && summarisedAgents.has(task);

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
    // A continuing notification gets none either: the reply it woke is
    // already open under its own line.
    if (announce && !nudge && !softNotify) {
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
      running = asAsked(attempt.decision);
      continueFrom = running;
    } else {
      // Unrouted: the session model answered. A following go-ahead must not
      // re-apply the last routed tier as if that were the previous turn.
      continueFrom = null;
    }

    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());

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
        applyState(await loadSnapshot($, snapshotKey));
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
            const warm = warmDecision(u.model, e.effort);
            if (warm !== null) {
              running = warm;
              lastUsage = { context: carriedOf(u), output: u.output_tokens };
            }
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
      attempt = spawned.get(e.agentId);
      if (attempt !== undefined) {
        // Touch keeps the row warm; spawned itself is never trimmed — dropping
        // an in-flight agent silently reverts its later steps to the session
        // model and invents a "not routed at spawn" history row.
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
          if (ROUTE_LINE.test(chunk.text) || !(await holdsNow())) {
            inert = true;
            yield chunk;
            continue;
          }
          yield {
            ...chunk,
            text: `${liveLine(attempt)}${REPLY_SEPARATOR}${chunk.text}`,
          };
          // Saved now, so a reload later in the turn does not write it twice.
          if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
          continue;
        }
      }

      if (chunk.kind === "stop") {
        if (chunk.usage) {
          const usage = normalUsage(chunk.usage);
          if (attempt) {
            const before = attempt.cost ?? 0;
            addUsage(attempt, usage, settings.ttl);
            spent += (attempt.cost ?? 0) - before;
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
            const warm = warmDecision(usage.model, e.effort);
            const unrouted = attempt === undefined || !("decision" in attempt);
            if (
              warm !== null &&
              (running === null ||
                baseModel(running.model) !== baseModel(warm.model))
            ) {
              running = warm;
            } else if (warm !== null && running !== null && unrouted) {
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
            if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
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
            if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
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
        applyState(await loadSnapshot($, snapshotKey));
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
      await classify($, e.prompt, settings.offered, settings),
      settings.offered,
      { type: e.subagentType, label: e.description },
      settings.ceiling,
    );
    record(attempt);

    const started = await next(
      "decision" in attempt ? { ...e, model: attempt.decision.model } : e,
    );
    if (started.agentId !== undefined) {
      // Prefer dropping finished agents over FIFO: blind eviction silently
      // dropped effort routing for resumed agents. Always keep the id we
      // just set — list() may not include it yet.
      const justStarted = started.agentId;
      replyAgents.add(justStarted);
      spawned.set(justStarted, attempt);
      if (spawned.size > CACHE_LIMIT) {
        const live = new Set(
          (await $.agent.list().catch(() => [])).map((a) => a.id),
        );
        live.add(justStarted);
        for (const id of [...spawned.keys()]) {
          if (spawned.size <= CACHE_LIMIT) break;
          if (!live.has(id)) spawned.delete(id);
        }
      }
    }
    if (snapshotKey && settings && !inert) await saveSnapshot($, snapshotKey, stateNow(), firstSave());
    return started;
  });

  // The footer, where a surface draws one. The announcement above is what
  // carries on surfaces that draw no footer, which is most of them.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    if (inert) return next(e);
    const modes = withLabel(e.props.modes, labelOf(latest, enabled));
    return next({ ...e, props: { ...e.props, modes } });
  });
}
