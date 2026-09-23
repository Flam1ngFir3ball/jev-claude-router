import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  compactionLine,
  compactOnOf,
  compactTimeoutOf,
  DEFAULT_COMPACT_TIMEOUT_MS,
  minReductionOf,
  pruneTranscript,
  type EngineMessage,
} from "../hooks/compactor.ts";
import type { ProviderResult } from "../hooks/provider.ts";

const typesafe: ProviderResult = {
  ok: true,
  name: "typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  apiKey: "k",
};
const gateway: ProviderResult = { ...typesafe, name: "gateway", endpoint: "https://ai-gateway.vercel.sh/v1/evaluate" };

/** A transcript: a prompt, then `n` tool calls with big results, then a closing reply. */
function transcript(n: number): EngineMessage[] {
  const out: EngineMessage[] = [{ role: "user", text: "audit the repo", toolUses: [], handle: "h0" }];
  for (let i = 1; i <= n; i++) {
    out.push({
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: `u${i}`, tool: "Read", input: { path: `f${i}.ts` } }],
      handle: `ha${i}`,
    });
    out.push({
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: `u${i}`, text: `contents of f${i}: ${"x".repeat(2000)}`, isError: false }],
      handle: `hu${i}`,
    });
  }
  out.push({ role: "assistant", text: "Done.", toolUses: [], handle: "hend" });
  return out;
}

/** A Jev that keeps the calls named in `keep` whole, and drops the rest. */
function jev(keep: readonly string[], calls = 0) {
  return async (_url: string, init?: { body?: string }) => {
    calls++;
    const questions = JSON.parse(init?.body ?? "{}").questions as Record<string, unknown>;
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const id = name.replace(/^(call|result)_/, "");
      answers[name] = { noul: keep.includes(id) ? 0.9 : 0.1 };
    }
    return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
  };
}
const never = () => new Promise<never>(() => {});

describe("pruneTranscript", () => {
  test("keeps what Jev keeps, drops the rest, and hands the engine its own messages where untouched", async () => {
    const input = transcript(10);
    const r = await pruneTranscript({
      messages: input,
      provider: typesafe,
      fetch: jev(["t1"]),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
      options: { preserveRecentMessages: 2 },
    });
    assert.ok(r.ok, JSON.stringify(r.compaction));
    if (!r.ok) return;
    assert.ok(r.messages.length < input.length, "messages were removed");
    assert.ok(r.compaction.reduction > 0.5, `reduction ${r.compaction.reduction}`);
    assert.equal(r.messages[0], input[0], "the first message is the engine's own");
    assert.ok(r.messages.every((m) => m === input.find((i) => i === m) || m.handle === undefined), "rebuilt messages carry no handle");
    assert.equal(r.compaction.fallback, undefined);
    assert.match(compactionLine(r.compaction), /^kept \d+\/\d+ messages, \d+% smaller \(\d+ calls kept, \d+ cut, \d+ dropped\) · \d+ms$/);
  });

  test("too little removed leaves the engine's summary to run", async () => {
    const r = await pruneTranscript({
      messages: transcript(3),
      provider: typesafe,
      fetch: jev(["t1", "t2", "t3"]),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
    });
    assert.equal(r.ok, false);
    assert.match(r.compaction.fallback ?? "", /^only \d+% removed, needs 25%$/);
    assert.match(compactionLine(r.compaction), /^engine summary: only/);
  });

  test("the gateway cannot answer yes/no questions", async () => {
    const r = await pruneTranscript({ messages: transcript(3), provider: gateway, fetch: jev([]), sleep: never, timeoutMs: 8000, minReduction: 0.25 });
    assert.equal(r.ok, false);
    assert.match(r.compaction.fallback ?? "", /gateway/);
  });

  test("a slow Jev is given up on, and a broken one", async () => {
    const slow = await pruneTranscript({
      messages: transcript(10),
      provider: typesafe,
      fetch: () => new Promise<never>(() => {}),
      sleep: async () => undefined,
      timeoutMs: 50,
      minReduction: 0.25,
    });
    assert.equal(slow.ok, false);
    assert.equal(slow.compaction.fallback, "timed out after 50ms");
    const broken = await pruneTranscript({
      messages: transcript(10),
      provider: typesafe,
      fetch: async () => ({ ok: false, status: 500, headers: {}, text: "boom" }),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
    });
    assert.equal(broken.ok, false);
    assert.match(broken.compaction.fallback ?? "", /500/);
  });

  test("no provider is a plain reason", async () => {
    const r = await pruneTranscript({ messages: transcript(1), provider: { ok: false, reason: "no keys" }, fetch: jev([]), sleep: never, timeoutMs: 1, minReduction: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.compaction.fallback, "no keys");
  });
});

describe("compaction settings", () => {
  test("on unless told off", () => {
    assert.equal(compactOnOf(undefined), true);
    assert.equal(compactOnOf("1"), true);
    assert.equal(compactOnOf("0"), false);
    assert.equal(compactOnOf("off"), false);
  });
  test("timeout and minimum reduction", () => {
    assert.equal(compactTimeoutOf(undefined), DEFAULT_COMPACT_TIMEOUT_MS);
    assert.equal(compactTimeoutOf("2500"), 2500);
    assert.equal(compactTimeoutOf("999999"), 30_000);
    assert.equal(minReductionOf(undefined), 0.25);
    assert.equal(minReductionOf("0.4"), 0.4);
    assert.equal(minReductionOf("40%"), 0.4);
    assert.equal(minReductionOf("junk"), 0.25);
  });
});
