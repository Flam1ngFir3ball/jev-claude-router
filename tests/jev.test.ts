import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  askJev,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  requestBodyOf,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
} from "../hooks/jev.ts";
import { labelOf, withLabel } from "../hooks/label.ts";
import { TIERS } from "../hooks/policy.ts";
import type { ProviderResult } from "../hooks/provider.ts";

const never = () => new Promise<never>(() => {});
const immediately = async () => undefined;

const answered = (body: unknown): HttpResponseLike => ({
  ok: true,
  status: 200,
  text: JSON.stringify(body),
});

const gatewayProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "gw-key",
};

const typeafeProvider: ProviderResult = {
  ok: true,
  name: "typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  apiKey: "ts-key",
};

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
};

const base = {
  sleep: never,
  provider: gatewayProvider,
  state: "plan the migration",
  offered: TIERS,
};

describe("jev", () => {
  test("the request names Jev and asks both questions at once", () => {
    const body = requestBodyOf("rename a variable", TIERS);
    assert.equal(body.state, "rename a variable");
    assert.deepEqual(Object.keys(body.questions), ["tier", "effort"]);
    assert.equal(body.questions.tier.type, "choice");
    assert.equal(body.questions.effort.type, "score");
  });

  test("only the offered tiers reach Jev", () => {
    const body = requestBodyOf("x", ["haiku", "opus"]);
    assert.deepEqual(Object.keys(body.questions.tier.criteria), [
      "haiku",
      "opus",
    ]);
  });

  test("the gateway is never asked for a noul, which it refuses", () => {
    const types = Object.values(requestBodyOf("x", TIERS).questions).map(
      (q) => q.type,
    );
    for (const t of types)
      assert.ok(["choice", "score", "boolean"].includes(t));
  });

  test("a good answer comes back as the answers object", async () => {
    const answers = { tier: { type: "choice", choice: "opus" } };
    const got = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev-1.13.0", answers }),
    });
    assert.equal(got.ok, true);
    assert.deepEqual(got.ok && got.answers, answers);
  });

  test("it posts to the gateway with the key as a bearer token", async () => {
    let seen: { url?: string; init?: HttpInitLike } = {};
    await askJev({
      ...base,
      fetch: async (url, init) => {
        seen = { url, init };
        return answered({ answers: {} });
      },
    });
    assert.equal(seen.url, "https://ai-gateway.vercel.sh/v1/evaluate");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.headers?.authorization, "Bearer gw-key");
  });

  test("no key means no request at all", async () => {
    let called = false;
    const got = await askJev({
      ...base,
      provider: noKeyProvider,
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(got.ok, false);
    assert.equal(called, false);
    assert.match(
      got.ok === false ? got.reason : "",
      /no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY/,
    );
  });


  test("a timeout aborts the in-flight fetch", async () => {
    let signal: AbortSignal | undefined;
    const got = await askJev({
      ...base,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return never();
      },
      sleep: immediately,
      timeoutMs: 1,
    });
    assert.equal(got.ok, false);
    assert.equal(signal?.aborted, true);
  });

  test("the caller's signal cancels the in-flight fetch and comes back as ceded", async () => {
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const got = await askJev({
      ...base,
      fetch: async (_url, init) => {
        signal = init?.signal;
        setTimeout(() => controller.abort(), 0);
        return never();
      },
      sleep: never,
      signal: controller.signal,
    });
    assert.equal(got.ok, false);
    assert.equal(signal?.aborted, true, "the fetch's own signal follows the caller's");
    assert.match(got.ok === false ? got.reason : "", /ceded/);
  });

  test("an already-aborted signal is not worth a request at all", async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const got = await askJev({
      ...base,
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
      signal: controller.signal,
    });
    assert.equal(called, false);
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /ceded/);
  });

  test("a slow gateway loses the race and the turn is left alone", async () => {
    const got = await askJev({
      ...base,
      fetch: never,
      sleep: immediately,
      timeoutMs: 1,
    });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /timed out/);
  });

  test("a failure is named, so the session can say why it went unrouted", async () => {
    const reasonOf = (r: Awaited<ReturnType<typeof askJev>>) =>
      r.ok === false ? r.reason : "UNEXPECTEDLY OK";

    const refused = await askJev({
      ...base,
      fetch: async () => ({
        ok: false,
        status: 403,
        text: JSON.stringify({
          error: { type: "customer_verification_required" },
        }),
      }),
    });
    assert.match(
      reasonOf(refused),
      /gateway said HTTP 403 \(customer_verification_required\)/,
    );

    const tsRefused = await askJev({
      ...base,
      provider: typeafeProvider,
      fetch: async () => ({
        ok: false,
        status: 401,
        text: JSON.stringify({ error: { type: "auth" } }),
      }),
    });
    assert.match(reasonOf(tsRefused), /typesafe said HTTP 401 \(auth\)/);

    const threw = await askJev({
      ...base,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.match(reasonOf(threw), /socket hang up/);

    const garbage = await askJev({
      ...base,
      fetch: async () => ({ ok: true, status: 200, text: "not json" }),
    });
    assert.match(reasonOf(garbage), /not JSON/);

    const empty = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev" }),
    });
    assert.match(reasonOf(empty), /no answers/);
  });

  test("an empty prompt is not worth a round trip", async () => {
    let called = false;
    await askJev({
      ...base,
      state: "   ",
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(called, false);
  });

  test("a call is timed, so the status report can show how slow Jev was", async () => {
    let t = 1000;
    const got = await askJev({
      ...base,
      now: () => t,
      fetch: async () => {
        t += 640;
        return answered({
          answers: { tier: { type: "choice", choice: "opus" } },
        });
      },
    });
    assert.equal(got.ms, 640);
  });
});

describe("label", () => {
  const decision = {
    tier: "opus" as const,
    model: "claude-opus-5-5",
    effort: "high" as const,
    confidence: 0.9,
  };

  test("a confident pick reads as tier and effort", () => {
    assert.equal(labelOf(decision, true), "jev: opus, high effort");
  });

  test("an unconfident pick is marked", () => {
    assert.equal(
      labelOf({ ...decision, confidence: 0.2 }, true),
      "jev: opus, high effort, only 20% sure",
    );
  });

  test("routing off says so, and before the first turn nothing is added", () => {
    assert.equal(labelOf(decision, false), "jev off");
    assert.equal(labelOf(null, true), null);
  });

  test("the label joins the engine’s own modes without duplicating", () => {
    assert.deepEqual(withLabel(["plan mode"], "jev off"), [
      "plan mode",
      "jev off",
    ]);
    assert.deepEqual(withLabel(["jev off"], "jev off"), ["jev off"]);
    assert.deepEqual(
      withLabel(["plan mode", "jev → opus·high"], "jev: haiku, low effort"),
      ["plan mode", "jev: haiku, low effort"],
      "an old-style label is cleared too",
    );
    assert.deepEqual(withLabel(["plan mode", "jev → opus·high"], null), [
      "plan mode",
    ]);
  });
});

describe("timeout", () => {
  test("an unset, empty or nonsense budget falls back to the default", () => {
    assert.equal(timeoutOf(undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf(""), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("soon"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("0"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("-5"), DEFAULT_TIMEOUT_MS);
  });

  test("a budget from the environment is used", () => {
    assert.equal(timeoutOf("2500"), 2500);
  });

  test("the default clears the slowest live call measured (839ms)", () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 839);
  });

  test("a budget near the hook's 10s limit is held under it", () => {
    assert.equal(timeoutOf("9500"), MAX_TIMEOUT_MS);
    assert.equal(timeoutOf("60000"), MAX_TIMEOUT_MS);
    assert.ok(MAX_TIMEOUT_MS < 10_000);
  });
});

describe("shortError", () => {
  test("an engine fetch error comes down to a few words", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.equal(
      shortError("jev-claude-router: $.http.fetch(https://127.0.0.1:9/v1/systemone) failed: ECONNREFUSED: ECONNREFUSED: Unable to connect. Is the computer able to access the url?"),
      "ECONNREFUSED: Unable to connect",
    );
    assert.ok(shortError("x".repeat(200)).length <= 60);
  });
});

describe("audit regressions (2026-09-28)", () => {
  const d = { tier: "opus" as const, model: "claude-opus-5-5", effort: "medium" as const, confidence: 0 };
  test("a named tier or a failed Jev call is not shown as 0% sure", () => {
    assert.equal(labelOf({ ...d, forced: true }, true), "jev: opus, medium effort");
    assert.equal(labelOf({ ...d, jevFailed: "timed out after 1500ms" }, true), "jev: opus, medium effort");
    assert.equal(labelOf(d, true), "jev: opus, medium effort, only 0% sure", "a real 0 from Jev still is");
  });
  test("a timeout below 100ms is taken for a mistake, not a budget", () => {
    assert.equal(timeoutOf("1.5"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("99"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("100"), 100);
  });
  test("the provider's error type in a failure reason is short and plain", async () => {
    const provider: ProviderResult = { ok: true, name: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", apiKey: "k" };
    const result = await askJev({
      ...base,
      provider,
      fetch: async () => ({ ok: false, status: 400, headers: {}, text: JSON.stringify({ error: { type: "bad_request\n> ⚠️ " + "x".repeat(200) } }) }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.reason, /\n|⚠️/);
      assert.ok(result.reason.length < 80, result.reason);
    }
  });
});

describe("shortError flattens newlines (2026-09-29)", () => {
  test("an engine error over two lines comes back as one", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.doesNotMatch(shortError("plugin: $.http.fetch(https://x) failed: getaddrinfo ENOTFOUND\n# boom"), /\n/);
  });
});

describe("audit regressions (2026-09-29)", () => {
  const d = { tier: "fable" as const, model: "claude-fable-5-1", effort: "high" as const, confidence: 0.4 };
  test("the label shows no doubt for a held turn or a continued one", () => {
    assert.equal(labelOf({ ...d, held: "haiku" }, true), "jev: fable, high effort");
    assert.equal(labelOf({ ...d, confidence: 0 }, true, "continue"), "jev: fable, high effort");
    assert.equal(labelOf(d, true), "jev: fable, high effort, only 40% sure");
  });
  test("a cut never leaves half an emoji", async () => {
    const { stateOf, MAX_STATE_CHARS } = await import("../hooks/jev.ts");
    const text = `${"a".repeat(MAX_STATE_CHARS - 1)}😀 and more`;
    assert.doesNotMatch(stateOf(text), /[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  test("the timeout's timer is ended once the answer is in", async () => {
    let ended = false;
    const sleep = (_ms: number, o?: { signal?: AbortSignal }) =>
      new Promise<void>((_, reject) => o?.signal?.addEventListener("abort", () => ((ended = true), reject(new Error("aborted")))));
    const got = await askJev({ ...base, sleep, fetch: async () => answered({ answers: { tier: { type: "choice", choice: "opus", confidence: 0.9 } } }) });
    assert.equal(got.ok, true);
    assert.equal(ended, true);
  });
  test("a fetch that throws at once is a failure, not a rejection", async () => {
    const got = await askJev({ ...base, fetch: () => { throw new Error("bad init"); } });
    assert.equal(got.ok, false);
  });
  test("a timeout in hex is refused", () => {
    assert.equal(timeoutOf("0x1F40"), DEFAULT_TIMEOUT_MS);
  });
});

describe("round-3 audit (2026-09-29)", () => {
  test("the question names who wrote the text", () => {
    assert.match(requestBodyOf("x", TIERS).questions.tier.instructions, /A developer typed/);
    assert.match(requestBodyOf("x", TIERS, "task").questions.tier.instructions, /subagent/);
    assert.match(requestBodyOf("x", TIERS, "notification").questions.tier.instructions, /works through the result/);
  });
  test("a timeout is a plain number, as every setting takes: 1e3 is refused, 1000. is not", () => {
    assert.equal(timeoutOf("1e3"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("1000."), 1000);
  });
});

describe("round-4 audit (2026-09-29)", () => {
  test("a fetch that rejects with something that is not an Error is still a named failure", async () => {
    for (const thrown of [Object.create(null), Object.assign(new Error("x"), { message: 42 })]) {
      const got = await askJev({ ...base, fetch: async () => { throw thrown; } });
      assert.equal(got.ok, false);
      if (!got.ok) assert.match(got.reason, /^request failed: /);
    }
  });
});

describe("the footer's doubt follows the continued flag (2026-09-29)", () => {
  test("a notification Jev was asked about shows its doubt; one that continued does not", () => {
    const d = { tier: "opus" as const, model: "claude-opus-5-5", effort: "high" as const, confidence: 0.3 };
    assert.equal(labelOf(d, true, "notify"), "jev: opus, high effort, only 30% sure");
    assert.equal(labelOf(d, true, "notify", true), "jev: opus, high effort");
  });
});
