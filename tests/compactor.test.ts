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
    assert.equal(compactTimeoutOf("999999"), 8_000, "under the hook's own 10s budget");
    assert.equal(minReductionOf(undefined), 0.25);
    assert.equal(minReductionOf("0.4"), 0.4);
    assert.equal(minReductionOf("40%"), 0.4);
    assert.equal(minReductionOf("junk"), 0.25);
  });
});

describe("a timed-out scoring", () => {
  test("aborts the requests it started", async () => {
    let signal: AbortSignal | undefined;
    await pruneTranscript({
      messages: transcript(10),
      provider: typesafe,
      fetch: (_u, init) => {
        signal = init?.signal;
        return new Promise<never>(() => {});
      },
      sleep: async () => undefined,
      timeoutMs: 10,
      minReduction: 0.25,
    });
    assert.equal(signal?.aborted, true);
  });
});

describe("minReductionOf: a percentage sign means a percentage (2026-09-28)", () => {
  test("1% and 0.5% are hundredths, not the whole transcript or half of it", () => {
    assert.equal(minReductionOf("1%"), 0.01);
    assert.equal(minReductionOf("0.5%"), 0.005);
    assert.equal(minReductionOf("40 %"), 0.4);
    assert.equal(minReductionOf("100"), 1);
    assert.equal(minReductionOf("%"), 0.25);
  });
});

describe("pruneTranscript: what /jev counts and what the engine gets back (2026-09-29)", () => {
  // Every call kept, every result marked for cutting.
  const cutResults = async (_url: string, init?: { body?: string }) => {
    const questions = JSON.parse(init?.body ?? "{}").questions as Record<string, unknown>;
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { noul: name.startsWith("call_") ? 0.9 : 0.1 };
    return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
  };
  const mixed = () => {
    const t = transcript(10);
    for (const m of t) for (const r of m.toolResults ?? []) if (Number(r.tool_use_id.slice(1)) % 2 === 0) r.text = "short";
    return t;
  };
  test("a short result marked for cutting, and so left whole, is not counted as cut", async () => {
    const input = mixed();
    const r = await pruneTranscript({ messages: input, provider: typesafe, fetch: cutResults, sleep: never, timeoutMs: 8000, minReduction: 0, options: { preserveRecentMessages: 2 } });
    assert.ok(r.ok);
    if (!r.ok) return;
    const inputResults = new Set(input.flatMap((m) => m.toolResults ?? []));
    const changed = r.messages.flatMap((m) => m.toolResults ?? []).filter((x) => !inputResults.has(x)).length;
    assert.equal(r.compaction.calls.cut, changed);
    assert.ok(changed < 10, `only the long ones changed: ${changed}`);
  });
  test("a rebuilt result keeps isError: false, which the engine's type requires", async () => {
    const r = await pruneTranscript({ messages: transcript(10), provider: typesafe, fetch: cutResults, sleep: never, timeoutMs: 8000, minReduction: 0, options: { preserveRecentMessages: 2 } });
    assert.ok(r.ok);
    if (!r.ok) return;
    const rebuilt = r.messages.filter((m) => m.handle === undefined).flatMap((m) => m.toolResults ?? []);
    assert.ok(rebuilt.length > 0);
    for (const x of rebuilt) assert.equal(x.isError, false);
  });
  test("the timeout's timer is ended once the scoring is in", async () => {
    let ended = false;
    const sleep = (_ms: number, o?: { signal?: AbortSignal }) =>
      new Promise<void>((_, reject) => o?.signal?.addEventListener("abort", () => ((ended = true), reject(new Error("aborted")))));
    await pruneTranscript({ messages: transcript(3), provider: typesafe, fetch: jev(["t1"]), sleep, timeoutMs: 8000, minReduction: 0 });
    assert.equal(ended, true);
  });
  test("a provider's error text is kept as plain words", async () => {
    const r = await pruneTranscript({
      messages: transcript(3),
      provider: typesafe,
      fetch: async () => ({ ok: false, status: 422, headers: {}, text: "**bad** [click](https://x.example) <b>x</b>" }),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0,
      options: { preserveRecentMessages: 0 },
    });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.compaction.fallback ?? "", /[*\[\]()<>]/);
  });
});

describe("compactTimeoutOf: seconds written by mistake (2026-09-29)", () => {
  test("below 500ms, or not a plain number, is the default", () => {
    assert.equal(compactTimeoutOf("8"), DEFAULT_COMPACT_TIMEOUT_MS);
    assert.equal(compactTimeoutOf("0x1F40"), DEFAULT_COMPACT_TIMEOUT_MS);
    assert.equal(compactTimeoutOf("2000"), 2000);
  });
});

describe("compactTimeoutOf: a small budget is honoured (2026-09-29)", () => {
  test("300 is 300; 8 is a slip for seconds", () => {
    assert.equal(compactTimeoutOf("300"), 300);
    assert.equal(compactTimeoutOf("8"), DEFAULT_COMPACT_TIMEOUT_MS);
  });
});

describe("pruneTranscript never rejects (2026-09-29)", () => {
  test("a fetch that rejects with a bare object falls back with a reason", async () => {
    const r = await pruneTranscript({ messages: transcript(3), provider: typesafe, fetch: async () => { throw Object.create(null); }, sleep: never, timeoutMs: 8000, minReduction: 0, options: { preserveRecentMessages: 0 } });
    assert.equal(r.ok, false);
    assert.equal(typeof r.compaction.fallback, "string");
  });
});

describe("minReductionOf takes plain decimals only (2026-09-29)", () => {
  test("hex and exponents are refused", () => {
    assert.equal(minReductionOf("0x19"), 0.25);
    assert.equal(minReductionOf("0x1"), 0.25);
    assert.equal(minReductionOf("1e1"), 0.25);
    assert.equal(minReductionOf("30"), 0.3);
  });
});

describe("shortOf never contradicts itself (2026-09-29)", async () => {
  const { shortOf } = await import("../hooks/compactor.ts");
  test("just under the bar reads under it", () => {
    assert.equal(shortOf(0.2496, 0.25), "only 24% removed, needs 25%");
  });
});

describe("shortOf rounds down without float error (2026-09-29)", async () => {
  const { shortOf } = await import("../hooks/compactor.ts");
  test("0.29 is 29%", () => {
    assert.equal(shortOf(0.29, 0.3), "only 29% removed, needs 30%");
  });
  test("a bar between whole percents is shown rounded up", () => {
    assert.equal(shortOf(0.252, 0.254), "only 25% removed, needs 26%");
    assert.equal(shortOf(0.002, 0.004), "only 0% removed, needs 1%");
    assert.equal(shortOf(0.25 - 1e-12, 0.25), "only 24% removed, needs 25%");
  });
});

describe("the kept count includes calls kept for being recent (2026-09-29)", () => {
  test("calls kept + cut + dropped is every tool call", async () => {
    const input = transcript(10);
    const r = await pruneTranscript({
      messages: input,
      provider: typesafe,
      fetch: jev([]),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
      options: { preserveRecentMessages: 6 },
    });
    assert.ok(r.ok, JSON.stringify(r.compaction));
    if (!r.ok) return;
    const { kept, cut, dropped } = r.compaction.calls;
    assert.equal(kept + cut + dropped, 10);
    const left = r.messages.flatMap((m) => m.toolUses).length;
    assert.equal(kept + cut, left, "every call still in the transcript is counted as kept or cut");
  });
});

describe("what compaction sends and says (2026-09-29)", () => {
  test("a notification in the transcript is sent by its summary, never its result", async () => {
    const input = transcript(10);
    input.splice(1, 0, {
      role: "user",
      text: '<task-notification>\n<task-id>a1</task-id>\n<summary>Agent "reader" completed</summary>\n<result>AWS_SECRET_KEY=abc123</result>\n</task-notification>',
      toolUses: [],
      handle: "hn",
    });
    const bodies: string[] = [];
    const inner = jev(["t1"]);
    const r = await pruneTranscript({
      messages: input,
      provider: typesafe,
      fetch: async (url: string, init?: { body?: string }) => (bodies.push(init?.body ?? ""), inner(url, init)),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
      options: { preserveRecentMessages: 2 },
    });
    assert.ok(bodies.length > 0);
    for (const b of bodies) assert.doesNotMatch(b, /AWS_SECRET/);
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.messages.some((m) => m.text.includes("AWS_SECRET")), "the transcript itself keeps it");
  });
  test("an error quoting the key or escape sequences is shown without them", async () => {
    const r = await pruneTranscript({
      messages: transcript(10),
      provider: typesafe,
      fetch: async () => {
        throw new Error('Headers.append: "Bearer ts_live_9f8e7d6c" is invalid \u001b]52;c;ZWNobw==\u0007');
      },
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
    });
    assert.equal(r.ok, false);
    assert.ok(!r.compaction.fallback!.includes("ts_live"), r.compaction.fallback);
    assert.doesNotMatch(r.compaction.fallback!, /[\u0000-\u001f\u007f]/);
  });
});

describe("compaction's fallback shows no provider body (2026-09-29)", () => {
  test("a 401 that echoes the key shows the status and error type", async () => {
    const r = await pruneTranscript({
      messages: transcript(10),
      provider: typesafe,
      fetch: async () => ({ ok: false, status: 401, headers: {}, text: JSON.stringify({ error: { type: "authentication_error", message: "Invalid API key tsk-9f8e7d6c5b4a" } }) }),
      sleep: never,
      timeoutMs: 8000,
      minReduction: 0.25,
    });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.compaction.fallback!, /tsk-/);
    assert.match(r.compaction.fallback!, /HTTP 401/);
  });
  test("a fallback restored from the store is shown as plain words", () => {
    const line = compactionLine({ at: 0, kept: 1, of: 1, reduction: 0, calls: { kept: 0, cut: 0, dropped: 0 }, ms: 5, fallback: "x\u001b]52;c;Zm9v\u0007\n```\n<img src=x>" });
    assert.doesNotMatch(line, /[\u0000-\u001f`<>]/);
  });
});
