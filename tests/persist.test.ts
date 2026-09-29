import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  pack,
  SNAPSHOT_VERSION,
  SNAPSHOTS_KEPT,
  staleKeys,
  unpack,
  type State,
} from "../hooks/persist.ts";
import { ceilingAt } from "../hooks/policy.ts";
import type { Attempt } from "../hooks/status.ts";

const decision = {
  tier: "fable" as const,
  model: "claude-fable-5-1",
  effort: "medium" as const,
  confidence: 0.9,
};

const stateWith = (shared: Attempt): State => ({
  attempts: [shared],
  reply: [shared],
  replyAgents: ["agent-1"],
  spawned: [["agent-1", shared]],
  turns: [["turn-1", shared]],
  decisions: [["turn-1", decision]],
  pending: ["turn-1"],
  stepped: ["agent-1"],
  running: decision,
  continueFrom: decision,
  latest: decision,
  lastUsage: { context: 200_000, output: 1500 },
  sessionModel: "claude-opus-5-5[1m]",
  spent: 4.12,
  enabled: true,
  announce: false,
  sticky: 0.6,
  ceiling: { ...ceilingAt("medium"), fable: "xhigh" },
});

const roundTrip = (s: State) => unpack(JSON.parse(JSON.stringify(pack(s))));

describe("persist", () => {
  test("a state comes back as it went, through JSON", () => {
    const a: Attempt = { prompt: "plan it", ms: 300, decision };
    const back = roundTrip(stateWith(a))!;
    assert.deepEqual(back.attempts, [a]);
    assert.deepEqual(back.running, decision);
    assert.deepEqual(back.lastUsage, { context: 200_000, output: 1500 });
    assert.equal(back.sessionModel, "claude-opus-5-5[1m]");
    assert.equal(back.spent, 4.12);
    assert.equal(back.announce, false);
    assert.equal(back.sticky, 0.6);
    assert.equal(back.ceiling.fable, "xhigh");
    assert.deepEqual(back.replyAgents, ["agent-1"]);
  });

  test("one attempt shared by the history, the reply and the agent map stays one object", () => {
    const shared: Attempt = { prompt: "review it", ms: 1, kind: "agent", decision };
    const packed = pack(stateWith(shared));
    assert.equal(packed.pool.length, 1, "written once");
    const back = roundTrip(stateWith(shared))!;
    assert.equal(back.attempts[0], back.reply[0]);
    assert.equal(back.attempts[0], back.spawned[0]![1]);
    // Usage folded into one after a reload shows in all three.
    (back.spawned[0]![1] as Attempt).cost = 0.5;
    assert.equal(back.attempts[0]!.cost, 0.5);
  });

  test("the turns in flight come back, sharing their attempt with the history", () => {
    const shared: Attempt = { prompt: "plan it", ms: 1, decision };
    const back = roundTrip(stateWith(shared))!;
    assert.equal(back.turns[0]![0], "turn-1");
    assert.equal(back.turns[0]![1], back.attempts[0]);
    assert.deepEqual(back.decisions, [["turn-1", decision]]);
    assert.deepEqual(back.pending, ["turn-1"]);
    assert.deepEqual(back.stepped, ["agent-1"]);
  });

  test("a snapshot from before those fields existed still restores, with nothing in flight", () => {
    const packed = JSON.parse(JSON.stringify(pack(stateWith({ prompt: "x", ms: 1, decision }))));
    delete packed.turns;
    delete packed.decisions;
    delete packed.pending;
    delete packed.stepped;
    const back = unpack(packed)!;
    assert.notEqual(back, null);
    assert.deepEqual(back.turns, []);
    assert.deepEqual(back.pending, []);
  });

  test("excludedTiers absent (a snapshot from before it existed) comes back undefined, not an empty array", () => {
    // register.ts's applyState leaves the environment's own
    // JEV_ROUTER_EXCLUDE seeding in place only when this is undefined; if
    // unpack defaulted a missing field to [], restoring an old snapshot
    // would silently clear whatever the environment had excluded.
    const packed = JSON.parse(JSON.stringify(pack(stateWith({ prompt: "x", ms: 1, decision }))));
    delete packed.excludedTiers;
    const back = unpack(packed)!;
    assert.notEqual(back, null);
    assert.equal(back.excludedTiers, undefined);
  });

  test("excludedTiers present is validated: unknown or non-string entries dropped, an explicit empty array kept", () => {
    const packed = JSON.parse(JSON.stringify(pack(stateWith({ prompt: "x", ms: 1, decision }))));
    const withField = (v: unknown) => unpack({ ...packed, excludedTiers: v })!;
    assert.deepEqual(withField(["fable", "gpt", 7, "opus"]).excludedTiers, ["fable", "opus"]);
    assert.deepEqual(withField([]).excludedTiers, [], "explicitly empty stays empty, not undefined");
    assert.deepEqual(withField("fable").excludedTiers, [], "not an array at all: nothing kept");
  });

  test("anything that is not a snapshot of this version is refused", () => {
    assert.equal(unpack(undefined), null);
    assert.equal(unpack("x"), null);
    assert.equal(unpack({ v: SNAPSHOT_VERSION + 1 }), null);
    const good = JSON.parse(JSON.stringify(pack(stateWith({ prompt: "x", ms: 1, decision }))));
    assert.notEqual(unpack(good), null);
    assert.equal(unpack({ ...good, attempts: [7] }), null, "a reference past the pool");
    assert.equal(unpack({ ...good, spawned: [[1, 0]] }), null, "an agent id that is not a string");
    assert.equal(unpack({ ...good, ceiling: null }), null);
  });

  test("a corrupted or out-of-range Decision is dropped, not trusted", () => {
    // Added alongside clamping confidence at its source (decisionOf): a
    // Decision that reaches the store some other way (a hand-edited file,
    // a future bug) with a bad shape or an out-of-range confidence must not
    // come back and be routed on.
    const good = JSON.parse(JSON.stringify(pack(stateWith({ prompt: "x", ms: 1, decision }))));
    const withRunning = (running: unknown) => unpack({ ...good, running });
    assert.equal(withRunning({ ...decision, confidence: 1.5 })?.running, null, "confidence over 1");
    assert.equal(withRunning({ ...decision, confidence: -0.1 })?.running, null, "confidence under 0");
    assert.equal(withRunning({ ...decision, confidence: "high" })?.running, null, "confidence not a number");
    assert.equal(withRunning({ ...decision, tier: 5 })?.running, null, "tier not a string");
    assert.equal(withRunning({ ...decision, model: undefined })?.running, null, "missing model");
    assert.deepEqual(withRunning(decision)?.running, decision, "a valid one still comes back");
    // decisions[] filters the same way, entry by entry.
    const withDecisions = (entry: unknown) =>
      unpack({ ...good, decisions: [["turn-1", entry]] });
    assert.deepEqual(withDecisions(decision)?.decisions, [["turn-1", decision]]);
    assert.deepEqual(withDecisions({ ...decision, confidence: 2 })?.decisions, []);
  });

  test("the oldest snapshots are dropped past the limit, the current one never", () => {
    const keys = [
      "other",
      ...Array.from({ length: SNAPSHOTS_KEPT + 3 }, (_, i) => `session:${i}`),
    ];
    const stale = staleKeys(keys, "session:new");
    assert.deepEqual(stale, ["session:0", "session:1", "session:2", "session:3"]);
    assert.deepEqual(staleKeys(["session:a", "session:b"], "session:a"), []);
    assert.ok(!staleKeys(keys, "session:5").includes("session:5"));
  });
});

describe("persist: a snapshot is checked, not trusted (2026-09-28)", () => {
  const packed = () => JSON.parse(JSON.stringify(pack(stateWith({ prompt: "p", ms: 1, decision }))));
  test("a ceiling missing a tier, or capping one at no effort, is refused", () => {
    const missing = packed();
    delete missing.ceiling.fable;
    assert.equal(unpack(missing), null);
    const bogus = packed();
    bogus.ceiling.opus = "bogus";
    assert.equal(unpack(bogus), null);
  });
  test("a decision on an unknown tier or effort is dropped", () => {
    const raw = packed();
    raw.running = { ...decision, tier: "gpt" };
    raw.latest = { ...decision, effort: "turbo" };
    raw.decisions = [["t", { ...decision, tier: "gpt" }], ["u", decision]];
    const back = unpack(raw)!;
    assert.equal(back.running, null);
    assert.equal(back.latest, null);
    assert.deepEqual(back.decisions.map(([id]) => id), ["u"]);
  });
  test("the settings a command set come back; a snapshot without the field restores them all", () => {
    const s = { ...stateWith({ prompt: "p", ms: 1, decision }), overridden: ["sticky" as const] };
    assert.deepEqual(roundTrip(s)!.overridden, ["sticky"]);
    assert.equal(roundTrip(stateWith({ prompt: "p", ms: 1, decision }))!.overridden, undefined);
  });
});

describe("persist: round-3 audit (2026-09-29)", () => {
  const packed = () => JSON.parse(JSON.stringify(pack(stateWith({ prompt: "p", ms: 1, decision }))));
  test("an attempt with a bad decision, bad usage or a string cost is refused", () => {
    for (const bad of [
      { prompt: "x", ms: 1, decision: null },
      { prompt: "x", ms: 1, decision, usage: { model: "m", input_tokens: "100", output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { prompt: "x", ms: 1, decision, cost: "0.5" },
      { ms: 1, skipped: "why" },
    ]) {
      const raw = packed();
      raw.pool[0] = bad;
      assert.equal(unpack(raw), null, JSON.stringify(bad));
    }
  });
  test("a sticky bar outside 0–1 and a negative context are not trusted", () => {
    const raw = packed();
    raw.sticky = 5;
    raw.lastUsage = { context: -10, output: 1 };
    const back = unpack(raw)!;
    assert.equal(back.sticky, null);
    assert.equal(back.lastUsage, null);
  });
  test("pruning drops the least recently saved, not the first written", () => {
    const keys = Array.from({ length: SNAPSHOTS_KEPT + 1 }, (_, i) => `session:s${i}`);
    const savedAt = new Map(keys.map((k, i) => [k, i === 0 ? 10_000 : i]));
    assert.deepEqual(staleKeys(keys, "session:new", savedAt), ["session:s1", "session:s2"]);
  });
});

describe("persist: fields /jev prints from are checked (2026-09-29)", () => {
  test("a held cost that is not numbers rejects the snapshot", () => {
    const held = { ...decision, heldCost: { stay: 0.01, go: null as unknown as number } };
    const a: Attempt = { prompt: "2+2", ms: 1, decision: held };
    assert.equal(roundTrip(stateWith(a)), null);
  });
  test("an agent tag whose type is not text rejects the snapshot", () => {
    const a = { prompt: "task", ms: 1, decision, agent: { type: { x: 1 }, label: "agent" } } as unknown as Attempt;
    assert.equal(roundTrip(stateWith(a)), null);
  });
  test("well-formed held and agent fields still come back", () => {
    const held = { ...decision, heldCost: { stay: 0.01, go: 0.6, limit: 0.3 }, heldWindow: 300_000, jevFailed: "timed out" };
    const a: Attempt = { prompt: "task", ms: 1, decision: held, agent: { type: "Explore", label: "Explore agent" } };
    assert.deepEqual(roundTrip(stateWith(a))!.attempts, [a]);
  });
});
