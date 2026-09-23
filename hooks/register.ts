import type { On } from "claude-code";

import {
  askJev,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
} from "./jev.ts";
import { labelOf, withLabel } from "./label.ts";
import {
  excludedTiers,
  isContinuation,
  lowOffOf,
  mediumOffOf,
  offeredTiers,
  parseOverride,
  stickyOf,
  thresholdOf,
  TIERS,
  maxOffOf,
  ultraOffOf,
  xhighOffOf,
  type Decision,
  type Tier,
} from "./policy.ts";
import { providerOf } from "./provider.ts";
import {
  addUsage,
  announceReply,
  attemptOf,
  continuationOf,
  continuationSkipped,
  HISTORY_LIMIT,
  liveLine,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  spawnAttemptOf,
  statusReport,
  toggleReply,
  stickyCommand,
  lowCommand,
  mediumCommand,
  maxCommand,
  ultraCommand,
  xhighCommand,
  usageFooter,
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
 * the footer would land in the middle of a reply. Every other reason ends it.
 */
const MID_TURN: ReadonlySet<string> = new Set(["tool_use", "pause_turn"]);

/**
 * Asks Jev about one piece of text; the provider and budget come from the
 * env. A top-level function on purpose: the engine follows where `$` goes
 * when it loads a module, and only lets it into a function declared here at
 * the top, so a closure taking `$` inside `register` fails the whole module
 * (measured 2026-09-23: it loaded nothing and every turn went unrouted).
 */
async function classify($: Engine, text: string, offered: readonly Tier[]) {
  return askJev({
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms) => $.clock.sleep(ms),
    provider: providerOf({
      TYPESAFE_API_KEY: await $.env.get("TYPESAFE_API_KEY"),
      AI_GATEWAY_API_KEY: await $.env.get("AI_GATEWAY_API_KEY"),
      JEV_ROUTER_PROVIDER: await $.env.get("JEV_ROUTER_PROVIDER"),
      TYPESAFE_BASE_URL: await $.env.get("TYPESAFE_BASE_URL"),
    }),
    state: text,
    offered,
    timeoutMs: timeoutOf(await $.env.get("JEV_ROUTER_TIMEOUT_MS")),
  });
}

/**
 * Seeds sticky from env once per session, and only once: `/jev sticky` may
 * have already set it, and re-reading env after that would undo the override.
 * A top-level function for the same reason as `classify` above — `$` may only
 * reach a function declared here, never a closure inside `register`.
 */
async function seedSticky(
  $: Engine,
  state: { sticky: number | null; stickyReady: boolean },
): Promise<{ sticky: number | null; stickyReady: boolean }> {
  if (state.stickyReady) return state;
  const sticky = stickyOf(await $.env.get("JEV_ROUTER_STICKY"))
    ? thresholdOf(await $.env.get("JEV_ROUTER_STICKY_CONFIDENCE"))
    : null;
  return { sticky, stickyReady: true };
}

/**
 * Seeds the xhigh block list from env once per session. Same `$`-flow rule
 * as `seedSticky`: must be top-level, with state passed in and out.
 */
async function seedXhigh(
  $: Engine,
  state: { xhighOff: Set<Tier>; xhighReady: boolean },
): Promise<{ xhighOff: Set<Tier>; xhighReady: boolean }> {
  if (state.xhighReady) return state;
  return {
    xhighOff: xhighOffOf(await $.env.get("JEV_ROUTER_XHIGH_OFF")),
    xhighReady: true,
  };
}

/**
 * Seeds the medium ceiling block list from env once per session. Same
 * `$`-flow rule as `seedSticky` / `seedXhigh`.
 */
async function seedMedium(
  $: Engine,
  state: { mediumOff: Set<Tier>; mediumReady: boolean },
): Promise<{ mediumOff: Set<Tier>; mediumReady: boolean }> {
  if (state.mediumReady) return state;
  return {
    mediumOff: mediumOffOf(await $.env.get("JEV_ROUTER_MEDIUM_OFF")),
    mediumReady: true,
  };
}

/**
 * Seeds the low ceiling block list from env once per session.
 */
async function seedLow(
  $: Engine,
  state: { lowOff: Set<Tier>; lowReady: boolean },
): Promise<{ lowOff: Set<Tier>; lowReady: boolean }> {
  if (state.lowReady) return state;
  return {
    lowOff: lowOffOf(await $.env.get("JEV_ROUTER_LOW_OFF")),
    lowReady: true,
  };
}

/**
 * Seeds the max block list from `JEV_ROUTER_MAX_OFF` once per session.
 */
async function seedMax(
  $: Engine,
  state: { maxOff: Set<Tier>; maxReady: boolean },
): Promise<{ maxOff: Set<Tier>; maxReady: boolean }> {
  if (state.maxReady) return state;
  return {
    maxOff: maxOffOf(await $.env.get("JEV_ROUTER_MAX_OFF")),
    maxReady: true,
  };
}

/**
 * Seeds the ultra block list from `JEV_ROUTER_ULTRA_OFF` once per session.
 */
async function seedUltra(
  $: Engine,
  state: { ultraOff: Set<Tier>; ultraReady: boolean },
): Promise<{ ultraOff: Set<Tier>; ultraReady: boolean }> {
  if (state.ultraReady) return state;
  return {
    ultraOff: ultraOffOf(await $.env.get("JEV_ROUTER_ULTRA_OFF")),
    ultraReady: true,
  };
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
  let latest: Decision | null = null;
  /**
   * The confidence a switch must clear, or null when switches are free. The
   * env vars are the session's starting value; `/jev sticky` overrides them
   * from then on, so retuning does not mean restarting the session.
   */
  let sticky: number | null = null;
  /** True once sticky has been seeded from env or set by `/jev sticky`. */
  let stickyReady = false;
  /**
   * Tiers for which xhigh (and max) effort is blocked. Defaults to every
   * tier (cap at high) until seeded; `JEV_ROUTER_XHIGH_OFF` and `/jev xhigh`
   * override from then on.
   */
  let xhighOff = new Set<Tier>(TIERS);
  let xhighReady = false;
  /**
   * Tiers for which max+ is blocked (cap at xhigh). Defaults to every
   * tier; only matters once xhigh is allowed.
   */
  let maxOff = new Set<Tier>(TIERS);
  let maxReady = false;
  /**
   * Tiers for which ultra is blocked (cap at max). Defaults to every
   * tier; only matters once max is allowed.
   */
  let ultraOff = new Set<Tier>(TIERS);
  let ultraReady = false;
  /**
   * Tiers for which high+ effort is blocked (cap at medium). Defaults to
   * every tier (session default ceiling is medium); `JEV_ROUTER_MEDIUM_OFF`
   * and `/jev medium` override from then on.
   */
  let mediumOff = new Set<Tier>(TIERS);
  let mediumReady = false;
  /**
   * Tiers for which medium+ effort is blocked (cap at low). Empty by
   * default — tighten with `JEV_ROUTER_LOW_OFF` or `/jev low off`.
   */
  let lowOff = new Set<Tier>();
  let lowReady = false;
  /** The tier the last routed turn ran on; what a shaky switch is held to. */
  let running: Decision | null = null;
  /**
   * What a bare go-ahead continues. Cleared on an unrouted turn: that turn
   * ran on the session model, so re-applying the older routed decision would
   * be wrong. Stickiness still holds to `running` (last routed).
   */
  let continueFrom: Decision | null = null;
  let enabled = true;
  let announce = true;
  let surface: string | null = null;
  /**
   * agentId → what its spawn settled on, for the subagent's own steps to
   * apply and for /jev to show. Keyed by the id `next(e)` hands back from
   * `agent.spawn`, which is the same id the loop's `turn.step` carries.
   */
  const spawned = new Map<string, Attempt>();

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

  const clearRouting = () => {
    decisions.clear();
    byTurn.clear();
    pending.clear();
    // spawned is kept: turn.step already ignores it while off, and clearing
    // it made /jev on mid-agent invent "not routed at spawn" and drop effort.
    latest = null;
    continueFrom = null;
    running = null;
  };

  const record = (attempt: Attempt) => {
    attempts.unshift(attempt);
    attempts.length = Math.min(attempts.length, HISTORY_LIMIT);
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description:
        "Jev routing: status, on/off, sticky, low, medium, xhigh, max, ultra.",
    });
    surface = await $.session.surface();
    ({ sticky, stickyReady } = await seedSticky($, { sticky, stickyReady }));
    ({ lowOff, lowReady } = await seedLow($, { lowOff, lowReady }));
    ({ mediumOff, mediumReady } = await seedMedium($, {
      mediumOff,
      mediumReady,
    }));
    ({ xhighOff, xhighReady } = await seedXhigh($, { xhighOff, xhighReady }));
    ({ maxOff, maxReady } = await seedMax($, { maxOff, maxReady }));
    ({ ultraOff, ultraReady } = await seedUltra($, { ultraOff, ultraReady }));
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e) => {
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
      ({ sticky, stickyReady } = await seedSticky($, { sticky, stickyReady }));
      const result = stickyCommand(sub.slice("sticky".length), sticky);
      sticky = result.sticky;
      stickyReady = true;
      return { text: result.text };
    }

    if (sub === "low" || sub.startsWith("low ")) {
      ({ lowOff, lowReady } = await seedLow($, { lowOff, lowReady }));
      const result = lowCommand(sub.slice("low".length), lowOff);
      lowOff = result.lowOff;
      lowReady = true;
      return { text: result.text };
    }

    if (sub === "medium" || sub.startsWith("medium ")) {
      ({ mediumOff, mediumReady } = await seedMedium($, {
        mediumOff,
        mediumReady,
      }));
      const result = mediumCommand(sub.slice("medium".length), mediumOff);
      mediumOff = result.mediumOff;
      mediumReady = true;
      return { text: result.text };
    }

    if (sub === "xhigh" || sub.startsWith("xhigh ")) {
      ({ xhighOff, xhighReady } = await seedXhigh($, { xhighOff, xhighReady }));
      const result = xhighCommand(sub.slice("xhigh".length), xhighOff);
      xhighOff = result.xhighOff;
      xhighReady = true;
      return { text: result.text };
    }

    if (sub === "max" || sub.startsWith("max ")) {
      ({ maxOff, maxReady } = await seedMax($, { maxOff, maxReady }));
      const result = maxCommand(sub.slice("max".length), maxOff);
      maxOff = result.maxOff;
      maxReady = true;
      return { text: result.text };
    }

    if (sub === "ultra" || sub.startsWith("ultra ")) {
      ({ ultraOff, ultraReady } = await seedUltra($, { ultraOff, ultraReady }));
      const result = ultraCommand(sub.slice("ultra".length), ultraOff);
      ultraOff = result.ultraOff;
      ultraReady = true;
      return { text: result.text };
    }

    ({ sticky, stickyReady } = await seedSticky($, { sticky, stickyReady }));
    ({ lowOff, lowReady } = await seedLow($, { lowOff, lowReady }));
    ({ mediumOff, mediumReady } = await seedMedium($, {
      mediumOff,
      mediumReady,
    }));
    ({ xhighOff, xhighReady } = await seedXhigh($, { xhighOff, xhighReady }));
    ({ maxOff, maxReady } = await seedMax($, { maxOff, maxReady }));
    ({ ultraOff, ultraReady } = await seedUltra($, { ultraOff, ultraReady }));
    if (surface === null) surface = await $.session.surface();
    const excluded = excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE"));
    const provider = providerOf({
      TYPESAFE_API_KEY: await $.env.get("TYPESAFE_API_KEY"),
      AI_GATEWAY_API_KEY: await $.env.get("AI_GATEWAY_API_KEY"),
      JEV_ROUTER_PROVIDER: await $.env.get("JEV_ROUTER_PROVIDER"),
      TYPESAFE_BASE_URL: await $.env.get("TYPESAFE_BASE_URL"),
    });
    return {
      text: statusReport({
        enabled,
        surface,
        provider,
        timeoutMs: timeoutOf(await $.env.get("JEV_ROUTER_TIMEOUT_MS")),
        sticky,
        lowOff: [...lowOff],
        mediumOff: [...mediumOff],
        xhighOff: [...xhighOff],
        maxOff: [...maxOff],
        ultraOff: [...ultraOff],
        offered: offeredTiers(excluded),
        excluded: [...excluded],
        announce,
        attempts,
      }),
    };
  });

  on("turn.start", async ($, e, next) => {
    if (!enabled) return next(e);

    ({ sticky, stickyReady } = await seedSticky($, { sticky, stickyReady }));
    ({ lowOff, lowReady } = await seedLow($, { lowOff, lowReady }));
    ({ mediumOff, mediumReady } = await seedMedium($, {
      mediumOff,
      mediumReady,
    }));
    ({ xhighOff, xhighReady } = await seedXhigh($, { xhighOff, xhighReady }));
    ({ maxOff, maxReady } = await seedMax($, { maxOff, maxReady }));
    ({ ultraOff, ultraReady } = await seedUltra($, { ultraOff, ultraReady }));
    if (surface === null) surface = await $.session.surface();

    const offered = offeredTiers(
      excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE")),
    );

    // A bare go-ahead continues the previous turn's work on the previous
    // turn's decision, without a round trip: Jev is confidently wrong about
    // these (it grades the text, which is trivial, not the task, which is
    // whatever was just proposed). When there is nothing to continue (first
    // turn, or the previous turn left the session model), still do not ask
    // Jev — that would clear sticky with a ~1.00 haiku pick.
    const attempt = isContinuation(e.text)
      ? continueFrom !== null
        ? continuationOf(
            e.text,
            continueFrom,
            xhighOff,
            mediumOff,
            lowOff,
            maxOff,
            ultraOff,
          )
        : continuationSkipped(e.text)
      : attemptOf(e.text, await classify($, e.text, offered), offered, {
          sticky,
          running,
          forced: parseOverride(e.text, offered),
          lowOff,
          mediumOff,
          xhighOff,
          maxOff,
          ultraOff,
        });

    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened.
    record(attempt);
    byTurn.set(e.turnId, attempt);
    trimByTurn();

    // The line goes into the reply's own text, in turn.step below. Render
    // hooks and $.ui.log both drew nothing in the desktop app; the model's
    // text is the one channel that reaches every surface.
    if (announce) {
      pending.add(e.turnId);
      trimSet(pending);
    }

    if ("decision" in attempt) {
      decisions.set(e.turnId, attempt.decision);
      trim(decisions);
      latest = attempt.decision;
      // What the next turn holds to is the tier actually running, which on a
      // held turn is the previous one, not the one Jev named.
      running = attempt.decision;
      continueFrom = attempt.decision;
    } else {
      // Unrouted: the session model answered. A following go-ahead must not
      // re-apply the last routed tier as if that were the previous turn.
      continueFrom = null;
    }

    return next(e);
  });

  // turn.step streams, so it is an async generator. The model rewrite goes
  // down in `e`; the label comes back up in the first text chunk of the turn,
  // and the `stop` chunk's usage, which names the model the API says answered,
  // is kept on the turn. That is the check on the rewrite: the route line is
  // what was asked for, /jev shows what was got.
  //
  // Text chunks concatenate per block, so prefixing the first one puts the
  // line at the top of the reply. This is the recorded text too, so the model
  // sees its past replies open with the line; that is the price of a marker
  // that reaches a surface which draws neither render sites nor ui.log.
  on("turn.step", async function* ($, e, next) {
    // Routing off is authoritative for every step, including subagents whose
    // spawn decision was cached before /jev off.
    if (!enabled) {
      for await (const chunk of next(e)) yield chunk;
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
          skipped: "not routed at spawn; on its own model",
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
    const step = decision
      ? next({ ...e, model: decision.model, effort: decision.effort })
      : next(e);

    // The block the footer joins, so it lands at the end of the reply's text
    // rather than opening a block of its own.
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
        if (attempt && chunk.usage) addUsage(attempt, chunk.usage);

        // The index must be one past the last text block, and this is
        // load-bearing. A chunk yielded at an index the engine already
        // streamed is dropped on the floor, silently: probed live, a chunk
        // at `lastTextIndex` never reached the transcript, one at
        // `lastTextIndex + 1` did. It opens a block of its own, which is
        // what a footer wants anyway — the reply above it stays untouched.
        //
        // No `ref`, because the engine's handle belongs to a chunk the
        // engine streamed; one a hook built has none and is taken at its
        // word. It goes before the stop chunk, the last thing the engine
        // expects to see.
        // Not in a subagent's reply: that is a tool result its parent reads.
        if (
          attempt &&
          announce &&
          attempt.kind !== "agent" &&
          !MID_TURN.has(chunk.stopReason ?? "")
        ) {
          const footer = usageFooter(attempt);
          if (footer !== null) {
            yield {
              kind: "text" as const,
              index: lastTextIndex + 1,
              text: `${FOOTER_SEPARATOR}${footer}`,
            };
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
    if (!enabled || e.fork || e.model !== undefined) return next(e);

    ({ lowOff, lowReady } = await seedLow($, { lowOff, lowReady }));
    ({ mediumOff, mediumReady } = await seedMedium($, {
      mediumOff,
      mediumReady,
    }));
    ({ xhighOff, xhighReady } = await seedXhigh($, { xhighOff, xhighReady }));
    ({ maxOff, maxReady } = await seedMax($, { maxOff, maxReady }));
    ({ ultraOff, ultraReady } = await seedUltra($, { ultraOff, ultraReady }));
    const offered = offeredTiers(
      excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE")),
    );
    const attempt = spawnAttemptOf(
      e.description,
      await classify($, e.prompt, offered),
      offered,
      { type: e.subagentType, label: e.description },
      xhighOff,
      mediumOff,
      lowOff,
      maxOff,
      ultraOff,
    );
    record(attempt);

    const started = await next(
      "decision" in attempt ? { ...e, model: attempt.decision.model } : e,
    );
    if (started.agentId !== undefined) {
      // Never trimmed: FIFO eviction here silently dropped effort routing for
      // resumed agents and invented "not routed at spawn" history rows.
      spawned.set(started.agentId, attempt);
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
