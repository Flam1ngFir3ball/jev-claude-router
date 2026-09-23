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
  ceilingOf,
  excludedTiers,
  firstTurnEffort,
  isContinuation,
  isEngineNudge,
  notifyContinueOf,
  offeredTiers,
  overrideAllowedOf,
  parseOverride,
  sessionDecision,
  stickyOf,
  thresholdOf,
  type Ceiling,
  type Decision,
  type Tier,
} from "./policy.ts";
import { ttlOf, usageCost, type Ttl } from "./pricing.ts";
import { providerOf, type ProviderResult } from "./provider.ts";
import {
  addUsage,
  announceReply,
  attemptOf,
  carriedOf,
  ceilingCommand,
  continuationOf,
  continuationSkipped,
  HISTORY_LIMIT,
  liveLine,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  notificationOf,
  replySummary,
  spawnAttemptOf,
  statusReport,
  stickyCommand,
  toggleReply,
  TYPICAL_OUTPUT_TOKENS,
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
 * changes within a session, and reading eleven variables on every turn was
 * eleven awaits ahead of the Jev call. `sticky` and `ceiling` start here
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
    surface = await $.session.surface();
    settings = await seedSettings($, settings);
    sessionModel = await sessionModelOf($);
    return next(e);
  });

  // A resumed session is already running on something, with a cache the
  // first routed turn's switch should be priced against — unless the engine
  // says that cache has expired, in which case there is nothing to protect.
  // `/clear` starts a new conversation: nothing is running.
  on("classic.SessionStart", async ($, e, next) => {
    if (e.source === "clear") clearRouting();
    if (
      (e.source === "resume" || e.source === "fork") &&
      running === null &&
      !e.prompt_cache_likely_expired &&
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
  // context is small again, so switches are cheap: start over from Jev.
  on("session.compact", async ($, e, next) => {
    if (e.trigger !== "precompute") clearRouting();
    return next(e);
  });

  // `/model` moved the main loop: what was running is not any more, and the
  // next routed turn is priced against the new model, which the turn seeds
  // from the session when the engine reports context.
  on("classic.PostModelSwitch", async ($, e, next) => {
    if (typeof e.to_model === "string") sessionModel = e.to_model;
    running = null;
    continueFrom = null;
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e) => {
    settings = await seedSettings($, settings);
    const arg = e.args.trim().toLowerCase();

    if (arg === "on" || arg === "off") {
      enabled = arg === "on";
      if (!enabled) clearRouting();
      return { text: toggleReply(enabled) };
    }

    if (arg === "quiet" || arg === "loud") {
      announce = arg === "loud";
      return { text: announceReply(announce) };
    }

    // `--sticky` as well as `sticky`: the flag spelling is what people reach
    // for, and refusing it would teach nothing.
    const sub = arg.replace(/^-+/, "");
    if (sub === "sticky" || sub.startsWith("sticky ")) {
      const result = stickyCommand(sub.slice("sticky".length), settings.sticky);
      settings.sticky = result.sticky;
      return { text: result.text };
    }

    if (sub === "ceiling" || sub.startsWith("ceiling ")) {
      const result = ceilingCommand(
        sub.slice("ceiling".length),
        settings.ceiling,
      );
      settings.ceiling = result.ceiling;
      return { text: result.text };
    }

    if (surface === null) surface = await $.session.surface();
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
        ceiling: settings.ceiling,
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
    if (surface === null) surface = await $.session.surface();
    const { offered, ceiling } = settings;

    // A turn the person typed starts a reply; one the engine started — a
    // finished task's notification, its own nudge — continues the last one,
    // and its summary folds into that reply's.
    const notification = notificationOf(e.text) !== null;
    const nudge = isEngineNudge(e.text);
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
    const forced = settings.allowOverride
      ? parseOverride(e.text, offered)
      : null;
    const softNotify =
      settings.notifyContinue && notification && continueFrom !== null;

    let attempt: Attempt;
    if (isContinuation(e.text) || nudge || softNotify) {
      attempt =
        continueFrom !== null
          ? continuationOf(e.text, continueFrom, ceiling)
          : continuationSkipped(e.text);
      if (nudge) attempt.kind = "nudge";
    } else {
      // What a downgrade is priced against: the engine's count of what the
      // last response carried, or ours from its usage; the last output, or
      // a typical one, whichever is smaller — a downgrade is weighed exactly
      // when the coming prompt looks trivial, so a long last output would
      // overstate it, and overstating output is the side that pays for a
      // switch it should not have made. Nothing known means nothing to
      // protect, so no hold.
      const reported = await contextTokensOf($);
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
            }
          : undefined;
      attempt = attemptOf(
        e.text,
        forced !== null
          ? { ok: false, reason: "you named the tier, so Jev was not asked", ms: 0 }
          : await classify($, e.text, offered, settings),
        offered,
        {
          sticky: settings.sticky,
          running,
          forced,
          ceiling,
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
      if (reported === null && lastUsage === null && "decision" in attempt) {
        attempt.decision = firstTurnEffort(attempt.decision);
      }
    }

    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened.
    record(attempt);
    byTurn.set(e.turnId, attempt);
    trimByTurn();

    // The line goes into the reply's own text, in turn.step below. Render
    // hooks and $.ui.log both drew nothing in the desktop app; the model's
    // text is the one channel that reaches every surface. The engine's nudge
    // gets no line and no summary: it is the engine prodding a task that is
    // mid-flight, not a reply to the person, and a block under it was the
    // middle of the three that stacked under one reply (seen 2026-09-23).
    if (announce && !nudge) {
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

    // Routing off is authoritative for every step, including subagents whose
    // spawn decision was cached before /jev off. What the session spends is
    // still counted, or `spent` would say less than the truth.
    if (!enabled) {
      for await (const chunk of next(e)) {
        if (chunk.kind === "stop" && chunk.usage) {
          spent += usageCost(chunk.usage.model, chunk.usage, settings.ttl) ?? 0;
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
          skipped: "not routed at spawn, so it keeps its own model",
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
    }
    const step = decision
      ? next({ ...e, model: decision.model, effort: decision.effort })
      : next(e);

    // The block the summary joins, so it lands at the end of the reply's
    // text rather than opening a block of its own.
    let lastTextIndex = 0;

    for await (const chunk of step) {
      if (chunk.kind === "text") {
        lastTextIndex = chunk.index;
        if (attempt && pending.has(e.turnId)) {
          pending.delete(e.turnId);
          yield {
            ...chunk,
            text: `${liveLine(attempt)}${REPLY_SEPARATOR}${chunk.text}`,
          };
          continue;
        }
      }

      if (chunk.kind === "stop") {
        if (attempt && chunk.usage) {
          const before = attempt.cost ?? 0;
          addUsage(attempt, chunk.usage, settings.ttl);
          spent += (attempt.cost ?? 0) - before;
          // The main loop's last carried size and output price its next
          // switch; a subagent's are its own conversation.
          if (e.agentId === undefined) {
            lastUsage = {
              context: carriedOf(chunk.usage),
              output: chunk.usage.output_tokens,
            };
          }
        }

        // The summary goes under the reply once it is over: this step ends
        // the turn, and no background task is still running that will wake
        // the loop and add to it. The index must be one past the last text
        // block, and this is load-bearing. A chunk yielded at an index the
        // engine already streamed is dropped on the floor, silently: probed
        // live, a chunk at `lastTextIndex` never reached the transcript,
        // one at `lastTextIndex + 1` did. It opens a block of its own,
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
          attempt.kind !== "nudge" &&
          !MID_TURN.has(chunk.stopReason ?? "") &&
          !(await agentsRunning($, replyAgents))
        ) {
          const summary = replySummary(reply);
          if (summary !== null) {
            yield {
              kind: "text" as const,
              index: lastTextIndex + 1,
              text: `${FOOTER_SEPARATOR}${summary}`,
            };
            // Written once; what comes after is a new reply's worth.
            reply = [];
            replyAgents = new Set();
          }
        }
      }

      yield chunk;
    }
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
    return started;
  });

  // The footer, where a surface draws one. The announcement above is what
  // carries on surfaces that draw no footer, which is most of them.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const modes = withLabel(e.props.modes, labelOf(latest, enabled));
    return next({ ...e, props: { ...e.props, modes } });
  });
}
