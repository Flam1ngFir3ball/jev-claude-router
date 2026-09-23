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
  offeredTiers,
  parseOverride,
  stickyOf,
  thresholdOf,
  type Decision,
  type Tier,
} from "./policy.ts";
import { providerOf } from "./provider.ts";
import {
  addUsage,
  announceReply,
  attemptOf,
  continuationOf,
  HISTORY_LIMIT,
  liveLine,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  spawnAttemptOf,
  statusReport,
  toggleReply,
  stickyCommand,
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
  /** The tier the last routed turn ran on; what a shaky switch is held to. */
  let running: Decision | null = null;
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

  const trimSet = (set: Set<string>) => {
    while (set.size > CACHE_LIMIT) {
      const oldest = set.values().next();
      if (oldest.done) break;
      set.delete(oldest.value);
    }
  };

  const record = (attempt: Attempt) => {
    attempts.unshift(attempt);
    attempts.length = Math.min(attempts.length, HISTORY_LIMIT);
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "jev",
      description: "Jev routing: status, or `on` / `off`.",
    });
    surface = await $.session.surface();
    sticky = stickyOf(await $.env.get("JEV_ROUTER_STICKY"))
      ? thresholdOf(await $.env.get("JEV_ROUTER_STICKY_CONFIDENCE"))
      : null;
    return next(e);
  });

  on("command.run", { command: "jev" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();

    if (arg === "on" || arg === "off") {
      enabled = arg === "on";
      if (!enabled) latest = null;
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
      const result = stickyCommand(sub.slice("sticky".length), sticky);
      sticky = result.sticky;
      return { text: result.text };
    }

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
        surface: surface ?? (await $.session.surface()),
        provider,
        timeoutMs: timeoutOf(await $.env.get("JEV_ROUTER_TIMEOUT_MS")),
        sticky,
        offered: offeredTiers(excluded),
        excluded: [...excluded],
        announce,
        attempts,
      }),
    };
  });

  on("turn.start", async ($, e, next) => {
    if (!enabled) return next(e);

    const offered = offeredTiers(
      excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE")),
    );

    // A bare go-ahead continues the previous turn's work on the previous
    // turn's decision, without a round trip: Jev is confidently wrong about
    // these (it grades the text, which is trivial, not the task, which is
    // whatever was just proposed). Nothing to continue on the first turn.
    const attempt =
      isContinuation(e.text) && running !== null
        ? continuationOf(e.text, running)
        : attemptOf(e.text, await classify($, e.text, offered), offered, {
            sticky,
            running,
            forced: parseOverride(e.text, offered),
          });

    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened.
    record(attempt);
    byTurn.set(e.turnId, attempt);
    trim(byTurn);

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
    // A subagent's loop gets no turn.start (probed live: its steps arrive
    // with agentId set and nothing in byTurn), so its turn is first seen
    // here. Its decision was made at agent.spawn, keyed by the id the spawn
    // handed back, and the steps apply it: the spawn set the model, but
    // effort is per request, and this is where requests are made. A line in
    // its reply would land in the tool result its parent reads, so it gets
    // none; it is recorded, though, or /jev would show one prompt and hide
    // the four requests it caused.
    let attempt = byTurn.get(e.turnId);
    if (attempt === undefined && e.agentId !== undefined) {
      attempt = spawned.get(e.agentId);
      if (attempt === undefined) {
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
      }
      record(attempt);
      byTurn.set(e.turnId, attempt);
      trim(byTurn);
    }
    const decision =
      decisions.get(e.turnId) ??
      (attempt && "decision" in attempt ? attempt.decision : undefined);
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

    const offered = offeredTiers(
      excludedTiers(await $.env.get("JEV_ROUTER_EXCLUDE")),
    );
    const attempt = spawnAttemptOf(
      e.description,
      await classify($, e.prompt, offered),
      offered,
      { type: e.subagentType, label: e.description },
    );
    record(attempt);

    const started = await next(
      "decision" in attempt ? { ...e, model: attempt.decision.model } : e,
    );
    if (started.agentId !== undefined) {
      spawned.set(started.agentId, attempt);
      trim(spawned);
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
