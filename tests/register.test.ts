import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { register } from "../hooks/register.ts";

/**
 * Drives the real `register` with a fake engine: captures the hooks it
 * registers, then runs turn.start and turn.step the way the engine would.
 */
function load(env: Record<string, string | undefined> = { AI_GATEWAY_API_KEY: "gw-key" }) {
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
    session: {
      surface: async () => "test",
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
            status: "running",
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
      /^> ✳️ `opus` · medium · 91% · capped:high · \d+ms\n\n---\n\nHello$/,
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
    assert.match(first.find((c) => c.kind === "text")!.text, /^> ✳️ `opus`/);
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
      "> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY\n\n---\n\nreply",
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
    assert.match(chunks[1]!.text, /^> ✳️ `opus`.*\n\n---\n\nanswer$/);
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
    assert.match(out.text, /claude-opus-5-5 ✓/);
    assert.match(out.text, /cache 90%/);
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
    assert.match(out.text, /claude-haiku-4-5 ≠ claude-opus-5/);
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
    assert.match(footer, /```\n─+\njev {2}opus·medium/);
    assert.match(footer, /api {2}claude-opus-5-5 ✓/);
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
      /jev {2}opus/,
    );

    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "t10", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn"),
      ),
    );
    assert.match(
      last.filter((c) => c.kind === "text").at(-1)!.text,
      /jev {2}opus·medium/,
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
    assert.match(texts[0]!, /^> ✳️ `opus` · medium · 91% · capped:high · notify · 0ms/);
    assert.match(texts.at(-1)!, /jev {2}opus·medium · 91% · capped:high · notify · 0ms/);
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /\[notify\] Agent "reviewer" completed/);
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
      /unrouted — \[agent:general-purpose\] Review library-sync cluster/,
    );
    assert.match(out.text, /answered claude-opus-5/);
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
    assert.equal(out.text.match(/unrouted — \[agent/g)?.length, 1);
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
    assert.match(out.text, /unrouted — \[agent\] agent-unknown-xyz/);
  });

  test("a main-loop step never touches the agent list", async () => {
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
    assert.match(second.text, /held:haiku/);
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
    assert.match(second.text, /`opus` · medium · 0% · forced/);
    assert.doesNotMatch(second.text, /held/);
  });

  test("needs no answer from Jev", async () => {
    const { hooks, $, fail, fetches } = await started();
    const asked = fetches();
    fail();
    const t = await turn(hooks, $, "f3", "switch to haiku");
    assert.equal(t.sent.model, "claude-haiku-4-5");
    assert.equal(fetches(), asked, "Jev is not called");
    assert.match(t.text, /`haiku` · medium · 0% · forced/);
  });

  test("cannot name a tier the environment excluded", async () => {
    const { hooks, $, setTier } = await started({ JEV_ROUTER_EXCLUDE: "fable" });
    setTier("opus", 0.9);
    const t = await turn(hooks, $, "f4", "use fable and plan it");
    assert.equal(t.sent.model, "claude-opus-5-5", "Jev’s pick stands");
    assert.doesNotMatch(t.text, /forced/);
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
    assert.match(t.text, /forced/);
    assert.doesNotMatch(t.text, /held-effort/);
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
    assert.match(second.text, /`fable` · medium · 90% · continue · 0ms/);
  });

  test("does not carry a hold tag over from the turn it continues", async () => {
    const { hooks, $, setTier } = await started();
    setTier("fable", 0.9);
    await turn(hooks, $, "g3", "plan it");
    setTier("haiku", 0.4);
    const held = await turn(hooks, $, "g4", "now the tests");
    assert.match(held.text, /held:haiku/);
    const go = await turn(hooks, $, "g5", "ok");
    assert.equal(go.sent.model, "claude-fable-5-1");
    assert.doesNotMatch(go.text, /held/);
    assert.match(go.text, /continue/);
  });

  test("on the first turn there is nothing to continue, so the session model stays", async () => {
    const { hooks, $, setTier, fetches } = await started();
    setTier("haiku", 1, 0);
    const t = await turn(hooks, $, "g6", "yes");
    assert.equal(fetches(), 0, "Jev is not asked; it would clear sticky");
    assert.equal(t.sent.model, undefined, "left on the session model");
    assert.match(t.text, /unrouted/);
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
    assert.match(t.text, /`sonnet` · medium · 90% · held-effort:xhigh/);
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
    assert.match(t.text, /capped:xhigh/);
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
    assert.match(out.text, /haiku·medium 0\.98 +\[agent:Explore\] Count hook files/);
    assert.equal(
      out.text.split("\n").filter((l: string) => /\[agent:Explore\]/.test(l)).length,
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
    assert.match(out.text, /unrouted — .*sonnet at 0\.22, under the 0\.5 bar/);
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
    assert.match(out.text, /unrouted — .*gateway responded 500|unrouted — .*500/);
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
    setContext(200_000);
    setTier("haiku", 0.99, 0);
    const t = await turn(hooks, $, "p2", "what is 2+2");
    assert.equal(t.sent.model, "claude-fable-5-1");
    assert.equal(t.sent.effort, "low", "Jev's effort still applies");
    assert.match(t.text, /held:haiku·\$\d+\.\d+>\$\d/);
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
    assert.match(t.text, /held:haiku·\$/);
  });

  test("an upgrade is not priced: a fable pick from haiku goes through at any context", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("haiku", 0.95, 0);
    await turn(hooks, $, "u1", "2+2");
    setContext(300_000);
    setTier("fable", 0.9, 3);
    assert.equal((await turn(hooks, $, "u2", "plan it")).sent.model, "claude-fable-5-1");
  });

  test("/jev sticky off switches freely, price and all", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "s1", "plan");
    await run(hooks, $, "sticky off");
    setContext(200_000);
    setTier("haiku", 0.99, 0);
    assert.equal((await turn(hooks, $, "s2", "2+2")).sent.model, "claude-haiku-4-5");
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
    // 3k output at 8k context: pays on the five-minute cache (break-even
    // ~10k), not on the hour's (~6k).
    assert.equal(await at("5m", 8_000), "claude-haiku-4-5");
    assert.equal(await at(undefined, 8_000), "claude-fable-5-1");
  });

  test("/jev shows the context and the break-even, and the session's dollars", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setTier("fable", 0.95, 3);
    await turn(hooks, $, "v1", "plan");
    setContext(200_000);
    const status = await run(hooks, $, "");
    assert.match(status.text, /cache\s+1h writes · 200k context · fable→haiku pays below \d+k/);
    assert.match(status.text, /spent\s+\$0\.\d+ this session/);
    assert.match(status.text, /3k out {2}\$0\.\d+/);
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
    setContext(200_000);
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
    assert.match(t.text, /capped:xhigh/);
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
    assert.match(first.text, /`fable` · high · 90% · \d+ms/);
    const status = await hooks.get('command.run:{"command":"jev"}')!($, { args: "" });
    assert.match(status.text, /fable·high 0\.90/);
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
    setContext(50_000);
    setTier("fable", 0.9, 1);
    const t = await turn(hooks, $, "f4");
    assert.equal(t.sent.effort, "medium");
    assert.match(t.text, /`fable` · medium/);
  });

  test("a compaction makes the next request a first one again", async () => {
    const { hooks, $, setTier, setContext } = await started();
    setContext(50_000);
    setTier("fable", 0.9, 1);
    assert.equal((await turn(hooks, $, "f5")).sent.effort, "medium");
    await hooks.get("session.compact")!($, { trigger: "auto" }, async (e: unknown) => e);
    setContext(null);
    assert.equal((await turn(hooks, $, "f6")).sent.effort, "high");
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
