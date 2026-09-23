import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { register } from "../hooks/register.ts";

/**
 * Drives the real `register` with a fake engine: captures the hooks it
 * registers, then runs turn.start and turn.step the way the engine would.
 */
function load(
  env: Record<string, string | undefined> = { AI_GATEWAY_API_KEY: "gw-key" },
  /** A store and session id shared with another load: a reload of the module. */
  shared: { store: Map<string, unknown>; id: string } = { store: new Map(), id: "sess-1" },
) {
  let listCalls = 0;
  const hooks = new Map<string, Function>();
  const on = (name: string, a: unknown, b?: unknown) => {
    const key = typeof a === "function" ? name : `${name}:${JSON.stringify(a)}`;
    hooks.set(key, (typeof a === "function" ? a : b) as Function);
    return { catch: () => {} };
  };
  register(on as never);

  let tier = "opus";
  let confidence = 0.91;
  let score = 2;
  let scoreConfidence = 0.9;
  let ok = true;
  let fetches = 0;
  let lastState: string | undefined;
  let contextTokens: number | null = 1_000;
  let agentStatus = "completed";
  let sessionModel = "claude-opus-5-5";

  // Most register tests assume sticky off; production defaults sticky on.
  // Pass `JEV_ROUTER_STICKY: undefined` to exercise the real default.
  const merged: Record<string, string | undefined> = {
    JEV_ROUTER_STICKY: "0",
    ...env,
  };

  const $ = {
    env: { get: async (k: string) => merged[k] },
    clock: { sleep: () => new Promise<never>(() => {}) },
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        fetches++;
        lastState = init?.body ? JSON.parse(init.body).state : undefined;
        const good = ok;
        ok = true;
        return {
          ok: good,
          status: good ? 200 : 500,
          headers: {},
          text: JSON.stringify({
            answers: {
              tier: { type: "choice", choice: tier, confidence },
              effort: { type: "score", score, confidence: scoreConfidence },
            },
          }),
        };
      },
    },
    command: { register: async () => {} },
    store: {
      get: async (k: string) => {
        const v = shared.store.get(k);
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      },
      set: async (k: string, v: unknown) => {
        shared.store.set(k, JSON.parse(JSON.stringify(v)));
      },
      keys: async () => [...shared.store.keys()],
      delete: async (k: string) => {
        shared.store.delete(k);
      },
    },
    session: {
      id: async () => shared.id,
      surface: async () => "test",
      surfaces: async () => ["test"],
      model: async () => sessionModel,
      /** The engine's count of what the last response carried; settable per test. */
      usage: async () =>
        contextTokens === null ? undefined : { context: { tokens: contextTokens } },
    },
    agent: {
      list: async () => {
        listCalls++;
        return [
          {
            id: "agent-1",
            type: "general-purpose",
            description: "Review library-sync cluster",
            status: agentStatus,
          },
        ];
      },
    },
  };
  return {
    hooks,
    $,
    listCalls: () => listCalls,
    /** How many times Jev was asked, and the last text it was asked about. */
    fetches: () => fetches,
    lastState: () => lastState,
    /** What Jev answers from the next turn on. */
    setTier: (name: string, c = 0.91, s = 2, sc = 0.9) => {
      tier = name;
      confidence = c;
      score = s;
      scoreConfidence = sc;
    },
    /** Makes only the next Jev call fail, so that one turn goes unrouted. */
    fail: () => {
      ok = false;
    },
    /** What `$.session.usage()` reports the context to be, or null for nothing yet. */
    setContext: (tokens: number | null) => {
      contextTokens = tokens;
    },
    /** What `$.agent.list()` says the one agent is doing. */
    setAgentStatus: (status: string) => {
      agentStatus = status;
    },
    /** What `$.session.model()` returns. */
    setSessionModel: (model: string) => {
      sessionModel = model;
    },
  };
}

async function* modelSays(...texts: string[]) {
  yield { kind: "engine", ref: 1 };
  for (const [i, text] of texts.entries())
    yield { kind: "text", index: 0, text, ref: i + 2 };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return { stopReason: "end_turn" };
}

// A working turn's shape: 10k carried, 3k produced. With the harness's 1k
// context (below) a downgrade pays, so the confidence bar is what the
// sticky tests exercise; the cost-hold tests raise the context themselves.
const usage = (model: string, input_tokens = 1000) => ({
  model,
  input_tokens,
  output_tokens: 3000,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
});

async function* answeredBy(
  model: string,
  stopReason = "end_turn",
  input_tokens = 1000,
) {
  yield { kind: "text", index: 0, text: "reply", ref: 1 };
  yield { kind: "stop", stopReason, usage: usage(model, input_tokens), ref: 2 };
  return { stopReason };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("register: the route in the reply", () => {
  test("the first text chunk of a routed turn opens with the route line", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "implement it", turnId: "t1" },
      async (e: unknown) => e,
    );

    let sent: { model?: string; effort?: string } = {};
    const step = hooks.get("turn.step")!(
      $,
      { turnId: "t1", index: 0, model: "claude-fable-5-1" },
      (e: { model: string; effort: string }) => {
        sent = e;
        return modelSays("Hello", " there.");
      },
    );
    const chunks = await collect(step);
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);

    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "medium");
    // The latency is wall-clock, so it is matched loosely.
    assert.match(
      texts[0]!,
      /^> ✳️ opus · medium · Jev 91% · capped from high · \d+ms\n\n---\n\nHello$/,
    );
    assert.equal(texts[1], " there.");
    assert.equal(
      chunks[0]!.kind,
      "engine",
      "engine chunks pass through untouched",
    );
  });

  test("the line is put in once per turn, not once per step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t2" },
      async (e: unknown) => e,
    );
    const run = (index: number) =>
      collect(
        hooks.get("turn.step")!($, { turnId: "t2", index }, () =>
          modelSays("reply"),
        ),
      );

    const first = await run(0);
    const second = await run(1);
    assert.match(first.find((c) => c.kind === "text")!.text, /^> ✳️ opus/);
    assert.equal(second.find((c) => c.kind === "text")!.text, "reply");
  });

  test("an unrouted turn still says so at the top of its reply", async () => {
    const { hooks, $ } = load({});
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t3" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "t3", index: 0, model: "m" },
        (e: { model: string }) => {
          assert.equal(e.model, "m", "no decision, so the model is left alone");
          return modelSays("reply");
        },
      ),
    );
    assert.equal(
      chunks.find((c) => c.kind === "text")!.text,
      "> ⚠️ not routed: no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY\n\n---\n\nreply",
    );
  });

  test("a step whose first chunks are not text waits for the text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t4" },
      async (e: unknown) => e,
    );
    async function* thinkingFirst() {
      yield { kind: "thinking", index: 0, text: "hmm" };
      yield { kind: "text", index: 1, text: "answer" };
      yield { kind: "stop", stopReason: "end_turn", usage: null };
    }
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t4", index: 0 }, () =>
        thinkingFirst(),
      ),
    );
    assert.equal(chunks[0]!.text, "hmm", "thinking is not where the line goes");
    assert.match(chunks[1]!.text, /^> ✳️ opus.*\n\n---\n\nanswer$/);
  });

  test("/jev quiet keeps routing but drops the line", async () => {
    const { hooks, $ } = load();
    const cmd = hooks.get('command.run:{"command":"jev"}')!;
    await cmd($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t5" },
      async (e: unknown) => e,
    );
    let sent: { model?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "t5", index: 0 },
        (e: { model: string }) => {
          sent = e;
          return modelSays("reply");
        },
      ),
    );
    assert.equal(sent.model, "claude-opus-5-5", "still routed");
    assert.equal(chunks.find((c) => c.kind === "text")!.text, "reply");
  });

  test("the stop chunk’s usage lands on the turn and /jev confirms what answered", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t6" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t6", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the stop chunk still reaches the engine",
    );

    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /opus-5-5 ✓/);
    assert.match(out.text, /90% cached/);
  });

  test("a turn of two steps sums both requests", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t7" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t7", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t7", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /22k in/, out.text);
  });

  test("a different model answering than was asked for is flagged", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t8" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t8", index: 0 }, () =>
        answeredBy("claude-haiku-4-5"),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /haiku-4-5 ⚠ asked opus-5-5/);
  });

  test("a stop chunk for a turn we never saw is left alone", async () => {
    const { hooks, $ } = load();
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "ghost", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(chunks.length, 2);
  });

  test("the footer closes a finished turn, after the reply text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t9" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t9", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );

    const texts = chunks.filter((c) => c.kind === "text");
    const footer = texts.at(-1)!.text;
    assert.match(footer, /```\nopus-5-5 ✓ medium · Jev 91%/);
    assert.match(footer, /\$/);
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the footer goes before the stop chunk",
    );
    assert.equal(
      texts.at(-1)!.ref,
      undefined,
      "a chunk we made carries no engine handle",
    );

    // Load-bearing: the engine drops a chunk yielded at an index it already
    // streamed. One past the last text block opens a block of its own.
    const reply = texts.find((c) => c.ref !== undefined)!;
    assert.equal(texts.at(-1)!.index, reply.index + 1);
  });

  test("a step that only called a tool gets no footer, since the turn goes on", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t10" },
      async (e: unknown) => e,
    );
    const mid = await collect(
      hooks.get("turn.step")!($, { turnId: "t10", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use"),
      ),
    );
    assert.doesNotMatch(
      mid
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      /Model  answered by/,
    );

    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "t10", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn"),
      ),
    );
    assert.match(
      last.filter((c) => c.kind === "text").at(-1)!.text,
      /opus-5-5 ✓ medium/,
    );
  });

  test("the footer sums the whole turn, not just its last step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t11" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t11", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "t11", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    assert.match(last.filter((c) => c.kind === "text").at(-1)!.text, /22k in/);
  });

  test("/jev quiet drops the footer with the line", async () => {
    const { hooks, $ } = load();
    await hooks.get('command.run:{"command":"jev"}')!($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t12" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t12", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      "reply",
    );
  });

  test("a turn whose response carried no usage ends without a footer", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t13" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t13", index: 0 }, () =>
        modelSays("reply"),
      ),
    );
    assert.doesNotMatch(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      /jev {2}opus/,
    );
  });

  test("a turn started by a task notification is tagged notify, in the line and the footer", async () => {
    const { hooks, $ } = load();
    const notice =
      '<task-notification><task-id>abc</task-id><summary>Agent "reviewer" completed</summary></task-notification>';
    await hooks.get("turn.start")!(
      $,
      { text: notice, turnId: "n1" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "n1", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);
    assert.match(texts[0]!, /^> ✳️ opus · medium · Jev 91% · capped from high · task finished · 0ms/);
    assert.match(texts.at(-1)!, /opus-5-5 ✓ medium · Jev 91% · /);
    assert.match(texts.at(-1)!, /capped from high/);
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /\[task finished\] Agent "reviewer" completed/);
  });

  test("a subagent’s step, which no turn.start announced, is recorded unrouted with what ran it", async () => {
    const { hooks, $, listCalls } = load();
    let sent: { model?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        {
          turnId: "sub1",
          index: 0,
          agentId: "agent-1",
          model: "claude-opus-5-5",
        },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    assert.equal(sent.model, "claude-opus-5-5", "left on the session model");
    assert.equal(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      "reply",
      "nothing added to a tool result the parent will read",
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(
      out.text,
      /not routed — \[general-purpose agent\] Review library-sync cluster/,
    );
    assert.match(out.text, /opus-5/);
    assert.equal(listCalls(), 1);
  });

  test("a subagent’s later steps add to the same record, and read the list once", async () => {
    const { hooks, $, listCalls } = load();
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub2", index: 0, agentId: "agent-1" },
        () => answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub2", index: 1, agentId: "agent-1" },
        () => answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.equal(out.text.match(/not routed — \[general-purpose agent\]/g)?.length, 1);
    assert.match(out.text, /22k in/);
    assert.equal(listCalls(), 1);
  });

  test("an agent the list does not know yet is still recorded, by its id", async () => {
    const { hooks, $ } = load();
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub3", index: 0, agentId: "agent-unknown-xyz" },
        () => answeredBy("claude-opus-5-5"),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /not routed — \[agent\] agent-unknown-xyz/);
  });

  test("a main-loop step with no agents of its own never touches the agent list", async () => {
    const { hooks, $, listCalls } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "s4" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "s4", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(listCalls(), 0);
  });
});

describe("register: stickiness", () => {
  /**
   * A session whose env asks for stickiness, started: the env is read in
   * session.start, which the engine always fires and a test must too.
   */
  const sticky = async (over: Record<string, string> = {}) => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      ...over,
    });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  /** Runs one turn end to end and says which model the request named. */
  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("with the flag off, a shaky switch still moves the model", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "a1");
    setTier("haiku", 0.4);
    const second = await turn(hooks, $, "a2");
    assert.equal(second.sent.model, "claude-haiku-4-5");
    assert.doesNotMatch(second.text, /held/);
  });

  test("with the flag on, a shaky switch is held on the last tier", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "b1");
    setTier("haiku", 0.4);
    const second = await turn(hooks, $, "b2");
    assert.equal(
      second.sent.model,
      "claude-opus-5-5",
      "held on the first turn’s tier",
    );
    assert.match(second.text, /kept opus: Jev \d+% on haiku/);
  });

  test("a confident switch still goes through with the flag on", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "c1");
    setTier("haiku", 0.9);
    const second = await turn(hooks, $, "c2");
    assert.equal(second.sent.model, "claude-haiku-4-5");
  });

  test("the bar is read from the environment", async () => {
    const { hooks, $, setTier } = await sticky({
      JEV_ROUTER_STICKY_CONFIDENCE: "0.3",
    });
    await turn(hooks, $, "d1");
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "d2")).sent.model,
      "claude-haiku-4-5",
      "0.4 clears a 0.3 bar",
    );
  });

  test("effort moves on a held turn, since it keeps the same model", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "e1");
    setTier("haiku", 0.4, 0);
    const second = await turn(hooks, $, "e2");
    assert.equal(second.sent.model, "claude-opus-5-5");
    assert.equal(second.sent.effort, "low");
  });

  test("a held turn becomes the tier the next turn holds to", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "f1");
    setTier("haiku", 0.4);
    await turn(hooks, $, "f2");
    const third = await turn(hooks, $, "f3");
    assert.equal(
      third.sent.model,
      "claude-opus-5-5",
      "still the tier that is actually running",
    );
  });

  test("an unrouted turn does not become something to hold to", async () => {
    const { hooks, $, setTier, fail } = await sticky();
    await turn(hooks, $, "g1");
    fail();
    await turn(hooks, $, "g2");
    setTier("haiku", 0.4);
    const third = await turn(hooks, $, "g3");
    assert.equal(
      third.sent.model,
      "claude-opus-5-5",
      "the last turn that actually ran",
    );
  });

  test("/jev says whether stickiness is on and what the bar is", async () => {
    const { hooks, $ } = await sticky({ JEV_ROUTER_STICKY_CONFIDENCE: "0.6" });
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /sticky\s+on, switch needs 60%/);
  });
});

describe("register: the sticky subcommand", () => {
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string } = {};
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    return sent;
  }

  test("/jev sticky before the first turn is not overwritten by a late env seed", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_STICKY_CONFIDENCE: "0.9",
    });
    // No session.start — sticky must still honour the command.
    await run(hooks, $, "sticky 0.3");
    assert.match((await run(hooks, $, "")).text, /switch needs 30%/);
    setTier("opus", 0.9);
    await turn(hooks, $, "seed1");
    assert.match(
      (await run(hooks, $, "")).text,
      /switch needs 30%/,
      "env seed must not clobber the command",
    );
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "seed2")).model,
      "claude-haiku-4-5",
      "0.4 clears the 0.3 bar",
    );
  });

  test("/jev sticky off before the first turn stays off when env asked for sticky", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_STICKY_CONFIDENCE: "0.9",
    });
    await run(hooks, $, "sticky off");
    setTier("opus", 0.9);
    await turn(hooks, $, "off1");
    setTier("haiku", 0.4);
    assert.equal((await turn(hooks, $, "off2")).model, "claude-haiku-4-5");
    assert.match((await run(hooks, $, "")).text, /sticky\s+off/);
  });

  test("/jev sticky turns it on for the session, with no env var set", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "h1");
    await run(hooks, $, "sticky");
    setTier("haiku", 0.4);
    assert.equal((await turn(hooks, $, "h2")).model, "claude-opus-5-5", "held");
  });

  test("/jev --sticky is the same command, since that is what people type", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "i1");
    await run(hooks, $, "--sticky");
    setTier("haiku", 0.4);
    assert.equal((await turn(hooks, $, "i2")).model, "claude-opus-5-5");
  });

  test("/jev sticky off turns it back off", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
    });
    await turn(hooks, $, "j1");
    await run(hooks, $, "sticky off");
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "j2")).model,
      "claude-haiku-4-5",
      "switched",
    );
  });

  test("/jev sticky 0.3 sets the bar for the session", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "k1");
    const out = await run(hooks, $, "sticky 0.3");
    assert.match(out.text, /30%/);
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "k2")).model,
      "claude-haiku-4-5",
      "0.4 clears a 0.3 bar",
    );
  });

  test("the env var is the session’s starting value, and the command overrides it", async () => {
    const { hooks, $ } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_STICKY_CONFIDENCE: "0.9",
    });
    await hooks.get("session.start")!($, {}, async (e: unknown) => e);
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 90%/,
    );
    await run(hooks, $, "sticky 0.5");
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 50%/,
    );
  });

  test("a bar that makes no sense changes nothing and says so", async () => {
    const { hooks, $ } = load();
    await run(hooks, $, "sticky 0.5");
    const out = await run(hooks, $, "sticky 7000");
    assert.match(out.text, /between/);
    assert.match((await run(hooks, $, "")).text, /switch needs 50%/);
  });
});

describe("register: a tier named in the prompt", () => {
  const started = async (over: Record<string, string> = {}) => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      ...over,
    });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  async function turn(
    hooks: Map<string, Function>,
    $: unknown,
    id: string,
    text = "x",
  ) {
    await hooks.get("turn.start")!(
      $,
      { text, turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("beats stickiness: 'use opus' is not held on fable", async () => {
    const { hooks, $, setTier, fetches } = await started();
    setTier("fable", 0.9);
    await turn(hooks, $, "f1", "plan the migration");
    const asked = fetches();
    setTier("opus", 0.43, 1);
    const second = await turn(hooks, $, "f2", "use opus for this");
    assert.equal(second.sent.model, "claude-opus-5-5");
    assert.equal(second.sent.effort, "medium");
    assert.equal(fetches(), asked, "forced skips Jev");
    assert.match(second.text, /opus · medium · your pick/);
    assert.doesNotMatch(second.text, /held/);
  });

  test("needs no answer from Jev", async () => {
    const { hooks, $, fail, fetches } = await started();
    const asked = fetches();
    fail();
    const t = await turn(hooks, $, "f3", "switch to haiku");
    assert.equal(t.sent.model, "claude-haiku-4-5");
    assert.equal(fetches(), asked, "Jev is not called");
    assert.match(t.text, /haiku · medium · your pick/);
  });

  test("cannot name a tier the environment excluded", async () => {
    const { hooks, $, setTier } = await started({ JEV_ROUTER_EXCLUDE: "fable" });
    setTier("opus", 0.9);
    const t = await turn(hooks, $, "f4", "use fable and plan it");
    assert.equal(t.sent.model, "claude-opus-5-5", "Jev’s pick stands");
    assert.doesNotMatch(t.text, /your pick/);
  });

  test("a forced Sonnet turn skips Jev and says forced", async () => {
    const { hooks, $, setTier, fetches } = await started({
      JEV_ROUTER_CEILING: "max",
    });
    setTier("sonnet", 0.9, 1, 0.9);
    await turn(hooks, $, "fs1", "small edit");
    const asked = fetches();
    setTier("sonnet", 0.9, 3, 0.2);
    const t = await turn(hooks, $, "fs2", "use sonnet for this");
    assert.equal(t.sent.effort, "medium", "forced defaults effort");
    assert.equal(fetches(), asked, "Jev is not asked");
    assert.match(t.text, /your pick/);
    assert.doesNotMatch(t.text, /kept \w+: Jev/);
  });
});

describe("register: a bare go-ahead", () => {
  const started = async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  async function turn(
    hooks: Map<string, Function>,
    $: unknown,
    id: string,
    text: string,
  ) {
    await hooks.get("turn.start")!(
      $,
      { text, turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("runs on the previous turn’s tier and effort, without asking Jev", async () => {
    const { hooks, $, setTier, fetches } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "g1", "plan the migration");
    const asked = fetches();
    // Jev would say haiku at 1.00 here (measured), which clears any bar.
    setTier("haiku", 1, 0);
    const second = await turn(hooks, $, "g2", "yes");
    assert.equal(second.sent.model, "claude-fable-5-1");
    // The default ceiling capped the first turn at medium, which its first
    // request ran as high; the go-ahead carries what Jev asked, medium.
    assert.equal(second.sent.effort, "medium");
    assert.equal(fetches(), asked, "no round trip for a go-ahead");
    assert.match(second.text, /fable · medium · continuing · 0ms/);
  });

  test("does not carry a hold tag over from the turn it continues", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9);
    await turn(hooks, $, "g3", "plan it");
    setTier("haiku", 0.4);
    const held = await turn(hooks, $, "g4", "now the tests");
    assert.match(held.text, /kept fable: Jev \d+% on haiku/);
    const go = await turn(hooks, $, "g5", "ok");
    assert.equal(go.sent.model, "claude-fable-5-1");
    assert.doesNotMatch(go.text, /kept/);
    assert.match(go.text, /continuing/);
  });

  test("on the first turn there is nothing to continue, so the session model stays", async () => {
    const { hooks, $, setTier, fetches } = await started();
    setTier("haiku", 1, 0);
    const t = await turn(hooks, $, "g6", "yes");
    assert.equal(fetches(), 0, "Jev is not asked; it would clear sticky");
    assert.equal(t.sent.model, undefined, "left on the session model");
    assert.match(t.text, /not routed/);
    assert.match(t.text, /nothing to continue/);
  });

  test("becomes what the next turn holds to", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9);
    await turn(hooks, $, "g7", "plan it");
    await turn(hooks, $, "g8", "go ahead");
    setTier("haiku", 0.4);
    const t = await turn(hooks, $, "g9", "and the tests");
    assert.equal(t.sent.model, "claude-fable-5-1", "held to fable, via the go-ahead");
  });

  test("after an unrouted turn, a go-ahead stays on the session model without asking Jev", async () => {
    const { hooks, $, setTier, fail, fetches } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "u1", "plan it");
    fail();
    await turn(hooks, $, "u2", "timeout turn");
    const asked = fetches();
    setTier("haiku", 1, 0);
    const go = await turn(hooks, $, "u3", "yes");
    assert.equal(fetches(), asked, "Jev is not asked");
    assert.equal(go.sent.model, undefined, "session model, not a stale fable or a haiku flip");
    assert.match(go.text, /nothing to continue/);
  });

  test("after /jev off then on, a go-ahead does not replay the pre-off route", async () => {
    const { hooks, $, setTier, fetches } = await started();
    const run = (args: string) =>
      hooks.get('command.run:{"command":"jev"}')!($, { args });
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "o1", "plan it");
    await run("off");
    await turn(hooks, $, "o2", "session turn while off");
    await run("on");
    const asked = fetches();
    setTier("haiku", 1, 0);
    const go = await turn(hooks, $, "o3", "yes");
    assert.equal(fetches(), asked);
    assert.equal(go.sent.model, undefined);
    assert.match(go.text, /nothing to continue/);
  });
});

describe("register: effort on Sonnet", () => {
  const started = async (over: Record<string, string> = {}) => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_CEILING: "max",
      ...over,
    });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("a shaky effort change while staying on Sonnet keeps the last effort", async () => {
    const { hooks, $, setTier } = await started();
    setTier("sonnet", 0.9, 1, 0.9);
    await turn(hooks, $, "s1");
    setTier("sonnet", 0.9, 3, 0.49);
    const t = await turn(hooks, $, "s2");
    assert.equal(t.sent.model, "claude-sonnet-5");
    assert.equal(t.sent.effort, "medium", "the previous effort, not xhigh");
    assert.match(t.text, /sonnet · medium · Jev 90% · kept medium: Jev 49% on xhigh/);
  });

  test("the bar is the session’s, so /jev sticky 0.3 lowers it here too", async () => {
    const { hooks, $, setTier } = await started();
    setTier("sonnet", 0.9, 1, 0.9);
    await turn(hooks, $, "s3");
    await run(hooks, $, "sticky 0.3");
    setTier("sonnet", 0.9, 3, 0.49);
    const t = await turn(hooks, $, "s4");
    assert.equal(t.sent.effort, "xhigh", "0.49 clears a 0.3 bar");
    assert.doesNotMatch(t.text, /held/);
  });

  test("on Opus the same change goes through: effort is free there", async () => {
    const { hooks, $, setTier } = await started();
    setTier("opus", 0.9, 1, 0.9);
    await turn(hooks, $, "s5");
    setTier("opus", 0.9, 3, 0.1);
    const t = await turn(hooks, $, "s6");
    assert.equal(t.sent.effort, "xhigh");
  });

  test("with stickiness off nothing is held, on Sonnet either", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_CEILING: "max",
    });
    setTier("sonnet", 0.9, 1, 0.9);
    await turn(hooks, $, "s7");
    setTier("sonnet", 0.9, 3, 0.1);
    assert.equal((await turn(hooks, $, "s8")).sent.effort, "xhigh");
  });

  test("the default ceiling caps a cleared Sonnet effort flip at medium", async () => {
    const { hooks, $, setTier } = await started({
      JEV_ROUTER_CEILING: "",
    });
    setTier("sonnet", 0.9, 1, 0.9);
    await turn(hooks, $, "s9");
    await run(hooks, $, "sticky 0.3");
    setTier("sonnet", 0.9, 3, 0.49);
    const t = await turn(hooks, $, "s10");
    assert.equal(t.sent.effort, "medium");
    assert.match(t.text, /capped from xhigh/);
  });
});

describe("register: a spawned subagent", () => {
  const spawnOf = (over: Record<string, unknown> = {}) => ({
    tool_use_id: "tu1",
    prompt: "List the files under hooks/ and report the count.",
    description: "Count hook files",
    subagentType: "Explore",
    parentModel: "claude-fable-5-1",
    fork: false,
    background: false,
    ...over,
  });

  /** Spawns, then runs one step of the subagent's loop under the id core gave it. */
  async function spawnAndStep(
    kit: ReturnType<typeof load>,
    input: Record<string, unknown>,
  ) {
    let passed: { model?: string } | null = null;
    const started = await kit.hooks.get("agent.spawn")!(
      kit.$,
      input,
      async (e: { model?: string }) => {
        passed = e;
        return { model: e.model ?? "claude-fable-5-1", agentId: "agent-1" };
      },
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      kit.hooks.get("turn.step")!(
        kit.$,
        { turnId: "sub-1", index: 0, agentId: "agent-1", model: "claude-fable-5-1", effort: "high" },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return { passed: passed as { model?: string } | null, started, sent, chunks };
  }

  test("is classified on its task and given the model Jev picks", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98, 1);
    const { passed, started, sent, lastStateWas } = {
      ...(await spawnAndStep(kit, spawnOf())),
      lastStateWas: kit.lastState(),
    };
    assert.equal(lastStateWas, "List the files under hooks/ and report the count.");
    assert.equal(passed?.model, "claude-haiku-4-5", "set on the spawn");
    assert.equal(started.agentId, "agent-1");
    assert.equal(sent.model, "claude-haiku-4-5", "and on its steps");
    assert.equal(sent.effort, "medium", "effort reaches the loop through its steps");
  });

  test("its steps carry no route line and no footer: they are a tool result", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98);
    const { chunks } = await spawnAndStep(kit, spawnOf());
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);
    assert.deepEqual(texts, ["reply"]);
  });

  test("/jev shows the spawn under the agent, routed", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98, 1);
    await spawnAndStep(kit, spawnOf());
    const out = await kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, {
      args: "",
    });
    assert.match(out.text, /haiku·medium  Jev 98%  \[Explore agent\] Count hook files/);
    assert.equal(
      out.text.split("\n").filter((l: string) => /\[Explore agent\]/.test(l)).length,
      1,
      "recorded at the spawn only; its steps join that row, not open another",
    );
  });

  test("a shaky pick leaves the spawn on its own model, and says so", async () => {
    const kit = load();
    kit.setTier("sonnet", 0.22);
    const { passed, sent } = await spawnAndStep(kit, spawnOf());
    assert.equal(passed?.model, undefined);
    assert.equal(sent.model, "claude-fable-5-1", "the step is left alone too");
    const out = await kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, {
      args: "",
    });
    assert.match(out.text, /not routed — .*Jev 22% on sonnet, needs 50%/);
  });

  test("a call that named a model is the caller’s decision", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98);
    const { passed } = await spawnAndStep(kit, spawnOf({ model: "opus" }));
    assert.equal(passed?.model, "opus");
    assert.equal(kit.fetches(), 0, "Jev is not even asked");
  });

  test("a fork inherits, so it is not asked about either", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98);
    const { passed } = await spawnAndStep(kit, spawnOf({ fork: true }));
    assert.equal(passed?.model, undefined);
    assert.equal(kit.fetches(), 0);
  });

  test("a spawn Jev cannot answer is left alone, and the reason kept", async () => {
    const kit = load();
    kit.fail();
    const { passed } = await spawnAndStep(kit, spawnOf());
    assert.equal(passed?.model, undefined);
    const out = await kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, {
      args: "",
    });
    assert.match(out.text, /not routed — .*500/);
  });

  test("the parent’s tier is not a hold: no cache to keep warm", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    // A main turn on fable, then a spawn Jev reads as haiku at 0.6: under the
    // 0.75 sticky bar, over the 0.5 subagent bar. Stickiness must not apply.
    kit.setTier("fable", 0.9);
    await kit.hooks.get("turn.start")!(kit.$, { text: "plan it", turnId: "m1" }, async (e: unknown) => e);
    kit.setTier("haiku", 0.6);
    const { passed } = await spawnAndStep(kit, spawnOf());
    assert.equal(passed?.model, "claude-haiku-4-5");
  });

  test("routing off leaves spawns alone", async () => {
    const kit = load();
    await kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, { args: "off" });
    kit.setTier("haiku", 0.98);
    const { passed } = await spawnAndStep(kit, spawnOf());
    assert.equal(passed?.model, undefined);
    assert.equal(kit.fetches(), 0);
  });

  test("routing off stops steps of a spawn made while on", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98, 1);
    await kit.hooks.get("agent.spawn")!(
      kit.$,
      spawnOf(),
      async (e: { model?: string }) => ({
        model: e.model ?? "claude-fable-5-1",
        agentId: "agent-1",
      }),
    );
    await kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, { args: "off" });
    let sent: { model?: string; effort?: string } = {};
    await collect(
      kit.hooks.get("turn.step")!(
        kit.$,
        {
          turnId: "sub-after-off",
          index: 0,
          agentId: "agent-1",
          model: "claude-fable-5-1",
          effort: "high",
        },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    assert.equal(sent.model, "claude-fable-5-1", "cached spawn decision is not applied");
    assert.equal(sent.effort, "high");
  });

  test("routing on again mid-agent keeps the spawn decision", async () => {
    const kit = load();
    kit.setTier("haiku", 0.98, 1);
    await kit.hooks.get("agent.spawn")!(
      kit.$,
      spawnOf(),
      async (e: { model?: string }) => ({
        model: e.model ?? "claude-fable-5-1",
        agentId: "agent-1",
      }),
    );
    const run = (args: string) =>
      kit.hooks.get('command.run:{"command":"jev"}')!(kit.$, { args });
    await run("off");
    await run("on");
    let sent: { model?: string; effort?: string } = {};
    await collect(
      kit.hooks.get("turn.step")!(
        kit.$,
        {
          turnId: "sub-after-on",
          index: 0,
          agentId: "agent-1",
          model: "claude-fable-5-1",
          effort: "high",
        },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    assert.equal(sent.model, "claude-haiku-4-5");
    assert.equal(sent.effort, "medium");
    const status = await run("");
    assert.doesNotMatch(status.text, /not routed at spawn/);
  });
});

describe("register: a downgrade priced against the context", () => {
  const started = async (over: Record<string, string | undefined> = {}) => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1", ...over });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(
    hooks: Map<string, Function>,
    $: unknown,
    id: string,
    text = "x",
  ) {
    await hooks.get("turn.start")!(
      $,
      { text, turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("at a working context a confident haiku pick stays on fable, and the line prices it", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "p1", "plan the migration");
    setContext(150_000);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "p2", "what is 2+2");
    assert.equal(t.sent.model, "claude-fable-5-1");
    assert.equal(t.sent.effort, "low", "Jev's effort still applies");
    assert.match(t.text, /kept fable: haiku costs \$\d+\.\d+ vs \$\d/);
  });

  test("at a small context the same pick goes through", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "q1", "plan the migration");
    setContext(500);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "q2", "what is 2+2");
    assert.equal(t.sent.model, "claude-haiku-4-5");
    assert.doesNotMatch(t.text, /held/);
  });

  test("without the engine's count, the last turn's own usage stands in", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(null);
    setTier("fable", 0.95, 3);
    // answeredBy carries 10k and produces 3k; from 10k a fable→haiku
    // downgrade does not pay (its break-even is ~6k), so a hold here proves
    // the fallback was read: with nothing known, nothing would be held.
    await turn(hooks, $, "r1", "plan the migration");
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "r2", "2+2");
    assert.equal(t.sent.model, "claude-fable-5-1");
    assert.match(t.text, /kept fable: haiku costs \$/);
  });

  test("haiku outgrown at 300k with Jev on fable over the upgrade limit moves up only as far as it must", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("haiku", 0.95, 0);
    await turn(hooks, $, "u1", "2+2");
    setContext(300_000);
    setTier("fable", 0.9, 3);
    const t = await turn(hooks, $, "u2", "plan it");
    assert.equal(t.sent.model, "claude-sonnet-5", "the cheapest tier that fits, not fable");
    assert.match(t.text, /haiku too long, moved up only to sonnet \(Jev wanted fable\)/);
    assert.doesNotMatch(t.text, /costs \$/, "no figures from a verdict that no longer applies");
  });

  test("/jev sticky off drops the confidence bar only; /jev price off drops the price checks", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "s1", "plan");
    await run(hooks, $, "sticky off");
    setContext(150_000);
    setTier("haiku", 0.99, 0);
    const held = await turn(hooks, $, "s2", "2+2");
    assert.equal(held.sent.model, "claude-fable-5-1", "the price check still holds");
    assert.match(held.text, /kept fable: haiku costs/);
    assert.match((await run(hooks, $, "price off")).text, /^price checks off/);
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "s3", "2+2 again")).sent.model, "claude-haiku-4-5");
    assert.match((await run(hooks, $, "")).text, /price\s+off \(\/jev price on\)/);
  });

  test("JEV_ROUTER_PRICE_CHECK=0 seeds the price checks off, and /jev price is kept across a reload", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-PRICE" };
    const first = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_PRICE_CHECK: "0" }, shared);
    await first.hooks.get("session.start")!(first.$, {}, async (e: unknown) => e);
    assert.match((await run(first.hooks, first.$, "")).text, /price\s+off/);
    await run(first.hooks, first.$, "price on");
    const again = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_PRICE_CHECK: "0" }, shared);
    await again.hooks.get("session.start")!(again.$, {}, async (e: unknown) => e);
    assert.match((await run(again.hooks, again.$, "")).text, /price\s+on/);
  });

  test("the five-minute cache is read from the environment and moves the bar", async () => {
    const at = async (ttl: string | undefined, context: number) => {
      const { hooks, $, setTier, setContext } = await started({ JEV_ROUTER_CACHE_TTL: ttl });
      setTier("fable", 0.95, 3);
      await turn(hooks, $, "t1", "plan");
      setContext(context);
      setTier("haiku", 0.99, 0);
      return (await turn(hooks, $, "t2", "2+2")).sent.model;
    };
    // The output is taken as the last turn's or 1.5k, whichever is smaller, so
    // 1.5k at 4k context: pays on the five-minute cache (break-even ~5k), not on the hour's (~3k).
    assert.equal(await at("5m", 4_000), "claude-haiku-4-5");
    assert.equal(await at(undefined, 4_000), "claude-fable-5-1");
  });

  test("/jev shows the context and the break-even, and the session's dollars", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "v1", "plan");
    setContext(200_000);
    const status = await run(hooks, $, "");
    assert.match(status.text, /cache\s+1h writes · 200k context · fable→haiku pays below \d+k/);
    assert.match(status.text, /spent\s+\$0\.\d+ this session/);
    assert.match(status.text, /fable-5-1 ✓ · \$0\.\d+ · 10k in \(90% cached\) · 3k out/);
  });

  test("a compaction forgets what was running, so the next turn starts from Jev", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "w1", "plan");
    setContext(200_000);
    await hooks.get("session.compact")!($, { trigger: "auto" }, async (e: unknown) => e);
    setContext(null);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "w2", "2+2");
    assert.equal(t.sent.model, "claude-haiku-4-5", "nothing to hold to");
    assert.doesNotMatch(t.text, /held/);
  });

  test("a precompute compaction changes nothing", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "x1", "plan");
    setContext(150_000);
    await hooks.get("session.compact")!($, { trigger: "precompute" }, async (e: unknown) => e);
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "x2", "2+2")).sent.model, "claude-fable-5-1");
  });
});

describe("register: the ceiling subcommand", () => {
  const started = async (over: Record<string, string | undefined> = {}) => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", ...over });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "plan the architecture", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks.filter((c) => c.kind === "text").map((c) => c.text).join(""),
    };
  }

  test("the default caps Jev's xhigh at medium and says so", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9, 3);
    const t = await turn(hooks, $, "c0");
    assert.equal(t.sent.effort, "medium");
    assert.match(t.text, /capped from xhigh/);
    assert.match((await run(hooks, $, "")).text, /ceiling\s+medium for all/);
  });

  test("/jev ceiling xhigh lets xhigh through on every tier", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9, 3);
    await run(hooks, $, "ceiling xhigh");
    const t = await turn(hooks, $, "c1");
    assert.equal(t.sent.effort, "xhigh");
    assert.doesNotMatch(t.text, /capped/);
  });

  test("/jev ceiling xhigh fable raises one tier and leaves the rest", async () => {
    const { hooks, $, setTier } = await started();
    await run(hooks, $, "ceiling xhigh fable");
    setTier("fable", 0.9, 3);
    assert.equal((await turn(hooks, $, "c2")).sent.effort, "xhigh");
    setTier("opus", 0.9, 3);
    assert.equal((await turn(hooks, $, "c3")).sent.effort, "medium");
    assert.match((await run(hooks, $, "")).text, /ceiling\s+medium \(fable: xhigh\)/);
  });

  test("the environment seeds it, and the command overrides", async () => {
    const { hooks, $, setTier } = await started({ JEV_ROUTER_CEILING: "high" });
    setTier("fable", 0.9, 4);
    assert.equal((await turn(hooks, $, "c4")).sent.effort, "high");
    await run(hooks, $, "ceiling off");
    assert.equal((await turn(hooks, $, "c5")).sent.effort, "max");
  });

  test("a score past max is max, never a rung the engine lacks", async () => {
    const { hooks, $, setTier } = await started({ JEV_ROUTER_CEILING: "off" });
    setTier("fable", 0.9, 5);
    assert.equal((await turn(hooks, $, "c6")).sent.effort, "max");
  });

  test("an effort on its own is the ceiling's shorthand", async () => {
    const { hooks, $, setTier } = await started();
    assert.match((await run(hooks, $, "xhigh fable")).text, /medium \(fable: xhigh\)/);
    setTier("fable", 0.9, 3);
    assert.equal((await turn(hooks, $, "sh1")).sent.effort, "xhigh");
    assert.match((await run(hooks, $, "medium")).text, /medium for all/);
  });

  test("a removed toggle is named and pointed at the ceiling, and changes nothing", async () => {
    const { hooks, $ } = await started();
    const r = await run(hooks, $, "xhigh on");
    assert.match(r.text, /old effort toggles/);
    assert.match(r.text, /\/jev ceiling xhigh/);
    assert.match((await run(hooks, $, "")).text, /ceiling\s+medium for all/);
  });

  test("an unknown argument says so instead of printing the status", async () => {
    const { hooks, $ } = await started();
    const r = await run(hooks, $, "frobnicate");
    assert.match(r.text, /"\/jev frobnicate" is not a command/);
    assert.doesNotMatch(r.text, /routing\s+on/);
  });

  test("an unreadable effort changes nothing and says so", async () => {
    const { hooks, $ } = await started();
    const r = await run(hooks, $, "ceiling ultra");
    assert.match(r.text, /not an effort/);
    assert.match((await run(hooks, $, "")).text, /ceiling\s+medium for all/);
  });
});

describe("register: a conversation's first request", () => {
  const started = async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  async function turn(
    hooks: Map<string, Function>,
    $: unknown,
    id: string,
    text = "plan the architecture",
  ) {
    await hooks.get("turn.start")!(
      $,
      { text, turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        },
      ),
    );
    return {
      sent,
      text: chunks.filter((c) => c.kind === "text").map((c) => c.text).join(""),
    };
  }

  test("fable at medium is sent as high before the engine has a response, and the line says so", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(null);
    setTier("fable", 0.9, 1);
    const first = await turn(hooks, $, "f1");
    assert.equal(first.sent.effort, "high");
    assert.match(first.text, /fable · high · Jev 90% · 1st request runs medium as high · \d+ms/);
    const status = await hooks.get('command.run:{"command":"jev"}')!($, { args: "" });
    assert.match(status.text, /fable·high  Jev 90%; 1st request runs medium as high/);
  });

  test("the turn after starts from the medium Jev asked for", async () => {
    const { hooks, $, setTier, setContext, fetches } = await started();
    setContext(null);
    setTier("fable", 0.9, 1);
    await turn(hooks, $, "f2");
    setContext(50_000);
    const asked = fetches();
    const second = await turn(hooks, $, "f3", "go ahead");
    assert.equal(second.sent.effort, "medium", "the continuation carries Jev's ask");
    assert.equal(fetches(), asked);
    setTier("fable", 0.9, 1);
    assert.equal((await turn(hooks, $, "f3b")).sent.effort, "medium");
  });

  test("a resumed session reports its context, so its first routed turn is not a first request", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(20_000);
    setTier("fable", 0.9, 1);
    const t = await turn(hooks, $, "f4");
    assert.equal(t.sent.effort, "medium");
    assert.match(t.text, /fable · medium/);
  });

  test("a compaction does not make the next request a first one (measured: medium runs as medium there)", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(50_000);
    setTier("fable", 0.9, 1);
    assert.equal((await turn(hooks, $, "f5")).sent.effort, "medium");
    await hooks.get("session.compact")!($, { trigger: "auto" }, async (e: unknown) => e);
    setContext(null);
    assert.equal((await turn(hooks, $, "f6")).sent.effort, "medium");
  });

  test("/clear starts a conversation whose first request is a first one again", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(50_000);
    setTier("fable", 0.9, 1);
    assert.equal((await turn(hooks, $, "f7")).sent.effort, "medium");
    await hooks.get("classic.SessionStart")!($, { source: "clear" }, async (e: unknown) => e);
    setContext(null);
    assert.equal((await turn(hooks, $, "f8")).sent.effort, "high");
  });

  test("the first-request fact survives a reload", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-FIRST" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "0" };
    const before = load(env, shared);
    await before.hooks.get("session.start")!(before.$, {}, async (e: unknown) => e);
    before.setContext(null);
    before.setTier("fable", 0.9, 1);
    assert.equal((await turn(before.hooks, before.$, "r1", "plan it")).sent.effort, "high");
    const after = load(env, shared);
    await after.hooks.get("session.start")!(after.$, {}, async (e: unknown) => e);
    after.setContext(null);
    after.setTier("fable", 0.9, 1);
    assert.equal((await turn(after.hooks, after.$, "r2", "and more")).sent.effort, "medium");
  });

  test("a fable subagent's first step is sent as high, its later steps as asked", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9, 1);
    const spawn = await hooks.get("agent.spawn")!(
      $,
      { prompt: "plan it", description: "plan it", subagentType: "Plan", fork: false },
      async (e: { model?: string }) => ({ model: e.model ?? "inherit", agentId: "agent-1" }),
    );
    assert.equal(spawn.model, "claude-fable-5-1");
    const step = async (id: string) => {
      let sent: { effort?: string } = {};
      await collect(
        hooks.get("turn.step")!(
          $,
          { turnId: id, index: 0, agentId: "agent-1" },
          (e: { model: string; effort: string }) => {
            sent = e;
            return answeredBy(e.model);
          },
        ),
      );
      return sent.effort;
    };
    assert.equal(await step("a1"), "high");
    assert.equal(await step("a2"), "medium");
  });
});

describe("register: one summary per reply", () => {
  const started = async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const notice =
    '<task-notification><task-id>abc</task-id><summary>Agent "reviewer" completed</summary></task-notification>';

  async function turn(
    hooks: Map<string, Function>,
    $: unknown,
    id: string,
    text: string,
    stopReason = "end_turn",
  ) {
    await hooks.get("turn.start")!($, { text, turnId: id }, async (e: unknown) => e);
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: id, index: 0 }, (e: { model: string }) =>
        answeredBy(e.model, stopReason),
      ),
    );
    return chunks.filter((c) => c.kind === "text").map((c) => c.text).join("");
  }

  /** The main loop spawning a background agent the engine lists as agent-1. */
  const spawn = (hooks: Map<string, Function>, $: unknown, over: Record<string, unknown> = {}) =>
    hooks.get("agent.spawn")!(
      $,
      { prompt: "review it", description: "review it", subagentType: "general-purpose", fork: false, background: true, ...over },
      async (e: { model?: string }) => ({ model: e.model ?? "inherit", agentId: "agent-1" }),
    );

  test("a reply that spawned background work gets its summary when the work is done, once", async () => {
    const { hooks, $, setAgentStatus } = await started();
    setAgentStatus("running");
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "r1" }, async (e: unknown) => e);
    await spawn(hooks, $);
    const first = (
      await collect(
        hooks.get("turn.step")!($, { turnId: "r1", index: 0 }, (e: { model: string }) => answeredBy(e.model)),
      )
    ).filter((c) => c.kind === "text").map((c) => c.text).join("");
    assert.doesNotMatch(first, /% cached\)/, "its agent is still running, so the reply is not over");
    setAgentStatus("completed");
    const woken = await turn(hooks, $, "r2", notice);
    assert.match(woken, /2 turns: opus, opus \(1 woken by tasks\)/);
    assert.match(woken, /agents: general-purpose opus/);
    assert.match(woken, /\$/);
    assert.equal(woken.match(/% cached\)/g)?.length, 1);
    // The summary was written; the next typed prompt starts a new reply.
    const next = await turn(hooks, $, "r3", "and now this");
    assert.match(next, /opus-5-5 ✓/);
    assert.doesNotMatch(next, /2 turns/);
  });

  test("an agent from an earlier reply does not hold a later reply's summary", async () => {
    const { hooks, $, setAgentStatus } = await started();
    setAgentStatus("running");
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "e1" }, async (e: unknown) => e);
    await spawn(hooks, $);
    await collect(hooks.get("turn.step")!($, { turnId: "e1", index: 0 }, (e: { model: string }) => answeredBy(e.model)));
    // Still running, and the person moves on.
    const later = await turn(hooks, $, "e2", "unrelated quick question");
    assert.match(later, /opus-5-5 ✓/);
  });

  test("a spawn the router leaves alone still belongs to the reply", async () => {
    const { hooks, $, setAgentStatus } = await started();
    setAgentStatus("running");
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "f1" }, async (e: unknown) => e);
    await spawn(hooks, $, { model: "haiku" });
    const first = (
      await collect(
        hooks.get("turn.step")!($, { turnId: "f1", index: 0 }, (e: { model: string }) => answeredBy(e.model)),
      )
    ).filter((c) => c.kind === "text").map((c) => c.text).join("");
    assert.doesNotMatch(first, /% cached\)/);
  });

  test("a compaction mid-turn is not the end of the reply", async () => {
    const { hooks, $ } = await started();
    const mid = await turn(hooks, $, "c1", "long task", "compaction");
    assert.doesNotMatch(mid, /% cached\)/);
  });

  test("the engine's nudge continues the last decision without asking Jev, and writes nothing", async () => {
    const { hooks, $, setTier, fetches } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "n1", "plan the migration");
    const asked = fetches();
    setTier("haiku", 1, 0);
    let sent: { model?: string; effort?: string } = {};
    await hooks.get("turn.start")!(
      $,
      {
        text: "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.",
        turnId: "n2",
      },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "n2", index: 0 }, (e: { model: string; effort: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    assert.equal(fetches(), asked, "Jev is not asked about the nudge");
    assert.equal(sent.model, "claude-fable-5-1", "continues on the last decision");
    assert.equal(sent.effort, "medium");
    assert.equal(
      chunks.filter((c) => c.kind === "text").map((c) => c.text).join(""),
      "reply",
      "no line, no summary: the engine prodded, the person did not ask",
    );
    const status = await hooks.get('command.run:{"command":"jev"}')!($, { args: "" });
    assert.match(status.text, /\[continuing\]/);
  });

  test("a nudge with nothing to continue leaves the session model alone, and Jev unasked", async () => {
    const { hooks, $, fetches } = await started();
    const nudged = await turn(hooks, $, "n3", "The user hasn't heard from you in a while — say what you're doing.");
    assert.equal(fetches(), 0);
    assert.equal(nudged, "reply");
  });

  test("a nudge inside a reply that is still open is counted in its summary", async () => {
    const { hooks, $, setTier, setAgentStatus } = await started();
    setAgentStatus("running");
    setTier("fable", 0.9, 3);
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "o1" }, async (e: unknown) => e);
    await spawn(hooks, $);
    await collect(hooks.get("turn.step")!($, { turnId: "o1", index: 0 }, (e: { model: string }) => answeredBy(e.model)));
    await turn(hooks, $, "o2", "The user hasn't heard from you in a while — say what you're doing, then continue.");
    setAgentStatus("completed");
    const woken = await turn(hooks, $, "o3", notice);
    assert.match(woken, /3 turns: fable, fable, fable \(1 woken by tasks, 1 nudged\)/);
  });
});

describe("register: a session that was already running", () => {
  const started = async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string, text = "implement it") {
    await hooks.get("turn.start")!($, { text, turnId: id }, async (e: unknown) => e);
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: id, index: 0 }, (e: { model: string; effort: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    return { sent, text: chunks.filter((c) => c.kind === "text").map((c) => c.text).join("") };
  }

  test("a resumed session's first routed turn is priced against the session model's warm cache", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(150_000);
    await hooks.get("classic.SessionStart")!(
      $,
      { source: "resume", model: "claude-opus-5", context_tokens: 150_000, prompt_cache_likely_expired: false },
      async (e: unknown) => e,
    );
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "s1", "what is 2+2");
    assert.equal(t.sent.model, "claude-opus-5", "stays on the model with the warm cache");
    assert.match(t.text, /kept opus: haiku costs \$/);
  });

  test("the same rung on the ladder's own model is a switch too, and priced", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(200_000);
    await hooks.get("classic.SessionStart")!(
      $,
      { source: "resume", model: "claude-opus-5", context_tokens: 200_000, prompt_cache_likely_expired: false },
      async (e: unknown) => e,
    );
    setTier("opus", 0.99, 1);
    const t = await turn(hooks, $, "s2");
    assert.equal(t.sent.model, "claude-opus-5");
    assert.match(t.text, /kept claude-opus-5: claude-opus-5-5 costs \$/);
    assert.match((await run(hooks, $, "")).text, /session\s+claude-opus-5-5, running on opus/);
  });

  test("an expired cache on resume is nothing to protect", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(200_000);
    await hooks.get("classic.SessionStart")!(
      $,
      { source: "resume", model: "claude-opus-5", context_tokens: 200_000, prompt_cache_likely_expired: true },
      async (e: unknown) => e,
    );
    setTier("haiku", 0.99, 0);
    // The session is still running on what the event names, with its cache
    // cold: staying is priced as a write too. At 200k haiku does not fit
    // anyway, so the turn stays on what is running.
    const t = await turn(hooks, $, "s3", "what is 2+2");
    assert.equal(t.sent.model, "claude-opus-5");
    assert.match(t.text, /kept opus: too long for haiku \(200k\)/);
  });

  test("/jev on after a stretch off prices the first routed turn against the session model", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    kit.setSessionModel("claude-opus-5");
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    const { hooks, $, setTier, setContext } = kit;
    await run(hooks, $, "off");
    setContext(150_000);
    await run(hooks, $, "on");
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "s4", "what is 2+2");
    assert.equal(t.sent.model, "claude-opus-5");
    assert.match(t.text, /kept opus: haiku costs/);
  });

  test("/model mid-session moves what the next routed turn is priced against", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "m1", "plan it");
    await hooks.get("classic.PostModelSwitch")!(
      $,
      { from_model: "claude-opus-5-5", to_model: "claude-sonnet-5", source: "user" },
      async (e: unknown) => e,
    );
    setContext(150_000);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "m2", "what is 2+2");
    assert.equal(t.sent.model, "claude-sonnet-5", "the new session model's cache is what is warm");
    assert.match((await run(hooks, $, "")).text, /session\s+claude-sonnet-5, still on it/);
  });

  test("/clear forgets what was running", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "s5", "plan it");
    await hooks.get("classic.SessionStart")!($, { source: "clear" }, async (e: unknown) => e);
    setContext(null);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "s6", "2+2");
    assert.equal(t.sent.model, "claude-haiku-4-5", "nothing to hold to");
  });

  test("a 300k turn is never sent to haiku, even with sticky off and a named tier", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "w1", "plan it");
    await run(hooks, $, "sticky off");
    setContext(300_000);
    setTier("haiku", 1, 0);
    const t = await turn(hooks, $, "w2", "what is 2+2");
    assert.equal(t.sent.model, "claude-fable-5-1");
    assert.match(t.text, /kept fable: too long for haiku \(300k\)/);
    const forced = await turn(hooks, $, "w3", "use haiku for this");
    assert.equal(forced.sent.model, "claude-fable-5-1");
  });

  test("a [1m] session model is the ladder's model, spelled the engine's way", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" });
    kit.setSessionModel("claude-opus-5-5[1m]");
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    const { hooks, $, setTier, setContext } = kit;
    setContext(200_000);
    setTier("opus", 0.95, 1);
    const t = await turn(hooks, $, "m3");
    assert.equal(t.sent.model, "claude-opus-5-5[1m]", "nothing changes under the loop");
    assert.doesNotMatch(t.text, /kept/);
  });

  test("what the session spends is counted while routing is off", async () => {
    const { hooks, $ } = await started();
    await run(hooks, $, "off");
    await collect(
      hooks.get("turn.step")!($, { turnId: "s7", index: 0 }, () => answeredBy("claude-opus-5-5")),
    );
    await run(hooks, $, "on");
    assert.match((await run(hooks, $, "")).text, /spent\s+\$0\.\d+ this session/);
  });
});

describe("register: a reload of the module", () => {
  const boot = async (shared: { store: Map<string, unknown>; id: string }) => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string, text = "plan it") {
    await hooks.get("turn.start")!($, { text, turnId: id }, async (e: unknown) => e);
    let sent: { model?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: id, index: 0 }, (e: { model: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    return { sent, text: chunks.filter((c) => c.kind === "text").map((c) => c.text).join("") };
  }

  test("history, spend and the held tier survive a reload", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-A" };
    const before = await boot(shared);
    before.setTier("fable", 0.95, 3);
    await turn(before.hooks, before.$, "a1");
    const spentBefore = (await run(before.hooks, before.$, "")).text.match(/spent\s+(\$[\d.]+)/)?.[1];
    assert.ok(spentBefore);

    // The module is reloaded: a new register, the same store and session.
    // session.start does not fire again on a reload, so the next hook restores.
    await new Promise((r) => setTimeout(r, 5));
    const after = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    const status = (await run(after.hooks, after.$, "")).text;
    assert.match(status, /fable·medium .* plan it/, "the history is back");
    assert.match(status, new RegExp(`spent\\s+\\${spentBefore}`), "and the spend");
    after.setContext(150_000);
    after.setTier("haiku", 0.99, 0);
    const t = await turn(after.hooks, after.$, "a2", "what is 2+2");
    assert.equal(t.sent.model, "claude-fable-5-1", "held to the tier that is warm, not reset");
    assert.match(t.text, /kept fable: haiku costs/);
  });

  test("/jev sticky and /jev ceiling survive a reload", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-B" };
    const before = await boot(shared);
    await run(before.hooks, before.$, "sticky 0.6");
    await run(before.hooks, before.$, "ceiling xhigh fable");
    await run(before.hooks, before.$, "quiet");
    await new Promise((r) => setTimeout(r, 5));
    const after = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    const status = (await run(after.hooks, after.$, "")).text;
    assert.match(status, /switch needs 60%/);
    assert.match(status, /ceiling\s+medium \(fable: xhigh\)/);
    assert.match(status, /announce\s+off/);
  });

  test("another session's snapshot is not restored", async () => {
    const store = new Map<string, unknown>();
    const before = await boot({ store, id: "sess-C" });
    before.setTier("fable", 0.95, 3);
    await turn(before.hooks, before.$, "c1");
    const other = await boot({ store, id: "sess-D" });
    assert.match((await run(other.hooks, other.$, "")).text, /No turns yet/);
  });

  test("a snapshot that is not one of ours is ignored, and the router starts over", async () => {
    const store = new Map<string, unknown>([["session:sess-E", { v: 999, junk: true }]]);
    const kit = await boot({ store, id: "sess-E" });
    assert.match((await run(kit.hooks, kit.$, "")).text, /No turns yet/);
    kit.setTier("opus", 0.9, 1);
    assert.equal((await turn(kit.hooks, kit.$, "e1")).sent.model, "claude-opus-5-5");
  });

  test("a store that refuses to save does not cost the turn", async () => {
    const store = new Map<string, unknown>();
    const kit = await boot({ store, id: "sess-F" });
    (kit.$ as { store: { set: unknown } }).store.set = async () => {
      throw new Error("store over 4 MiB");
    };
    kit.setTier("opus", 0.9, 1);
    assert.equal((await turn(kit.hooks, kit.$, "f1")).sent.model, "claude-opus-5-5");
  });

  test("a reload in the middle of a turn keeps the rest of that turn routed, with one line", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-M" };
    const before = await boot(shared);
    before.setTier("fable", 0.95, 3);
    await before.hooks.get("turn.start")!(before.$, { text: "plan it", turnId: "m1" }, async (e: unknown) => e);
    const first = await collect(
      before.hooks.get("turn.step")!(before.$, { turnId: "m1", index: 0 }, (e: { model: string }) =>
        answeredBy(e.model, "tool_use"),
      ),
    );
    assert.match(first.filter((c) => c.kind === "text").map((c) => c.text).join(""), /✳️/);

    await new Promise((r) => setTimeout(r, 5));
    const after = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    let sent: { model?: string; effort?: string } = {};
    const rest = await collect(
      after.hooks.get("turn.step")!(after.$, { turnId: "m1", index: 1 }, (e: { model: string; effort: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    const out = rest.filter((c) => c.kind === "text").map((c) => c.text).join("");
    assert.equal(sent.model, "claude-fable-5-1", "still routed after the reload");
    assert.doesNotMatch(out, /✳️/, "the route line is not written a second time");
    assert.match(out, /fable-5-1 ✓/, "and the reply is summarised");
  });

  test("a reload mid-agent does not treat the agent's next request as its first", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-N" };
    const before = await boot(shared);
    before.setTier("fable", 0.9, 1);
    await before.hooks.get("agent.spawn")!(
      before.$,
      { prompt: "plan it", description: "plan it", subagentType: "Plan", fork: false },
      async (e: { model?: string }) => ({ model: e.model ?? "inherit", agentId: "agent-1" }),
    );
    const step = async (kit: typeof before, id: string) => {
      let sent: { effort?: string } = {};
      await collect(
        kit.hooks.get("turn.step")!(kit.$, { turnId: id, index: 0, agentId: "agent-1" }, (e: { model: string; effort: string }) => {
          sent = e;
          return answeredBy(e.model);
        }),
      );
      return sent.effort;
    };
    assert.equal(await step(before, "x1"), "high", "first request: medium runs as high");
    await new Promise((r) => setTimeout(r, 5));
    const after = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    assert.equal(await step(after, "x2"), "medium", "after the reload, Jev's ask");
  });

  test("only the last twenty sessions are kept", async () => {
    const store = new Map<string, unknown>();
    for (let i = 0; i < 25; i++) store.set(`session:old-${i}`, { v: 1 });
    store.set("unrelated", 1);
    const kit = await boot({ store, id: "sess-G" });
    kit.setTier("opus", 0.9, 1);
    await turn(kit.hooks, kit.$, "g1");
    const sessions = [...store.keys()].filter((k) => k.startsWith("session:"));
    assert.equal(sessions.length, 20);
    assert.ok(store.has("session:sess-G"));
    assert.ok(store.has("session:old-24"), "the newest old ones stay");
    assert.ok(!store.has("session:old-0"), "the oldest go");
    assert.ok(store.has("unrelated"), "keys that are not snapshots are left alone");
  });
});

describe("register: audit regressions (2026-09-23)", () => {
  const boot = async (
    env: Record<string, string | undefined> = {},
    shared = { store: new Map<string, unknown>(), id: "sess-R" },
  ) => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1", ...env }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return { ...kit, shared };
  };
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });
  const text = (chunks: { kind: string; text?: string }[]) =>
    chunks.filter((c) => c.kind === "text").map((c) => c.text).join("");

  async function turn(hooks: Map<string, Function>, $: unknown, id: string, prompt = "plan it") {
    await hooks.get("turn.start")!($, { text: prompt, turnId: id }, async (e: unknown) => e);
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: id, index: 0 }, (e: { model: string; effort: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    return { sent, text: text(chunks) };
  }

  test("a hold never keeps a turn on a tier it no longer fits", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "w1", "2+2")).sent.model, "claude-haiku-4-5");
    setContext(190_000);
    setTier("opus", 0.6, 2);
    const t = await turn(hooks, $, "w2", "now implement it");
    assert.equal(t.sent.model, "claude-sonnet-5", "haiku takes 200k; the doubt about opus still stands, so only one step up");
    assert.match(t.text, /haiku too long, moved up only to sonnet/);
  });

  test("haiku outgrown with Jev still on haiku steps up instead of running unrouted", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    await turn(hooks, $, "hh1", "2+2");
    setContext(190_000);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "hh2", "3+3");
    assert.equal(t.sent.model, "claude-sonnet-5");
    assert.match(t.text, /haiku too long, moved up only to sonnet/);
  });

  test("a go-ahead that outgrows haiku never steps into an excluded tier", async () => {
    const { hooks, $, setTier, setContext } = await boot({ JEV_ROUTER_EXCLUDE: "sonnet" });
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    await turn(hooks, $, "ex1", "2+2");
    setContext(190_000);
    const t = await turn(hooks, $, "ex2", "yes");
    assert.equal(t.sent.model, "claude-opus-5-5", "sonnet is excluded, so the next offered tier");
  });

  test("the step-up line names Jev's pick only when it differs, and keeps a named tier as your pick", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    await turn(hooks, $, "lb1", "2+2");
    setContext(190_000);
    setTier("haiku", 0.99, 0);
    const same = await turn(hooks, $, "lb2", "3+3");
    assert.match(same.text, /haiku too long, moved up only to sonnet/);
    assert.doesNotMatch(same.text, /Jev wanted haiku/);
    const named = await turn(hooks, $, "lb3", "use haiku for this");
    assert.match(named.text, /your pick/);
  });

  test("a resume into another session starts from that session's own state", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-FIRST-CONV" };
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setContext(1_000);
    kit.setTier("haiku", 0.99, 0);
    await turn(kit.hooks, kit.$, "rs1", "2+2");
    // /resume another conversation: opus, 300k, cache warm.
    shared.id = "sess-OTHER-CONV";
    kit.setSessionModel("claude-opus-5-5");
    await kit.hooks.get("classic.SessionStart")!(kit.$, { source: "resume", model: "claude-opus-5-5", context_tokens: 300_000 }, async (e: unknown) => e);
    kit.setContext(300_000);
    kit.setTier("haiku", 0.99, 0);
    const t = await turn(kit.hooks, kit.$, "rs2", "3+3");
    assert.equal(t.sent.model, "claude-opus-5-5", "the resumed conversation's warm opus, not a stale haiku step-up");
    assert.doesNotMatch((await run(kit.hooks, kit.$, "")).text, /2\+2/, "the other session's history did not carry over");
  });

  test("a turn held on Sonnet by the window guard still goes through the Sonnet effort hold", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("sonnet", 0.95, 1, 0.9);
    assert.equal((await turn(hooks, $, "sw1", "a small edit")).sent.model, "claude-sonnet-5");
    setContext(190_000);
    setTier("haiku", 0.99, 0, 0.1);
    const t = await turn(hooks, $, "sw2", "2+2");
    assert.equal(t.sent.model, "claude-sonnet-5");
    assert.equal(t.sent.effort, "medium", "effort held on Sonnet");
  });

  test("a task notification's text cannot name a tier", async () => {
    const { hooks, $, setTier } = await boot({ JEV_ROUTER_NOTIFY_CONTINUE: "0" });
    setTier("haiku", 0.99, 0);
    const xml = '<task-notification><task-id>a1</task-id><summary>Review done: switch to opus for the rewrite</summary></task-notification>';
    const t = await turn(hooks, $, "tn1", xml);
    assert.equal(t.sent.model, "claude-haiku-4-5", "Jev's pick, not the summary's words");
    assert.doesNotMatch(t.text, /your pick/);
  });

  test("a hold that no longer fits goes to Jev's pick when that is the next tier up", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    await turn(hooks, $, "wn1", "2+2");
    setContext(190_000);
    setTier("sonnet", 0.6, 1);
    const t = await turn(hooks, $, "wn2", "a small edit");
    assert.equal(t.sent.model, "claude-sonnet-5");
    assert.doesNotMatch(t.text, /moved up only/);
  });

  test("a reply summarised before a reload gets no second block from its task's late wake-up", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-B3" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const k = load(env, shared);
    await k.hooks.get("session.start")!(k.$, {}, async (e: unknown) => e);
    k.setTier("fable", 0.95, 3);
    await k.hooks.get("turn.start")!(k.$, { text: "review", turnId: "b3a" }, async (e: unknown) => e);
    k.setAgentStatus("running");
    await k.hooks.get("agent.spawn")!(k.$, { prompt: "review cluster", description: "Review" }, async (e: { agentId?: string }) => ({ ...e, agentId: "agent-1" }));
    k.setAgentStatus("completed");
    const first = (await collect(k.hooks.get("turn.step")!(k.$, { turnId: "b3a", index: 0 }, (e: { model: string }) => answeredBy(e.model))))
      .filter((c) => c.kind === "text").map((c) => c.text).join("");
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    const k2 = load(env, shared);
    await k2.hooks.get("session.start")!(k2.$, {}, async (e: unknown) => e);
    k2.setTier("fable", 0.95, 3);
    const xml = '<task-notification><task-id>agent-1</task-id><summary>Agent "Review" completed</summary></task-notification>';
    const woke = await turn(k2.hooks, k2.$, "b3b", xml);
    assert.equal((first + woke.text).match(/% cached\)/g)?.length, 1);
  });

  test("the session in use is the last evicted, not the first created", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-OLDEST" };
    for (let i = 0; i < 25; i++) shared.store.set(`session:filler-${i}`, { v: 1 });
    shared.store.delete("session:filler-0");
    shared.store.set("session:sess-OLDEST", { v: 1 });
    for (let i = 0; i < 25; i++) shared.store.set(`session:filler-${i}`, { v: 1 });
    const k = load({ AI_GATEWAY_API_KEY: "gw-key" }, { store: new Map([["session:sess-OLDEST", { v: 1 }], ...[...shared.store.entries()].filter(([key]) => key !== "session:sess-OLDEST")]), id: "sess-OLDEST" });
    await k.hooks.get("session.start")!(k.$, {}, async (e: unknown) => e);
    k.setTier("opus", 0.95, 1);
    await turn(k.hooks, k.$, "ev1", "implement it");
    const keys = [...(await k.$.store.keys())].filter((key) => key.startsWith("session:"));
    assert.equal(keys.at(-1), "session:sess-OLDEST", "moved to the end on its first save");
    assert.ok(keys.includes("session:sess-OLDEST"), "not evicted");
  });

  test("a turn claim another process overwrote between the read and the write is ceded", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-RACE" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    const set = kit.$.store.set;
    kit.$.store.set = async (k: string, v: unknown) => {
      await set(k, v);
      // Another process, loaded later, claims the same turn right after.
      if (k.startsWith("turn:")) await set(k, { birth: Date.now() + 1e6, at: Date.now() });
    };
    kit.setTier("opus", 0.95, 1);
    const t = await turn(kit.hooks, kit.$, "race1", "implement it");
    assert.equal(t.sent.model, undefined, "left to the other process");
    assert.doesNotMatch(t.text, /✳️/);
  });

  test("a snapshot that cannot be rewritten is put back, not lost", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-KEEP" };
    const first = load({ AI_GATEWAY_API_KEY: "gw-key" }, shared);
    await first.hooks.get("session.start")!(first.$, {}, async (e: unknown) => e);
    first.setTier("opus", 0.95, 1);
    await turn(first.hooks, first.$, "k1", "implement the parser");
    const saved = JSON.stringify(shared.store.get("session:sess-KEEP"));
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    const again = load({ AI_GATEWAY_API_KEY: "gw-key" }, shared);
    const set = again.$.store.set;
    // The grown snapshot no longer fits; the old one still does.
    again.$.store.set = async (k: string, v: unknown) => {
      if (k === "session:sess-KEEP" && JSON.stringify(v).includes("and the tests"))
        throw new Error("over the size cap");
      return set(k, v);
    };
    await again.hooks.get("session.start")!(again.$, {}, async (e: unknown) => e);
    again.setTier("opus", 0.95, 1);
    await turn(again.hooks, again.$, "k2", "and the tests");
    assert.ok(shared.store.has("session:sess-KEEP"), "still there");
    assert.match(JSON.stringify(shared.store.get("session:sess-KEEP")), /implement the parser/);
    void saved;
  });

  test("an unknown /jev argument lists price and compact among the commands", async () => {
    const { hooks, $ } = await boot();
    const text = (await run(hooks, $, "prices")).text;
    assert.match(text, /price \[on\|off\]/);
    assert.match(text, /compact \[on\|off\]/);
  });

  test("the /jev compact reply carries no second prefix", async () => {
    const { hooks, $ } = await boot();
    assert.match((await run(hooks, $, "compact")).text, /^compaction by Jev on/);
  });

  test("a go-ahead does not continue onto a tier the turn no longer fits", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(1_000);
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "g1", "2+2")).sent.model, "claude-haiku-4-5");
    setContext(190_000);
    const t = await turn(hooks, $, "g2", "yes");
    assert.equal(t.sent.model, "claude-sonnet-5", "the cheapest tier that fits, not an unrouted turn");
    assert.match(t.text, /haiku too long, moved up only to sonnet/);
  });

  test("a compaction in the middle of a turn keeps that turn routed and summarised", async () => {
    const { hooks, $, setTier } = await boot();
    setTier("fable", 0.95, 3);
    await hooks.get("turn.start")!($, { text: "plan it", turnId: "c1" }, async (e: unknown) => e);
    await collect(hooks.get("turn.step")!($, { turnId: "c1", index: 0 }, (e: { model: string }) => answeredBy(e.model, "tool_use")));
    await hooks.get("session.compact")!($, { trigger: "auto" }, async (e: unknown) => e);
    let sent: { model?: string } = {};
    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "c1", index: 1 }, (e: { model: string }) => {
        sent = e;
        return answeredBy(e.model);
      }),
    );
    assert.equal(sent.model, "claude-fable-5-1");
    assert.match(text(last), /fable-5-1 ✓/);
  });

  test("a subagent's compaction leaves the main loop alone", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "s1");
    await hooks.get("session.compact")!($, { trigger: "auto", agentId: "agent-1" }, async (e: unknown) => e);
    setContext(150_000);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "s2", "2+2");
    assert.equal(t.sent.model, "claude-fable-5-1", "still held to what is warm");
  });

  test("/clear saves under the new session's id, leaving the old one's intact", async () => {
    const { hooks, $, setTier, shared } = await boot();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "k1");
    const before = JSON.stringify(shared.store.get("session:sess-R"));
    shared.id = "sess-R2";
    await hooks.get("classic.SessionStart")!($, { source: "clear" }, async (e: unknown) => e);
    setTier("opus", 0.9, 1);
    await turn(hooks, $, "k2", "something new");
    assert.equal(JSON.stringify(shared.store.get("session:sess-R")), before);
    assert.ok(shared.store.has("session:sess-R2"));
  });

  test("/clear works whenever the engine rotates the id: after the event too", async () => {
    const { hooks, $, setTier, shared } = await boot();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "l1");
    const before = JSON.stringify(shared.store.get("session:sess-R"));
    await hooks.get("classic.SessionStart")!($, { source: "clear" }, async (e: unknown) => e);
    shared.id = "sess-R3";
    setTier("opus", 0.9, 1);
    await turn(hooks, $, "l2", "something new");
    assert.equal(JSON.stringify(shared.store.get("session:sess-R")), before);
    assert.ok(shared.store.has("session:sess-R3"));
  });

  test("a /clear whose id never rotates is not undone by restoring the old state", async () => {
    const { hooks, $, setTier } = await boot();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "u1", "plan the old thing");
    await hooks.get("classic.SessionStart")!($, { source: "clear" }, async (e: unknown) => e);
    const status = (await run(hooks, $, "")).text;
    assert.match(status, /No turns yet/);
  });

  test("a copy that loads claims at once: the old one asks Jev no more, even on the next turn", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-CL" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const old = load(env, shared);
    await old.hooks.get("session.start")!(old.$, {}, async (e: unknown) => e);
    old.setTier("opus", 0.9, 1);
    await turn(old.hooks, old.$, "c0", "implement it");
    await new Promise((r) => setTimeout(r, 5));
    const fresh = load(env, shared);
    // The engine sends a reloaded module its own session.start.
    await fresh.hooks.get("session.start")!(fresh.$, {}, async (e: unknown) => e);
    fresh.setTier("opus", 0.9, 1);
    const asked = old.fetches();
    await old.hooks.get("turn.start")!(old.$, { text: "and tests", turnId: "c1" }, (e: unknown) =>
      fresh.hooks.get("turn.start")!(fresh.$, e, async (x: unknown) => x),
    );
    assert.equal(old.fetches(), asked, "the old copy stood aside on the very first turn");
    assert.equal(fresh.fetches(), 1);
  });

  test("/jev reaches the owner, not an older copy's frozen state", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-CMD" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const old = load(env, shared);
    await old.hooks.get("session.start")!(old.$, {}, async (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = load(env, shared);
    await fresh.hooks.get("session.start")!(fresh.$, {}, async (e: unknown) => e);
    const cmd = (args: string) =>
      old.hooks.get('command.run:{"command":"jev"}')!(old.$, { args }, (e: unknown) =>
        fresh.hooks.get('command.run:{"command":"jev"}')!(fresh.$, e, async () => ({ text: "nobody" })),
      );
    await cmd("off");
    // Routing is off in the copy that routes.
    fresh.setTier("opus", 0.9, 1);
    let sent: { model?: string } = {};
    await fresh.hooks.get("turn.start")!(fresh.$, { text: "x", turnId: "o1" }, async (e: unknown) => e);
    await collect(fresh.hooks.get("turn.step")!(fresh.$, { turnId: "o1", index: 0, model: "m" }, (e: { model: string }) => {
      sent = e;
      return answeredBy(e.model);
    }));
    assert.equal(sent.model, "m", "/jev off reached the owner");
  });

  test("two copies neither of which can claim still write one line and one summary", async () => {
    // What the desktop app showed after a clean restart: two copies acting,
    // one saving nowhere. No session id, and no shared runtime marker, so
    // neither ownership check can separate them; the output must dedupe.
    const shared = { store: new Map<string, unknown>(), id: "" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const outer = load(env, shared);
    const inner = load(env, shared);
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    for (const k of [outer, inner]) {
      await k.hooks.get("session.start")!(k.$, {}, async (e: unknown) => e);
      k.setTier("opus", 0.9, 1);
    }
    await outer.hooks.get("turn.start")!(outer.$, { text: "implement it", turnId: "n1" }, (e: unknown) =>
      inner.hooks.get("turn.start")!(inner.$, e, async (x: unknown) => x),
    );
    const out = (
      await collect(
        outer.hooks.get("turn.step")!(outer.$, { turnId: "n1", index: 0 }, (e: { model: string }) =>
          inner.hooks.get("turn.step")!(inner.$, e, (x: { model: string }) => answeredBy(x.model)),
        ),
      )
    )
      .filter((c) => c.kind === "text")
      .map((c) => c.text)
      .join("");
    assert.equal(out.match(/✳️/g)?.length, 1, "one route line");
    assert.equal(out.match(/% cached\)/g)?.length, 1, "one summary");
  });

  test("copies reading different session ids for one conversation write one line and one summary, the newest's", async () => {
    // What the desktop app showed 2026-09-23 after resuming a conversation
    // under a new id: a copy still reading the old id routed every turn too,
    // with its own Jev call, so each reply carried two or three lines.
    const store = new Map<string, unknown>();
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const stale = load(env, { store, id: "sess-OLD" });
    await stale.hooks.get("session.start")!(stale.$, {}, async (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = load(env, { store, id: "sess-NEW" });
    await fresh.hooks.get("session.start")!(fresh.$, {}, async (e: unknown) => e);
    // Separate runtimes: only the store is shared.
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    stale.setTier("fable", 0.95, 3);
    fresh.setTier("opus", 0.95, 1);
    // The stale copy sees the turn first; the fresh one overrides its claim.
    for (const k of [stale, fresh])
      await k.hooks.get("turn.start")!(k.$, { text: "restarted, do another audit", turnId: "d1" }, async (e: unknown) => e);
    const outOf = async (k: typeof stale) =>
      (await collect(k.hooks.get("turn.step")!(k.$, { turnId: "d1", index: 0 }, (e: { model: string }) => answeredBy(e.model ?? "claude-opus-5-5"))))
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join("");
    const out = (await outOf(stale)) + (await outOf(fresh));
    assert.equal(out.match(/✳️/g)?.length, 1, "one route line");
    assert.equal(out.match(/% cached\)/g)?.length, 1, "one summary");
    assert.match(out, /✳️ opus/, "the newest copy's");
  });

  test("a line and summary the model copied into its own text are dropped, leaving the real ones", async () => {
    // Seen 2026-09-23: the model ended a reply with a footer of made-up
    // figures above the real one, which read as a second copy of the plugin.
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-IMIT" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.95, 1);
    await kit.hooks.get("turn.start")!(kit.$, { text: "merge and push", turnId: "m1" }, async (e: unknown) => e);
    async function* copying(model: string) {
      yield {
        kind: "text",
        index: 0,
        text: "> ✳️ opus · medium · Jev 12% · 999ms\n\n---\n\nMerged.\n\n```\nopus-5-5 ✓ medium · Jev 12% · $0.21 · 450k in (99% cached) · 3k out\n```",
        ref: 1,
      };
      yield { kind: "stop", stopReason: "end_turn", usage: usage(model, 1000), ref: 2 };
      return { stopReason: "end_turn" };
    }
    const out = (await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "m1", index: 0 }, (e: { model: string }) => copying(e.model))))
      .filter((c) => c.kind === "text")
      .map((c) => c.text)
      .join("");
    assert.equal(out.match(/✳️/g)?.length, 1, "one route line");
    assert.equal(out.match(/% cached\)/g)?.length, 1, "one summary");
    assert.doesNotMatch(out, /\$0\.21|999ms|Jev 12%/, "the copied figures are gone");
    assert.match(out, /Merged\./);
  });

  test("copied lines and summaries are removed when the text streams in small pieces", async () => {
    // The engine hands text over a few tokens at a time, so no one piece
    // holds a whole copied line.
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-PIECES" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.95, 1);
    await kit.hooks.get("turn.start")!(kit.$, { text: "audit it", turnId: "p1" }, async (e: unknown) => e);
    const reply =
      "> ✳️ opus · medium · kept opus: Jev 32% on fable, needs 90% · 430ms\n\n---\n\nThe restart came back clean." +
      "\n\n```\nopus-5-5 ✓ medium · Jev 32% · $0.22 · 773k in (99% cached) · 2k out\n```";
    async function* pieces(model: string) {
      for (let i = 0; i < reply.length; i += 3) yield { kind: "text", index: 0, text: reply.slice(i, i + 3), ref: 1 + i };
      yield { kind: "stop", stopReason: "end_turn", usage: usage(model, 1000), ref: 9999 };
      return { stopReason: "end_turn" };
    }
    const chunks = await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "p1", index: 0 }, (e: { model: string }) => pieces(e.model)));
    const out = chunks.filter((c) => c.kind === "text").map((c) => c.text).join("");
    assert.equal(out.match(/✳️/g)?.length, 1, "one route line");
    assert.equal(out.match(/% cached\)/g)?.length, 1, "one summary");
    assert.doesNotMatch(out, /430ms|\$0\.22/, "the copied figures are gone");
    assert.match(out, /---\n\nThe restart came back clean\.\n\n```\n/, "the reply is whole, then the real summary");
    assert.ok(chunks.filter((c) => c.kind === "text").every((c) => c.ref !== undefined || /% cached\)/.test(c.text)), "pieces keep the engine's refs");
  });

  test("a task notification continues the reply's route without asking Jev, and counts as woken", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-NOTIFY" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("fable", 0.95, 3);
    await turn(kit.hooks, kit.$, "n1", "review the cluster in the background");
    const asked = kit.fetches();
    const xml = '<task-notification><task-id>abc</task-id><summary>Agent "reviewer" completed</summary></task-notification>';
    kit.setTier("haiku", 0.99, 0);
    const t = await turn(kit.hooks, kit.$, "n2", xml);
    assert.equal(kit.fetches(), asked, "Jev was not asked about the XML");
    assert.equal(t.sent.model, "claude-fable-5-1", "the reply's own route continues");
    assert.doesNotMatch(t.text, /✳️/, "no second line under the open reply");
    // A task no summarised reply spawned: its wake-up is a reply of its own.
    assert.match(t.text, /fable-5-1 ✓ medium/, "summarised on what answered");
    assert.match((await run(kit.hooks, kit.$, "")).text, /\[task finished\] Agent "reviewer" completed/);
  });

  test("a turn still running saves its state at most every few seconds; the end always saves", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-SAVES" };
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.95, 1);
    let sets = 0;
    const set = kit.$.store.set;
    kit.$.store.set = async (k: string, v: unknown) => {
      if (k.startsWith("session:")) sets++;
      return set(k, v);
    };
    await kit.hooks.get("turn.start")!(kit.$, { text: "implement it", turnId: "s1" }, async (e: unknown) => e);
    for (let i = 0; i < 10; i++)
      await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "s1", index: i }, (e: { model: string }) => answeredBy(e.model, "tool_use")));
    const midTurn = sets;
    assert.ok(midTurn <= 3, `the line's save and one throttled save, not one per step: ${midTurn}`);
    await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "s1", index: 10 }, (e: { model: string }) => answeredBy(e.model)));
    assert.ok(sets > midTurn, "the end of the turn saves");
    const saved = JSON.stringify(shared.store.get("session:sess-SAVES"));
    assert.match(saved, /implement it/);
  });

  test("an upgrade that would cost more than the limit over staying is held, and says so", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setTier("opus", 0.95, 2);
    await turn(hooks, $, "u1", "implement it");
    setContext(250_000);
    setTier("fable", 0.97, 3);
    const t = await turn(hooks, $, "u2", "now plan the migration");
    assert.equal(t.sent.model, "claude-opus-5-5", "kept on the warm tier");
    assert.match(t.text, /kept opus: fable costs \$5\.\d+ vs \$0\.\d+, over the \$1\.00 limit/);
  });

  test("an upgrade under the limit goes through; a small context is cheap to move", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setTier("opus", 0.95, 2);
    await turn(hooks, $, "c1", "implement it");
    setContext(20_000);
    setTier("fable", 0.97, 3);
    assert.equal((await turn(hooks, $, "c2", "now plan the migration")).sent.model, "claude-fable-5-1");
  });

  test("the upgrade limit is set by JEV_ROUTER_UPGRADE_MAX, and a named tier ignores it", async () => {
    const raised = await boot({ JEV_ROUTER_UPGRADE_MAX: "10" });
    raised.setTier("opus", 0.95, 2);
    await turn(raised.hooks, raised.$, "r1", "implement it");
    raised.setContext(250_000);
    raised.setTier("fable", 0.97, 3);
    assert.equal((await turn(raised.hooks, raised.$, "r2", "now plan the migration")).sent.model, "claude-fable-5-1");

    const named = await boot();
    named.setTier("opus", 0.95, 2);
    await turn(named.hooks, named.$, "n1", "implement it");
    named.setContext(250_000);
    assert.equal((await turn(named.hooks, named.$, "n2", "use fable to plan the migration")).sent.model, "claude-fable-5-1");
  });

  test("an unrouted turn warms the session model, and the next turn is priced from there", async () => {
    // Jev timed out on a fable session: the turn ran on the session model
    // (opus) and rewrote the cache there. Holding to fable afterwards would
    // send the next turn to a cold fable cache while calling it a stay.
    const { hooks, $, setTier, setContext, fail } = await boot();
    setContext(20_000);
    setTier("fable", 0.97, 3);
    assert.equal((await turn(hooks, $, "w1", "plan the migration")).sent.model, "claude-fable-5-1");
    setContext(250_000);
    fail();
    await hooks.get("turn.start")!($, { text: "2", turnId: "w2" }, async (e: unknown) => e);
    let sent: { model?: string } = { model: "unset" };
    await collect(
      hooks.get("turn.step")!($, { turnId: "w2", index: 0 }, (e: { model?: string }) => {
        sent = e;
        return answeredBy(e.model ?? "claude-opus-5-5");
      }),
    );
    assert.equal(sent.model, undefined, "unrouted: left on the session model");
    setTier("fable", 0.97, 3);
    const t = await turn(hooks, $, "w3", "do one more audit");
    assert.equal(t.sent.model, "claude-opus-5-5", "opus is what is warm now");
    assert.match(t.text, /kept opus: fable costs \$\d+\.\d+ vs \$0\.\d+, over the \$1\.00 limit/);
  });

  test("two sessions typing the same short prompt in the same minute are both routed", async () => {
    // The turn claim is keyed by text and context, so "yes" in one session
    // does not take the other's "yes".
    const store = new Map<string, unknown>();
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const a = load(env, { store, id: "sess-A" });
    await a.hooks.get("session.start")!(a.$, {}, async (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 3));
    const b = load(env, { store, id: "sess-B" });
    await b.hooks.get("session.start")!(b.$, {}, async (e: unknown) => e);
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    a.setContext(40_000);
    b.setContext(90_000);
    a.setTier("opus", 0.95, 1);
    b.setTier("opus", 0.95, 1);
    const tb = await turn(b.hooks, b.$, "y1", "implement the parser");
    const ta = await turn(a.hooks, a.$, "y2", "implement the parser");
    assert.equal(tb.sent.model, "claude-opus-5-5");
    assert.equal(ta.sent.model, "claude-opus-5-5", "the older session is not ceded");
    assert.match(ta.text, /✳️/);
  });

  test("a Sonnet effort hold does not bind to a placeholder effort", async () => {
    const { hooks, $, setTier, setContext, fail } = await boot({ JEV_ROUTER_CEILING: "xhigh" });
    setContext(20_000);
    setTier("sonnet", 0.95, 1, 0.9);
    await turn(hooks, $, "se1", "add a flag");
    fail();
    await hooks.get("turn.start")!($, { text: "and another", turnId: "se2" }, async (e: unknown) => e);
    await collect(
      hooks.get("turn.step")!($, { turnId: "se2", index: 0, effort: "xhigh" }, (e: { model?: string }) =>
        answeredBy(e.model ?? "claude-sonnet-5"),
      ),
    );
    setTier("sonnet", 0.95, 2, 0.4);
    const t = await turn(hooks, $, "se3", "and the tests");
    assert.equal(t.sent.effort, "high", "Jev's effort, not a hold to a placeholder");
    assert.doesNotMatch(t.text, /kept medium/);
  });

  test("a resume whose cache has expired prices nothing as warm, snapshot or not", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-EXP" };
    const first = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await first.hooks.get("session.start")!(first.$, {}, async (e: unknown) => e);
    first.setContext(20_000);
    first.setTier("fable", 0.95, 3);
    await turn(first.hooks, first.$, "x1", "plan it");
    await first.hooks.get("session.end")!(first.$, {}, async (e: unknown) => e);
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    const again = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await again.hooks.get("session.start")!(again.$, {}, async (e: unknown) => e);
    await again.hooks.get("classic.SessionStart")!(
      again.$,
      { source: "resume", model: "claude-fable-5-1", context_tokens: 20_000, prompt_cache_likely_expired: true },
      async (e: unknown) => e,
    );
    again.setContext(20_000);
    again.setTier("haiku", 0.99, 0);
    const t = await turn(again.hooks, again.$, "x2", "2+2");
    assert.equal(t.sent.model, "claude-haiku-4-5", "no warm cache to protect");
    assert.doesNotMatch(t.text, /kept fable/);
  });

  test("a usage record missing its cache fields does not poison the numbers", async () => {
    const { hooks, $, setTier } = await boot();
    setTier("opus", 0.95, 1);
    await hooks.get("turn.start")!($, { text: "implement it", turnId: "nan1" }, async (e: unknown) => e);
    async function* thin(model: string) {
      yield { kind: "text", index: 0, text: "reply", ref: 1 };
      yield { kind: "stop", stopReason: "end_turn", usage: { model, input_tokens: 1000, output_tokens: 300 }, ref: 2 };
      return { stopReason: "end_turn" };
    }
    const out = (await collect(hooks.get("turn.step")!($, { turnId: "nan1", index: 0 }, (e: { model: string }) => thin(e.model))))
      .filter((c) => c.kind === "text")
      .map((c) => c.text)
      .join("");
    assert.doesNotMatch(out, /NaN/);
    assert.match(out, /\$0\.0\d+ · 1k in \(0% cached\)/);
    assert.doesNotMatch((await run(hooks, $, "")).text, /NaN/);
  });

  test("a step whose turn.start this copy never saw still counts what it cost", async () => {
    const { hooks, $ } = await boot();
    await collect(hooks.get("turn.step")!($, { turnId: "orphan", index: 0 }, () => answeredBy("claude-opus-5-5")));
    assert.match((await run(hooks, $, "")).text, /spent\s+\$0\.0\d+ this session/);
  });

  test("only the opening of a long prompt is kept, so a session of pastes still saves", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-LONG" };
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.95, 1);
    await turn(kit.hooks, kit.$, "long1", "x".repeat(200_000));
    assert.ok(JSON.stringify(shared.store.get("session:sess-LONG")).length < 20_000);
  });

  test("an agent that finishes before its reply's last response gets one summary, not two", async () => {
    // agent.list says completed at the stop, so the summary is written
    // there; the task's notification then wakes the loop once more.
    const { hooks, $, setTier, setAgentStatus } = await boot();
    setTier("fable", 0.95, 3);
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "q1" }, async (e: unknown) => e);
    setAgentStatus("running");
    await hooks.get("agent.spawn")!($, { prompt: "review the cluster", description: "Review", agentId: "agent-1" }, async (e: { agentId?: string }) => ({ ...e, agentId: "agent-1" }));
    setAgentStatus("completed");
    const first = (await collect(hooks.get("turn.step")!($, { turnId: "q1", index: 0 }, (e: { model: string }) => answeredBy(e.model))))
      .filter((c) => c.kind === "text").map((c) => c.text).join("");
    const xml = '<task-notification><task-id>agent-1</task-id><summary>Agent "Review" completed</summary></task-notification>';
    const second = await turn(hooks, $, "q2", xml);
    const both = first + second.text;
    assert.equal(both.match(/% cached\)/g)?.length, 1, "one summary across the reply and its wake-up");
  });

  test("an unrouted turn on the same Sonnet model runs at its own effort, which the next turn does not hold to", async () => {
    const { hooks, $, setTier, setContext, fail, setSessionModel } = await boot({ JEV_ROUTER_CEILING: "xhigh" });
    setSessionModel("claude-sonnet-5");
    setContext(20_000);
    setTier("sonnet", 0.95, 3, 0.9);
    assert.equal((await turn(hooks, $, "ss1", "add a flag")).sent.effort, "xhigh");
    fail();
    await hooks.get("turn.start")!($, { text: "and another", turnId: "ss2" }, async (e: unknown) => e);
    await collect(
      hooks.get("turn.step")!($, { turnId: "ss2", index: 0, effort: "medium" }, (e: { model?: string }) =>
        answeredBy(e.model ?? "claude-sonnet-5"),
      ),
    );
    setTier("sonnet", 0.95, 1, 0.5);
    const t = await turn(hooks, $, "ss3", "and the tests");
    assert.equal(t.sent.effort, "medium", "medium is what the cache holds now");
    assert.doesNotMatch(t.text, /kept xhigh/);
  });

  test("a wake-up for a task whose reply was given up gets a block of its own", async () => {
    const { hooks, $, setTier, setAgentStatus } = await boot();
    setTier("fable", 0.95, 3);
    await hooks.get("turn.start")!($, { text: "review everything", turnId: "g1" }, async (e: unknown) => e);
    setAgentStatus("running");
    await hooks.get("agent.spawn")!($, { prompt: "review the cluster", description: "Review", agentId: "agent-1" }, async (e: { agentId?: string }) => ({ ...e, agentId: "agent-1" }));
    await collect(hooks.get("turn.step")!($, { turnId: "g1", index: 0 }, (e: { model: string }) => answeredBy(e.model)));
    // The person moves on while the agent runs; that reply is summarised.
    const typed = await turn(hooks, $, "g2", "unrelated quick question");
    assert.match(typed.text, /% cached\)/);
    setAgentStatus("completed");
    const xml = '<task-notification><task-id>agent-1</task-id><summary>Agent "Review" completed</summary></task-notification>';
    const woke = await turn(hooks, $, "g3", xml);
    assert.match(woke.text, /% cached\)/, "the agent's cost lands somewhere in the transcript");
  });

  test("routing off still sees responses rewrite an expired cache", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(20_000);
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "eo1", "plan it");
    await hooks.get("classic.SessionStart")!($, { source: "resume", model: "claude-fable-5-1", context_tokens: 20_000, prompt_cache_likely_expired: true }, async (e: unknown) => e);
    await run(hooks, $, "off");
    await hooks.get("turn.start")!($, { text: "carry on", turnId: "eo2" }, async (e: unknown) => e);
    await collect(hooks.get("turn.step")!($, { turnId: "eo2", index: 0 }, () => answeredBy("claude-fable-5-1")));
    await run(hooks, $, "on");
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "eo3", "2+2");
    assert.match(t.text, /kept fable: haiku costs/, "priced against the cache the off-turn wrote");
  });

  test("Jev is asked before the engine's context is read", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-ORDER" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    const order: string[] = [];
    const usage = kit.$.session.usage;
    kit.$.session.usage = async () => (order.push("usage"), usage());
    const fetch = kit.$.http.fetch;
    kit.$.http.fetch = async (u: string, i?: { body?: string }) => (order.push("jev"), fetch(u, i));
    await turn(kit.hooks, kit.$, "o1", "implement it");
    assert.deepEqual(order.slice(0, 2), ["jev", "usage"]);
  });

  describe("compaction by Jev", () => {
    const transcript = (n: number) => {
      const out: Record<string, unknown>[] = [{ role: "user", text: "audit the repo", toolUses: [], handle: "h0" }];
      for (let i = 1; i <= n; i++) {
        out.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: `u${i}`, tool: "Read", input: {} }], handle: `a${i}` });
        out.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: "x".repeat(2000), isError: false }], handle: `r${i}` });
      }
      out.push({ role: "assistant", text: "Done.", toolUses: [], handle: "end" });
      return out;
    };
    /** A harness whose Jev answers routing questions as usual and keeps only call t1 at a compaction. */
    const withJev = async (env: Record<string, string | undefined> = {}, shared = { store: new Map<string, unknown>(), id: "sess-CMP" }) => {
      const kit = load({ TYPESAFE_API_KEY: "ts-key", AI_GATEWAY_API_KEY: undefined, JEV_ROUTER_STICKY: "1", ...env }, shared);
      const routing = kit.$.http.fetch;
      let compactions = 0;
      kit.$.http.fetch = async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}");
        const names = Object.keys(body.questions ?? {});
        if (!names.some((n) => n.startsWith("call_"))) return routing(url, init);
        compactions++;
        const answers: Record<string, { noul: number }> = {};
        for (const n of names) answers[n] = { noul: n.endsWith("_t1") ? 0.9 : 0.1 };
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
      };
      await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
      return { ...kit, shared, compactions: () => compactions };
    };
    const compactEvent = (n = 10) => ({ trigger: "auto", messages: transcript(n) });

    test("a compaction returns Jev's pruned transcript instead of the engine's summary", async () => {
      const kit = await withJev();
      let fellThrough = false;
      const out = await kit.hooks.get("session.compact")!(kit.$, compactEvent(), async (e: unknown) => (fellThrough = true, { messages: [] }));
      assert.equal(fellThrough, false, "the engine's summary did not run");
      assert.equal(kit.compactions(), 1, "one Jev request");
      assert.ok(Array.isArray(out.messages) && out.messages.length < 22 && out.messages.length > 0);
      assert.equal(out.messages[0].handle, "h0", "an untouched message keeps its handle");
      assert.match((await run(kit.hooks, kit.$, "")).text, /compact\s+on, Jev prunes tool calls · last: kept \d+\/22 messages, \d+% smaller/);
    });

    test("too little to remove, or the gateway, leaves the engine's summary to run and /jev says why", async () => {
      const kit = await withJev();
      let fellThrough = false;
      await kit.hooks.get("session.compact")!(kit.$, compactEvent(2), async () => (fellThrough = true, { messages: [] }));
      assert.equal(fellThrough, true);
      assert.match((await run(kit.hooks, kit.$, "")).text, /last: engine summary: only \d+% removed, needs 25%/);
      const gw = await withJev({ TYPESAFE_API_KEY: undefined, AI_GATEWAY_API_KEY: "gw-key" }, { store: new Map(), id: "sess-GW" });
      fellThrough = false;
      await gw.hooks.get("session.compact")!(gw.$, compactEvent(), async () => (fellThrough = true, { messages: [] }));
      assert.equal(fellThrough, true);
      assert.match((await run(gw.hooks, gw.$, "")).text, /engine summary: the gateway/);
    });

    test("/jev compact off and on, kept across a reload; JEV_ROUTER_COMPACT=0 seeds off", async () => {
      const kit = await withJev();
      assert.match((await run(kit.hooks, kit.$, "compact off")).text, /compaction by Jev off/);
      let fellThrough = false;
      await kit.hooks.get("session.compact")!(kit.$, compactEvent(), async () => (fellThrough = true, { messages: [] }));
      assert.equal(fellThrough, true);
      assert.equal(kit.compactions(), 0, "Jev is not asked while off");
      assert.match((await run(kit.hooks, kit.$, "")).text, /compact\s+off \(\/jev compact on\)/);
      const again = await withJev({}, kit.shared);
      assert.match((await run(again.hooks, again.$, "compact")).text, /compaction by Jev off/);
      assert.match((await run(again.hooks, again.$, "compact on")).text, /compaction by Jev on/);
      const seeded = await withJev({ JEV_ROUTER_COMPACT: "0" }, { store: new Map(), id: "sess-SEED" });
      assert.match((await run(seeded.hooks, seeded.$, "")).text, /compact\s+off/);
    });

    test("a transcript the engine compacts ahead of time and then for real is scored once", async () => {
      const kit = await withJev();
      const messages = transcript(10);
      const first = await kit.hooks.get("session.compact")!(kit.$, { trigger: "precompute", messages }, async () => ({ messages: [] }));
      const second = await kit.hooks.get("session.compact")!(kit.$, { trigger: "auto", messages }, async () => ({ messages: [] }));
      assert.equal(kit.compactions(), 1, "one Jev request for both dispatches");
      assert.deepEqual(second.messages, first.messages);
      await kit.hooks.get("session.compact")!(kit.$, { trigger: "auto", messages: transcript(11) }, async () => ({ messages: [] }));
      assert.equal(kit.compactions(), 2, "a different transcript is scored again");
    });

    test("a pruned compaction keeps the hold and scales the context; a summary forgets both", async () => {
      const kit = await withJev();
      kit.setTier("fable", 0.95, 3);
      kit.setContext(20_000);
      await turn(kit.hooks, kit.$, "cw1", "plan it");
      await kit.hooks.get("session.compact")!(kit.$, compactEvent(), async () => ({ messages: [] }));
      kit.setContext(null);
      kit.setTier("haiku", 0.99, 0);
      const t = await turn(kit.hooks, kit.$, "cw2", "2+2");
      assert.equal(t.sent.model, "claude-fable-5-1", "the opening of the transcript is still warm on fable");
      assert.match(t.text, /kept fable: haiku costs/);

      const sum = await withJev({}, { store: new Map(), id: "sess-SUM" });
      sum.setTier("fable", 0.95, 3);
      sum.setContext(20_000);
      await turn(sum.hooks, sum.$, "cs1", "plan it");
      await sum.hooks.get("session.compact")!(sum.$, compactEvent(2), async () => ({ messages: [] }));
      sum.setContext(null);
      sum.setTier("haiku", 0.99, 0);
      assert.equal((await turn(sum.hooks, sum.$, "cs2", "2+2")).sent.model, "claude-haiku-4-5", "a summary leaves nothing warm");
    });

    test("/compact with instructions is the engine's to summarise", async () => {
      const kit = await withJev();
      let fellThrough = false;
      await kit.hooks.get("session.compact")!(kit.$, { ...compactEvent(), trigger: "manual", instructions: "keep the test plan" }, async () => (fellThrough = true, { messages: [] }));
      assert.equal(fellThrough, true);
      assert.equal(kit.compactions(), 0);
    });

    test("a transcript that grew by a few messages since it was scored reuses the scoring, tail appended", async () => {
      const kit = await withJev();
      const messages = transcript(10);
      const first = await kit.hooks.get("session.compact")!(kit.$, { trigger: "precompute", messages }, async () => ({ messages: [] }));
      const grown = [...messages, { role: "user", text: "and now?", toolUses: [], handle: "h-new" }];
      const second = await kit.hooks.get("session.compact")!(kit.$, { trigger: "auto", messages: grown }, async () => ({ messages: [] }));
      assert.equal(kit.compactions(), 1, "scored once");
      assert.equal(second.messages.length, first.messages.length + 1);
      assert.equal(second.messages.at(-1).handle, "h-new");
    });

    test("a copy that no longer owns the session does not answer a compaction from its cache", async () => {
      const shared = { store: new Map<string, unknown>(), id: "sess-OLDCACHE" };
      const old = await withJev({}, shared);
      const messages = transcript(10);
      await old.hooks.get("session.compact")!(old.$, { trigger: "precompute", messages }, async () => ({ messages: [] }));
      await new Promise((r) => setTimeout(r, 3));
      (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
      const fresh = await withJev({}, shared);
      await fresh.hooks.get("session.start")!(fresh.$, {}, async (e: unknown) => e);
      let reachedNext = false;
      await old.hooks.get("session.compact")!(old.$, { trigger: "auto", messages }, async () => (reachedNext = true, { messages: [] }));
      assert.equal(reachedNext, true, "the stale copy passes the event on");
    });

    test("a copy that no longer owns the session leaves its state alone at a compaction", async () => {
      const shared = { store: new Map<string, unknown>(), id: "sess-NOTMINE" };
      const old = await withJev({ JEV_ROUTER_COMPACT: "0" }, shared);
      old.setTier("fable", 0.95, 3);
      old.setContext(20_000);
      await turn(old.hooks, old.$, "nm1", "plan it");
      const before = JSON.stringify(shared.store.get("session:sess-NOTMINE"));
      await new Promise((r) => setTimeout(r, 3));
      (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
      const fresh = await withJev({ JEV_ROUTER_COMPACT: "0" }, shared);
      await fresh.hooks.get("turn.start")!(fresh.$, { text: "claim it", turnId: "nm2" }, async (e: unknown) => e);
      const saved = JSON.stringify(shared.store.get("session:sess-NOTMINE"));
      await old.hooks.get("session.compact")!(old.$, compactEvent(), async () => ({ messages: [] }));
      assert.equal(JSON.stringify(shared.store.get("session:sess-NOTMINE")), saved, "the stale copy wrote nothing");
      void before;
    });

    test("a subagent's compaction does not become /jev's last", async () => {
      const kit = await withJev();
      await kit.hooks.get("session.compact")!(kit.$, { ...compactEvent(), agentId: "agent-9" }, async () => ({ messages: [] }));
      assert.doesNotMatch((await run(kit.hooks, kit.$, "")).text, /last:/);
    });

    test("a go-ahead after a compaction in the middle of a turn still continues that turn", async () => {
      const kit = await withJev();
      kit.setTier("fable", 0.95, 3);
      kit.setContext(20_000);
      await kit.hooks.get("turn.start")!(kit.$, { text: "plan it", turnId: "mc1" }, async (e: unknown) => e);
      await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "mc1", index: 0 }, (e: { model: string }) => answeredBy(e.model, "tool_use")));
      await kit.hooks.get("session.compact")!(kit.$, compactEvent(2), async () => ({ messages: [] }));
      await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: "mc1", index: 1 }, (e: { model: string }) => answeredBy(e.model)));
      const yes = await turn(kit.hooks, kit.$, "mc2", "yes");
      assert.equal(yes.sent.model, "claude-fable-5-1", "continues the turn's decision");
    });
  });

  test("a prompt repeated by the same copy is routed each time", async () => {
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, { store: new Map(), id: "sess-REP" });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.95, 1);
    for (const id of ["r1", "r2"]) {
      await kit.hooks.get("turn.start")!(kit.$, { text: "again", turnId: id }, async (e: unknown) => e);
      const out = (await collect(kit.hooks.get("turn.step")!(kit.$, { turnId: id, index: 0 }, (e: { model: string }) => answeredBy(e.model))))
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join("");
      assert.match(out, /✳️ opus/, id);
    }
  });

  test("a session id that changes under a live copy is followed, not treated as a stranger", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-OLDID" };
    const kit = load({ AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" }, shared);
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    kit.setTier("opus", 0.9, 1);
    await turn(kit.hooks, kit.$, "i1", "implement it");
    shared.id = "sess-NEWID";
    await turn(kit.hooks, kit.$, "i2", "and the tests");
    assert.ok(shared.store.has("session:sess-NEWID"), "saves follow the new id");
    assert.ok(shared.store.has("owner:session:sess-NEWID"), "and the claim does too");
    const status = (await run(kit.hooks, kit.$, "")).text;
    assert.match(status, /and the tests/);
    assert.match(status, /implement it/, "the state came along");
  });

  test("the session ending releases its claim, so a later process on it is not left standing aside", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-END" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const first = load(env, shared);
    await first.hooks.get("session.start")!(first.$, {}, async (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    const second = load(env, shared);
    await second.hooks.get("session.start")!(second.$, {}, async (e: unknown) => e);
    await second.hooks.get("session.end")!(second.$, {}, async (e: unknown) => e);
    assert.ok(!shared.store.has("owner:session:sess-END"));
    // Two processes share the store but not a runtime: clear the runtime's
    // marker so `first` stands for the other process it models.
    (globalThis as { __jevRouterNewest?: number }).__jevRouterNewest = 0;
    first.setTier("opus", 0.9, 1);
    assert.equal((await turn(first.hooks, first.$, "e1", "implement the parser")).sent.model, "claude-opus-5-5");
  });

  test("two copies of the module in one session: the newest routes and writes, the old stands aside", async () => {
    const shared = { store: new Map<string, unknown>(), id: "sess-TWO" };
    const env = { AI_GATEWAY_API_KEY: "gw-key", JEV_ROUTER_STICKY: "1" };
    const old = load(env, shared);
    await old.hooks.get("session.start")!(old.$, {}, async (e: unknown) => e);
    old.setTier("opus", 0.9, 1);
    await turn(old.hooks, old.$, "d0", "implement it");
    await new Promise((r) => setTimeout(r, 5));
    // The plugin's files change: the engine loads a second copy and keeps the first.
    const fresh = load(env, shared);
    fresh.setTier("opus", 0.9, 1);

    // The engine runs both copies' hooks on each event, the older one outermost.
    const both = async (id: string, prompt: string) => {
      await old.hooks.get("turn.start")!(old.$, { text: prompt, turnId: id }, (e: unknown) =>
        fresh.hooks.get("turn.start")!(fresh.$, e, async (x: unknown) => x),
      );
      const chunks = await collect(
        old.hooks.get("turn.step")!(old.$, { turnId: id, index: 0 }, (e: { model: string }) =>
          fresh.hooks.get("turn.step")!(fresh.$, e, (x: { model: string }) => answeredBy(x.model)),
        ),
      );
      return chunks.filter((c) => c.kind === "text").map((c) => c.text).join("");
    };

    const first = await both("d1", "and the tests");
    assert.equal(first.match(/✳️/g)?.length, 1, "one route line, not two");
    assert.equal(first.match(/% cached\)/g)?.length, 1, "one summary, not two");

    const asked = old.fetches();
    const second = await both("d2", "and the docs");
    assert.equal(old.fetches(), asked, "the old copy no longer asks Jev");
    assert.equal(second.match(/✳️/g)?.length, 1);
    assert.equal(second.match(/% cached\)/g)?.length, 1);

    // A third copy loaded in the middle of a turn: still one summary for it.
    await old.hooks.get("turn.start")!(old.$, { text: "long task", turnId: "d9" }, (e: unknown) =>
      fresh.hooks.get("turn.start")!(fresh.$, e, async (x: unknown) => x),
    );
    await collect(
      old.hooks.get("turn.step")!(old.$, { turnId: "d9", index: 0 }, (e: { model: string }) =>
        fresh.hooks.get("turn.step")!(fresh.$, e, (x: { model: string }) => answeredBy(x.model, "tool_use")),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
    const third = load(env, shared);
    const end = await collect(
      old.hooks.get("turn.step")!(old.$, { turnId: "d9", index: 1 }, (e: { model: string }) =>
        fresh.hooks.get("turn.step")!(fresh.$, e, (x: { model: string }) =>
          third.hooks.get("turn.step")!(third.$, x, (y: { model: string }) => answeredBy(y.model)),
        ),
      ),
    );
    const endText = end.filter((c) => c.kind === "text").map((c) => c.text).join("");
    assert.equal(endText.match(/% cached\)/g)?.length, 1, "one summary when a copy arrives mid-turn");
  });

  test("the model a resume restores is not a move", async () => {
    const { hooks, $, setTier, setContext } = await boot();
    setContext(150_000);
    await hooks.get("classic.SessionStart")!(
      $,
      { source: "resume", model: "claude-fable-5-1", context_tokens: 150_000, prompt_cache_likely_expired: false },
      async (e: unknown) => e,
    );
    await hooks.get("classic.PostModelSwitch")!(
      $,
      { from_model: "claude-opus-5-5", to_model: "claude-fable-5-1", source: "resume" },
      async (e: unknown) => e,
    );
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "r1", "2+2")).sent.model, "claude-fable-5-1");
  });

  test("a nudge that finishes a reply the person started closes it with the summary", async () => {
    const { hooks, $, setTier } = await boot();
    setTier("fable", 0.9, 3);
    await hooks.get("turn.start")!($, { text: "plan it", turnId: "n1" }, async (e: unknown) => e);
    await collect(hooks.get("turn.step")!($, { turnId: "n1", index: 0 }, (e: { model: string }) => answeredBy(e.model, "tool_use")));
    const nudged = await turn(hooks, $, "n2", "The user hasn’t heard from you in a while — say what you’re doing, then continue.");
    assert.match(nudged.text, /2 turns: fable, fable \(1 nudged\)/);
    assert.doesNotMatch(nudged.text, /✳️/, "still no route line for the nudge");
  });

  test("a turn with no text is the engine continuing, not a prompt to grade", async () => {
    const { hooks, $, setTier, fetches } = await boot();
    setTier("fable", 0.9, 3);
    await turn(hooks, $, "e1");
    const asked = fetches();
    const t = await turn(hooks, $, "e2", "");
    assert.equal(fetches(), asked);
    assert.equal(t.sent.model, "claude-fable-5-1");
    assert.doesNotMatch(t.text, /empty prompt/);
  });

  test("the summary opens a block past a tool block, and a failed request gets none", async () => {
    const { hooks, $ } = await boot();
    await hooks.get("turn.start")!($, { text: "x", turnId: "i1" }, async (e: unknown) => e);
    async function* textThenTool() {
      yield { kind: "text", index: 0, text: "reply", ref: 1 };
      yield { kind: "tool", index: 1, ref: 2 };
      yield { kind: "stop", stopReason: "max_tokens", usage: usage("claude-opus-5-5"), ref: 3 };
      return { stopReason: "max_tokens" };
    }
    const chunks = await collect(hooks.get("turn.step")!($, { turnId: "i1", index: 0 }, () => textThenTool()));
    const summary = chunks.find((c) => c.kind === "text" && /% cached\)/.test(c.text ?? ""));
    assert.equal((summary as { index: number }).index, 2);

    await hooks.get("turn.start")!($, { text: "y", turnId: "i2" }, async (e: unknown) => e);
    async function* failed() {
      yield { kind: "stop", stopReason: null, usage: null, ref: 1 };
      return { stopReason: null };
    }
    const none = await collect(hooks.get("turn.step")!($, { turnId: "i2", index: 0 }, () => failed()));
    assert.doesNotMatch(text(none), /% cached\)/);
  });

  test("a held turn names the bar it did not clear", async () => {
    const { hooks, $, setTier, setContext } = await boot({ JEV_ROUTER_UPGRADE_MAX: "off" });
    setTier("opus", 0.95, 2);
    await turn(hooks, $, "b1", "implement it");
    setContext(150_000);
    setTier("fable", 0.76, 3);
    const t = await turn(hooks, $, "b2", "plan the rest");
    assert.match(t.text, /kept opus: Jev 76% on fable, needs 90%/);
    await run(hooks, $, "");
  });
});
