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
