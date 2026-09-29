import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compact } from "../hooks/compaction/compact.ts";
import type { JevAsker, JevQuestions, Message } from "../hooks/compaction/types.ts";

/** A transcript with `n` tool calls, each with a small result. */
function transcript(n: number): Message[] {
  const out: Message[] = [{ role: "user", text: "start", toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    out.push({
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: `u${i}`, tool: "Read", input: { path: `f${i}.ts` } }],
    });
    out.push({
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: `u${i}`, text: "x".repeat(50), isError: false }],
    });
  }
  out.push({ role: "assistant", text: "done", toolUses: [] });
  return out;
}

/** An asker that tracks how many `ask()` calls are in flight at once. */
function trackingAsker(delayMs = 5): JevAsker & { calls: () => number; maxActive: () => number } {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  return {
    calls: () => calls,
    maxActive: () => maxActive,
    async ask(_state, questions: JevQuestions) {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.5 };
      return { answers };
    },
  };
}

describe("compact: batch concurrency", () => {
  test("never runs more than 2 batches at once, however many there are", async () => {
    // A prior version added the concurrency-limiting wrapper to the wrong
    // promise (`active.add(wrapped.finally(() => active.delete(wrapped)))`
    // adds the *result* of `.finally()`, a different promise than the one
    // whose settlement the callback deletes), so `active` only ever grew:
    // once any entry settled, `Promise.race(active)` resolved instantly on
    // every later check and the cap stopped limiting after the first batch.
    // Measured against that version with this exact harness: 7 of 8 batches
    // ran at once.
    const asker = trackingAsker();
    const result = await compact(transcript(8), asker, {
      maxRequestTokens: 1000,
      preserveRecentMessages: 0,
    });
    assert.ok(result.stats.requests >= 4, `need several batches to prove the cap: got ${result.stats.requests}`);
    assert.equal(asker.calls(), result.stats.requests);
    assert.ok(asker.maxActive() <= 2, `at most 2 batches in flight at once: got ${asker.maxActive()}`);
  });

  test("a batch's own answers land on its own calls even when a later batch resolves first", async () => {
    // concurrentMap collects results by index, not completion order. Two
    // batches whose answers disagree (one keeps everything, the other drops
    // everything), with the second one resolving first, must not have their
    // answers swapped onto each other's calls.
    let batchesSeen = 0;
    const asker: JevAsker = {
      async ask(_state, questions: JevQuestions) {
        const mine = batchesSeen++;
        // The first batch called resolves last.
        await new Promise((r) => setTimeout(r, mine === 0 ? 20 : 0));
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(questions)) answers[name] = { noul: mine === 0 ? 1 : 0 };
        return { answers };
      },
    };
    const result = await compact(transcript(4), asker, {
      maxRequestTokens: 700,
      preserveRecentMessages: 0,
      keepThreshold: 0.5,
    });
    assert.ok(result.stats.requests >= 2, `need at least 2 batches: got ${result.stats.requests}`);
    const first = result.decisions[0];
    const last = result.decisions.at(-1);
    assert.equal(first.reason, "kept", "the first batch's calls keep its own answer (1)");
    assert.equal(last?.reason, "call_dropped", "the last batch's calls keep its own answer (0), not swapped");
  });
});

describe("state cuts keep surrogate pairs whole (2026-09-29)", () => {
  test("truncate does not leave half an emoji", async () => {
    const { truncate } = await import("../hooks/compaction/state.ts");
    const out = truncate(`${"a".repeat(9)}😀tail`, 11);
    assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("state building at scale (2026-09-29)", async () => {
  const { fitState } = await import("../hooks/compaction/state.ts");
  test("calls that cannot fit are refused at once", () => {
    const messages: Message[] = [{ role: "user", text: "go", toolUses: [] }];
    const calls = Array.from({ length: 48_000 }, (_, i) => ({ id: `toolu_${i}`, tool: "Read", input: {}, callIndex: 0 }));
    const t = performance.now();
    assert.throws(() => fitState(messages, calls as never, { maxStateTokens: 25_000, preserveRecentMessages: 6, goal: "" }), /too large/);
    assert.ok(performance.now() - t < 2000);
  });
  test("a message's text as Jev is shown it can be replaced, the output untouched", () => {
    const messages: Message[] = [
      { role: "user", text: "audit", toolUses: [] },
      { role: "user", text: "<task-notification><task-id>a</task-id><result>SECRET</result></task-notification>", toolUses: [] },
    ];
    const fitted = fitState(messages, [], {
      maxStateTokens: 25_000,
      preserveRecentMessages: 6,
      goal: "",
      textOf: (m) => (m.text.includes("SECRET") ? "task a" : m.text),
    });
    assert.doesNotMatch(JSON.stringify(fitted.state), /SECRET/);
    assert.match(messages[1]!.text, /SECRET/);
  });
});
