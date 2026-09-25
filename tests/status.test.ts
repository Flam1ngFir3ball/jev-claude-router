import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  announceReply,
  attemptOf,
  ceilingCommand,
  ceilingLine,
  continuationOf,
  continuationSkipped,
  notificationOf,
  originOf,
  reasonsOf,
  replySummary,
  spawnAttemptOf,
  stickyCommand,
  tiersCommand,
  liveLine,
  REPLY_SEPARATOR,
  statusReport,
  toggleReply,
  type Status,
  addUsage,
  cacheRatio,
  type Attempt,
  type Usage,
  withoutImitations,
  ImitationFilter,
} from "../hooks/status.ts";
import {
  ceilingAt,
  DEFAULT_STICKY_CONFIDENCE,
  TIERS,
} from "../hooks/policy.ts";
import type { ProviderResult } from "../hooks/provider.ts";

const decision = {
  tier: "fable" as const,
  model: "claude-fable-5-1",
  effort: "xhigh" as const,
  confidence: 0.97,
};

const goodProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "test-key",
};

const noProvider: ProviderResult = {
  ok: false,
  reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
};

const base: Status = {
  enabled: true,
  surface: "desktop",
  provider: goodProvider,
  timeoutMs: 1500,
  sticky: null,
  ceiling: ceilingAt("max"),
  ttl: "1h",
  contextTokens: null,
  sessionModel: "claude-opus-5",
  running: null,
  offered: ["haiku", "sonnet", "opus", "fable"],
  excluded: [],
  announce: true,
  attempts: [],
  spent: 0,
};

const usageOf = (
  model: string,
  over: Partial<Usage> = {},
): Usage => ({
  model,
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 200_000,
  cache_creation_input_tokens: 10_000,
  ...over,
});

describe("status report", () => {
  test('the first lines answer "is this even on"', () => {
    const report = statusReport(base);
    assert.match(report, /^\n  routing   on\n  surface   desktop\n  provider  gateway/);
    assert.match(report, /budget\s+1500ms/);
  });

  test("a missing key is stated loudly, not implied", () => {
    assert.match(statusReport({ ...base, provider: noProvider }), /NO KEYS/);
  });

  test("routing off says how to turn it back on", () => {
    assert.match(statusReport({ ...base, enabled: false }), /off \(\/jev on\)/);
  });

  test("before any turn it says so rather than showing an empty table", () => {
    assert.match(statusReport(base), /No turns yet/);
  });

  test("a routed turn shows tier, effort, how sure Jev was, and latency", () => {
    const report = statusReport({
      ...base,
      attempts: [{ prompt: "plan the architecture", ms: 641, decision }],
    });
    assert.match(report, / 641ms  fable·xhigh  Jev 97%  plan the architecture/);
  });

  test("an unrouted turn shows why, which is the whole point", () => {
    const report = statusReport({
      ...base,
      attempts: [{ prompt: "x", ms: 12, skipped: "gateway said HTTP 403 (customer_verification_required)" }],
    });
    assert.match(report, /not routed — gateway said HTTP 403/);
  });

  test("a low-confidence pick says only, in words", () => {
    const report = statusReport({
      ...base,
      attempts: [{ prompt: "x", ms: 1, decision: { ...decision, confidence: 0.3 } }],
    });
    assert.match(report, /Jev 30%/);
  });

  test("excluded tiers are listed only when there are some", () => {
    assert.doesNotMatch(statusReport(base), /excluded/);
    // offered and excluded are always a matched pair in production
    // (register.ts derives offered from excluded via offeredTiers, which
    // falls back to the full ladder if excluded ever named every tier); the
    // excluded line is read off offered, not the raw field, so the fixture
    // keeps them consistent here too.
    assert.match(
      statusReport({ ...base, excluded: ["fable"], offered: ["haiku", "sonnet", "opus"] }),
      /excluded\s+fable/,
    );
    // excluded naming every tier, with offered still the full ladder (the
    // fallback register.ts's offeredTiers already applies): no excluded
    // line, since nothing is actually excluded from what Jev is asked.
    assert.doesNotMatch(
      statusReport({ ...base, excluded: [...TIERS], offered: [...TIERS] }),
      /excluded/,
    );
  });

  test("the session line says what the loop runs and what is warm", () => {
    assert.match(statusReport(base), /session\s+claude-opus-5, nothing routed yet/);
    assert.match(
      statusReport({ ...base, running: decision }),
      /session\s+claude-opus-5, running on fable/,
    );
    assert.match(
      statusReport({ ...base, sessionModel: "claude-fable-5-1", running: decision }),
      /session\s+claude-fable-5-1, still on it/,
    );
    assert.match(statusReport({ ...base, sessionModel: null }), /session\s+unknown/);
  });

  test("a long prompt is trimmed so the report stays one screen", () => {
    const report = statusReport({
      ...base,
      attempts: [{ prompt: "a".repeat(200), ms: 1, decision }],
    });
    for (const line of report.split("\n")) assert.ok(line.length < 120, line);
  });

  test("toggling reports the state it moved to", () => {
    assert.match(toggleReply(true), /on/);
    assert.match(toggleReply(false), /off/);
  });
});

describe("live line", () => {
  test("a routed turn is announced in words: tier, effort, how sure, latency", () => {
    assert.equal(
      liveLine({ prompt: "x", ms: 641, decision }),
      "> ✳️ fable · xhigh · Jev 97% · 641ms",
    );
  });

  test("an unrouted turn announces why, rather than going silent", () => {
    assert.equal(
      liveLine({ prompt: "x", ms: 12, skipped: "gateway said HTTP 403" }),
      "> ⚠️ not routed: gateway said HTTP 403",
    );
  });

  test("a shaky pick says only, so a bad route is visible as it happens", () => {
    assert.match(
      liveLine({ prompt: "x", ms: 1, decision: { ...decision, confidence: 0.3 } }),
      /Jev 30%/,
    );
  });

  test("a forced turn does not claim Jev was sure of anything", () => {
    const line = liveLine({
      prompt: "use opus",
      ms: 0,
      decision: { ...decision, tier: "opus", confidence: 0, forced: true },
    });
    assert.equal(line, "> ✳️ opus · xhigh · your pick · 0ms");
  });

  test("the separator is a rule with a blank line before it, or --- would make the route a heading", () => {
    assert.equal(REPLY_SEPARATOR, "\n\n---\n\n");
  });

  test("the line stays short enough not to wrap", () => {
    assert.ok(liveLine({ prompt: "x", ms: 1234, decision }).length < 80);
  });

  test("announcing can be turned off without turning routing off", () => {
    assert.match(announceReply(false), /quietly/);
    assert.match(announceReply(true), /announce/);
  });
});

describe("attemptOf", () => {
  const good = {
    ok: true as const,
    ms: 300,
    answers: {
      tier: { type: "choice", choice: "opus", confidence: 0.8 },
      effort: { type: "score", score: 2 },
    },
  };

  test("a good answer becomes a routed attempt", () => {
    const a = attemptOf("implement it", good, TIERS);
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "opus");
    assert.equal(a.decision.effort, "high");
    assert.equal(a.ms, 300);
    assert.equal(a.prompt, "implement it");
  });

  test("a failed call keeps its reason, so the line can say why", () => {
    const a = attemptOf("x", { ok: false, reason: "timed out after 1500ms", ms: 1500 }, TIERS);
    assert.ok("skipped" in a);
    assert.equal(a.skipped, "timed out after 1500ms");
  });

  test("an answer naming a tier we did not offer is its own reason", () => {
    const a = attemptOf("x", good, ["haiku", "sonnet"]);
    assert.ok("skipped" in a);
    assert.match(a.skipped, /named no tier we offered/);
  });

  test("a forced Sonnet turn keeps Jev's effort even when sticky would hold it", () => {
    const running = {
      tier: "sonnet" as const,
      model: "claude-sonnet-5",
      effort: "low" as const,
      confidence: 0.9,
    };
    const a = attemptOf(
      "use sonnet",
      {
        ok: true,
        ms: 1,
        answers: {
          tier: { type: "choice", choice: "opus", confidence: 0.9 },
          effort: { type: "score", score: 3, confidence: 0.1 },
        },
      },
      TIERS,
      { sticky: 0.75, running, forced: "sonnet" },
    );
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "sonnet");
    assert.equal(a.decision.effort, "xhigh");
    assert.equal(a.decision.forced, true);
    assert.equal(a.decision.heldEffort, undefined);
  });

  test("reasonsOf lists every outcome that applied, in words", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 1,
      decision: {
        ...decision,
        tier: "sonnet",
        effort: "low",
        held: "haiku",
        heldModel: "claude-haiku-4-5",
        heldEffort: "xhigh",
        effortConfidence: 0.2,
        confidence: 0.61,
        cappedEffort: "max",
      },
    };
    assert.deepEqual(reasonsOf(a), [
      "kept sonnet: Jev 61% on haiku",
      "kept low: Jev 20% on xhigh",
      "capped from max",
    ]);
    assert.deepEqual(reasonsOf({ prompt: "x", ms: 1, decision }), []);
    assert.deepEqual(reasonsOf({ prompt: "x", ms: 1, skipped: "no" }), []);
  });

  test("a first request's effort is explained", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 1,
      decision: { ...decision, effort: "high", askedEffort: "medium" },
    };
    assert.deepEqual(reasonsOf(a), ["1st request runs medium as high"]);
  });

  test("a cap the first request undid is not reported as a cap", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 1,
      decision: { ...decision, effort: "high", cappedEffort: "high", askedEffort: "medium" },
    };
    assert.deepEqual(reasonsOf(a), ["1st request runs medium as high"]);
    const still: Attempt = {
      prompt: "x",
      ms: 1,
      decision: { ...decision, effort: "high", cappedEffort: "max", askedEffort: "medium" },
    };
    assert.deepEqual(reasonsOf(still), ["capped max→medium; 1st request runs it as high"]);
  });
});

describe("usage: what actually answered", () => {
  test("a stop chunk's usage is kept on the turn, priced", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-fable-5-1"));
    assert.equal(a.usage?.model, "claude-fable-5-1");
    assert.equal(a.cost, 0.36);
  });

  test("a turn of several steps sums its counts and keeps the last model", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-fable-5-1"));
    addUsage(a, usageOf("claude-fable-5-1-20260901", { input_tokens: 5 }));
    assert.equal(a.usage?.input_tokens, 1005);
    assert.equal(a.usage?.output_tokens, 4000);
    assert.equal(a.usage?.model, "claude-fable-5-1-20260901");
  });

  test("the cache ratio is what was read over everything the request carried", () => {
    assert.equal(
      cacheRatio({ model: "m", input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }),
      0.9,
    );
    assert.equal(
      cacheRatio({ model: "m", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      0,
    );
  });

  test("the report confirms the model the API says answered, with the dollars", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-fable-5-1"));
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /fable-5-1 ✓ · \$0\.36 · 211k in \(95% cached\) · 2k out/,
    );
  });

  test("a dated id still counts as the model that was asked for", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-fable-5-1-20260901"));
    assert.match(statusReport({ ...base, attempts: [a] }), /fable-5-1 ✓/);
  });

  test("a different model answering is spelled out, which is the whole point", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-opus-5"));
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /opus-5 ⚠ asked fable-5-1/,
    );
  });

  test("an unrouted turn still shows what answered, with nothing to check against", () => {
    const a: Attempt = { prompt: "x", ms: 1, skipped: "off" };
    addUsage(a, usageOf("claude-opus-5"));
    const report = statusReport({ ...base, attempts: [a] });
    assert.match(report, /opus-5 · \$/);
    assert.doesNotMatch(report, /✓|asked for/);
  });

  test("a turn with no usage yet gets one line, not a blank second one", () => {
    const report = statusReport({ ...base, attempts: [{ prompt: "x", ms: 1, decision }] });
    assert.equal(report.split("\n").filter((l) => l.includes("answered")).length, 0);
  });
});

describe("the reply summary", () => {
  const routed = (): Attempt => {
    const a: Attempt = { prompt: "plan it", ms: 641, decision };
    addUsage(a, usageOf("claude-fable-5-1"));
    return a;
  };

  test("a reply with no usage has no summary", () => {
    assert.equal(replySummary([{ prompt: "x", ms: 1, decision }]), null);
    assert.equal(replySummary([]), null);
  });

  test("it is a fenced block, or markdown eats the indent and joins the lines", () => {
    const s = replySummary([routed()])!;
    assert.ok(s.startsWith("```\n"));
    assert.ok(s.endsWith("\n```"));
  });

  test("one turn: the model that answered, how it was chosen, and what it cost", () => {
    const s = replySummary([routed()])!;
    assert.match(s, /fable-5-1 ✓ xhigh · Jev 97% · /);
    assert.match(s, /\$0\.36 · 211k in \(95% cached\) · 2k out/);
    assert.doesNotMatch(s, /Note/);
  });

  test("a mismatch names both, which is the one case worth looking at", () => {
    const a: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(a, usageOf("claude-opus-5"));
    assert.match(replySummary([a])!, /opus-5 ⚠ asked fable-5-1/);
  });

  test("an unrouted reply says so, and what answered", () => {
    const a: Attempt = { prompt: "x", ms: 1, skipped: "typesafe said HTTP 401" };
    addUsage(a, usageOf("claude-opus-5"));
    assert.match(replySummary([a])!, /opus-5 · not routed: typesafe said HTTP 401/);
  });

  test("a reply of several turns is summed and listed, with the wake-ups counted", () => {
    const first = routed();
    const woken: Attempt = {
      prompt: "Agent finished",
      ms: 300,
      kind: "notify",
      decision: { ...decision, tier: "opus", model: "claude-opus-5-5", effort: "high" },
    };
    addUsage(woken, usageOf("claude-opus-5-5", { output_tokens: 500 }));
    const s = replySummary([first, woken])!;
    assert.match(s, /2 turns: fable, opus \(1 woken by tasks\)/);
    // 0.36 + opus: 1000·4 + 10000·8 + 200000·0.2 + 500·20 = 4000+80000+40000+10000 = $0.134
    assert.match(s, /\$0\.49 · 422k in \(95% cached\) · 3k out/);
  });

  test("agents are listed with what they ran on and cost", () => {
    const main = routed();
    const agent: Attempt = {
      prompt: "review it",
      ms: 200,
      kind: "agent",
      agent: { type: "Explore", label: "review it" },
      decision: { ...decision, tier: "haiku", model: "claude-haiku-4-5", effort: "low" },
    };
    addUsage(agent, usageOf("claude-haiku-4-5", { cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 }));
    const s = replySummary([main, agent])!;
    assert.match(s, /agents: Explore haiku-4-5 \$0\.013/);
    assert.match(s, /\$0\.37 · /);
    assert.match(s, /fable-5-1 ✓/, "one main turn still reads as one");
  });

  test("a hold is explained in a note, numbered when the reply has several turns", () => {
    const held = routed();
    if ("decision" in held) {
      held.decision = {
        ...held.decision,
        tier: "fable",
        effort: "low",
        held: "haiku",
        heldModel: "claude-haiku-4-5",
        heldCost: { stay: 0.125, go: 4.41 },
      };
    }
    assert.match(replySummary([held])!, /kept fable: haiku costs \$4\.41 vs \$0\.13/);
    const second = routed();
    assert.match(replySummary([held, second])!, /turn 1: kept fable/);
  });

  test("a go-ahead claims no confidence: Jev was not asked (seen live: 'Jev 0%')", () => {
    const afterForced = continuationOf("yes", { ...decision, confidence: 0, forced: true });
    addUsage(afterForced, usageOf("claude-fable-5-1"));
    const s = replySummary([afterForced])!;
    assert.doesNotMatch(s, /sure/);
    assert.match(s, /^```\nfable-5-1 ✓ xhigh · continuing · \$/);
    assert.doesNotMatch(liveLine(afterForced), /sure/);
  });

  test("✓ holds across the engine's [1m] and a dated id, and not across different models", () => {
    const on1m: Attempt = { prompt: "x", ms: 1, decision: { ...decision, tier: "opus", model: "claude-opus-5-5[1m]" } };
    addUsage(on1m, usageOf("claude-opus-5-5-20260901"));
    assert.match(replySummary([on1m])!, /opus-5-5 ✓/);
    const near: Attempt = { prompt: "x", ms: 1, decision: { ...decision, tier: "opus", model: "claude-opus-5" } };
    addUsage(near, usageOf("claude-opus-5-5"));
    assert.match(replySummary([near])!, /opus-5-5 ⚠ asked opus-5/);
  });

  test("a go-ahead with nothing to continue says so once, not also 'continuing'", () => {
    const skipped = continuationSkipped("yes");
    addUsage(skipped, usageOf("claude-opus-5"));
    const s = replySummary([skipped])!;
    assert.match(s, /not routed: nothing to continue/);
    assert.doesNotMatch(s, /continuing/);
    assert.equal(s.split("\n").length, 3, "one line inside the fence");
  });

  test("an agent line names the model that ran it", () => {
    const main: Attempt = { prompt: "x", ms: 1, decision };
    addUsage(main, usageOf("claude-fable-5-1"));
    const left: Attempt = { prompt: "hi", ms: 0, kind: "agent", agent: { type: "general-purpose", label: "hi" }, skipped: "not routed at spawn" };
    addUsage(left, usageOf("claude-sonnet-5"));
    assert.match(replySummary([main, left])!, /agents: general-purpose sonnet-5 \$/);
  });

  test("a go-ahead and a capped turn are noted; a forced one is not, since you asked", () => {
    const go = continuationOf("yes", decision);
    addUsage(go, usageOf("claude-fable-5-1"));
    assert.match(replySummary([go])!, /continuing/);
    const forced: Attempt = { prompt: "use opus", ms: 0, decision: { ...decision, forced: true } };
    addUsage(forced, usageOf("claude-fable-5-1"));
    assert.doesNotMatch(replySummary([forced])!, /Note/);
    assert.match(replySummary([forced])!, /fable-5-1 ✓ xhigh · your pick · \$/);
    const capped: Attempt = { prompt: "x", ms: 1, decision: { ...decision, effort: "medium", cappedEffort: "max" } };
    addUsage(capped, usageOf("claude-fable-5-1"));
    assert.match(replySummary([capped])!, /capped from max/);
  });

  test("a model with no price shows the tokens and no dollars", () => {
    const odd: Attempt = { prompt: "x", ms: 0, skipped: "off" };
    addUsage(odd, usageOf("<synthetic>"));
    const s = replySummary([odd])!;
    assert.match(s, /211k in/);
    assert.doesNotMatch(s, /\$/);
  });

  test("it is two lines at most for one turn, and no line wraps", () => {
    const held = routed();
    if ("decision" in held) held.decision = { ...held.decision, held: "haiku", heldCost: { stay: 0.13, go: 4.41 } };
    const lines = replySummary([held])!.split("\n").slice(1, -1);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.ok([...l].length < 80, l);
  });
});

describe("turns that are not a typed prompt", () => {
  const envelope =
    '<task-notification>\n<task-id>abc</task-id>\n<summary>Agent "Review cluster" finished</summary>\n</task-notification>';

  test("a task notification is recognised and its summary kept as the prompt", () => {
    assert.equal(notificationOf(envelope), 'Agent "Review cluster" finished');
    assert.equal(notificationOf("plan it"), null);
  });

  test("a notification without a summary falls back to its id", () => {
    assert.equal(
      notificationOf("<task-notification><task-id>abc</task-id></task-notification>"),
      "task abc",
    );
  });

  test("the line and the history say a wake-up is not a reply to the person", () => {
    const a = attemptOf(envelope, { ok: true, ms: 1, answers: { tier: { type: "choice", choice: "opus", confidence: 0.9 } } }, TIERS);
    assert.equal(a.kind, "notify");
    assert.match(liveLine(a), /task finished/);
    assert.match(statusReport({ ...base, attempts: [a] }), /\[task finished\] Agent "Review cluster" finished/);
  });

  test("originOf names each kind in words", () => {
    assert.equal(originOf({ kind: "notify" }), "task finished");
    assert.equal(originOf({ kind: "continue" }), "continuing");
    assert.equal(originOf({ kind: "agent", agent: { type: "Explore", label: "x" } }), "Explore agent");
    assert.equal(originOf({ kind: "agent" }), "agent");
    assert.equal(originOf({}), null);
  });

  test("a subagent's steps are listed under the agent's name", () => {
    const a: Attempt = {
      prompt: "Review cluster",
      ms: 0,
      kind: "agent",
      agent: { type: "general-purpose", label: "Review cluster" },
      skipped: "not routed at spawn",
    };
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /not routed — \[general-purpose agent\] Review cluster · not routed at spawn/,
    );
  });

  test("a go-ahead with nothing to continue says so", () => {
    const a = continuationSkipped("yes");
    assert.equal(a.kind, "continue");
    assert.match(liveLine(a), /nothing to continue/);
  });
});

describe("a held turn", () => {
  const held: Attempt = {
    prompt: "rename the variable",
    ms: 512,
    decision: {
      tier: "fable",
      model: "claude-fable-5-1",
      effort: "low",
      confidence: 0.61,
      held: "haiku",
      heldModel: "claude-haiku-4-5",
    },
  };

  test("the line says what Jev wanted and did not get, in words", () => {
    assert.equal(
      liveLine(held),
      "> ✳️ fable · low · kept fable: Jev 61% on haiku · 512ms",
    );
  });

  test("the history says so too, so a run of holds is visible", () => {
    assert.match(
      statusReport({ ...base, attempts: [held] }),
      /fable·low  kept fable: Jev 61% on haiku  rename/,
    );
  });

  test("a hold on the same rung names the models, since the tier would say nothing", () => {
    const lateral: Attempt = {
      prompt: "x",
      ms: 1,
      decision: {
        tier: "opus",
        model: "claude-opus-5",
        effort: "medium",
        confidence: 0.95,
        held: "opus",
        heldModel: "claude-opus-5-5",
        heldCost: { stay: 0.1, go: 1.6 },
      },
    };
    assert.match(liveLine(lateral), /kept claude-opus-5: claude-opus-5-5 costs \$1\.60 vs \$0\.10/);
  });

  test("the status report says whether stickiness is on, and what an upgrade needs", () => {
    assert.match(statusReport(base), /sticky\s+off/);
    assert.match(
      statusReport({ ...base, sticky: 0.75 }),
      /sticky\s+on, switch needs 75% \(90% up past 100k\)$/m,
    );
    assert.match(
      statusReport({ ...base, sticky: 0.75, upgradeMax: 1, price: true }),
      /price\s+on, a downgrade has to pay, an upgrade may cost \$1\.00 over staying/,
    );
    assert.match(statusReport({ ...base, price: false }), /price\s+off \(\/jev price on\)/);
  });
});

describe("the sticky subcommand", () => {
  test("bare turns it on at the default bar", () => {
    const r = stickyCommand("", null);
    assert.equal(r.sticky, DEFAULT_STICKY_CONFIDENCE);
    assert.match(r.text, /75%/);
  });

  test("bare keeps a bar already set rather than resetting it", () => {
    assert.equal(stickyCommand("", 0.6).sticky, 0.6);
    assert.equal(stickyCommand("on", 0.6).sticky, 0.6);
  });

  test("off turns it off", () => {
    const r = stickyCommand("off", 0.6);
    assert.equal(r.sticky, null);
    assert.match(r.text, /No confidence bar/);
    assert.match(r.text, /price checks/, "says the price checks still apply");
  });

  test("a number sets the bar and turns it on", () => {
    assert.equal(stickyCommand("0.6", null).sticky, 0.6);
    assert.equal(stickyCommand("60", null).sticky, 0.6, "a percentage is read as one");
    assert.equal(stickyCommand("60%", null).sticky, 0.6, "and so is one with a sign");
  });

  test("a bar outside the range is refused, and nothing changes", () => {
    for (const bad of ["0", "1", "100", "-2", "nonsense"]) {
      const r = stickyCommand(bad, 0.6);
      assert.equal(r.sticky, 0.6, bad);
      assert.match(r.text, /between/, bad);
    }
  });

  test("the reply says how to undo it, since the state is invisible otherwise", () => {
    assert.match(stickyCommand("", null).text, /\/jev sticky off/);
    assert.match(stickyCommand("off", 0.6).text, /\/jev sticky/);
  });
});

describe("the ceiling subcommand", () => {
  test("bare reports without changing anything", () => {
    const r = ceilingCommand("", ceilingAt("medium"));
    assert.deepEqual(r.ceiling, ceilingAt("medium"));
    assert.match(r.text, /medium for all/);
  });

  test("an effort raises every tier", () => {
    const r = ceilingCommand("xhigh", ceilingAt("medium"));
    assert.deepEqual(r.ceiling, ceilingAt("xhigh"));
    assert.match(r.text, /xhigh for all/);
  });

  test("an effort and tiers raise only those", () => {
    const r = ceilingCommand("xhigh fable opus", ceilingAt("medium"));
    assert.equal(r.ceiling.fable, "xhigh");
    assert.equal(r.ceiling.opus, "xhigh");
    assert.equal(r.ceiling.haiku, "medium");
    assert.match(r.text, /medium \(opus: xhigh, fable: xhigh\)/);
  });

  test("off lifts every cap, which is max", () => {
    assert.deepEqual(ceilingCommand("off", ceilingAt("medium")).ceiling, ceilingAt("max"));
  });

  test("an unknown effort or tier changes nothing and says so", () => {
    const bad = ceilingCommand("ultra", ceilingAt("medium"));
    assert.deepEqual(bad.ceiling, ceilingAt("medium"));
    assert.match(bad.text, /not an effort/);
    const tier = ceilingCommand("xhigh gpt", ceilingAt("medium"));
    assert.deepEqual(tier.ceiling, ceilingAt("medium"));
    assert.match(tier.text, /"gpt" is not a tier/);
  });

  test("the status report names the ceiling and the cache", () => {
    const report = statusReport({ ...base, ceiling: { ...ceilingAt("medium"), fable: "xhigh" } });
    assert.match(report, /ceiling\s+medium \(fable: xhigh\)/);
    assert.match(report, /cache\s+1h writes · no context yet/);
  });
});

describe("the tiers subcommand", () => {
  test("bare reports every tier offered", () => {
    const r = tiersCommand("", []);
    assert.deepEqual(r.excluded, []);
    assert.match(r.text, /Every tier is offered.*haiku, sonnet, opus, fable/);
  });

  test("off drops a tier; on brings it back", () => {
    const off = tiersCommand("off fable", []);
    assert.deepEqual(off.excluded, ["fable"]);
    assert.match(off.text, /haiku, sonnet, opus offered; fable off/);
    const on = tiersCommand("on fable", off.excluded);
    assert.deepEqual(on.excluded, []);
  });

  test("off takes more than one tier at once", () => {
    const r = tiersCommand("off fable opus", []);
    assert.deepEqual(r.excluded, ["opus", "fable"]);
  });

  test("on with no prior exclusion is a no-op that still reports cleanly", () => {
    const r = tiersCommand("on fable", []);
    assert.deepEqual(r.excluded, []);
  });

  test("setting fable to medium while everything else is high: the motivating case", () => {
    // /jev tiers off fable, or /jev ceiling high then /jev ceiling medium
    // fable, both reachable from the two commands together.
    const off = tiersCommand("off fable", []);
    assert.deepEqual(off.excluded, ["fable"]);
    const ceilingResult = ceilingCommand("high", ceilingAt("medium"));
    const capped = ceilingCommand("medium fable", ceilingResult.ceiling);
    assert.equal(capped.ceiling.fable, "medium");
    assert.equal(capped.ceiling.haiku, "high");
    assert.equal(capped.ceiling.sonnet, "high");
    assert.equal(capped.ceiling.opus, "high");
  });

  test("the last tier standing cannot be turned off", () => {
    const r = tiersCommand("off haiku sonnet opus fable", []);
    assert.equal(r.excluded.length, 3, "one tier was spared");
    assert.ok(!r.excluded.includes("fable"), "the last one named is the one kept on");
    assert.match(r.text, /at least one tier has to stay on/i);
  });

  test("the tier spared is the one actually on, not just the last name typed", () => {
    // Only fable is on (haiku/sonnet/opus already excluded). Naming an
    // already-off tier LAST used to make it the one "kept" — turning the
    // real last-standing tier off and an already-off one back on, backwards
    // from both the request and what the reply claimed happened.
    const onlyFable = ["haiku", "sonnet", "opus"] as const;
    const r = tiersCommand("off fable haiku", onlyFable);
    assert.deepEqual([...r.excluded].sort(), [...onlyFable].sort(), "unchanged: fable stays on, haiku stays off");
    assert.match(r.text, /left fable alone/);

    const r2 = tiersCommand("off fable sonnet", onlyFable);
    assert.deepEqual([...r2.excluded].sort(), [...onlyFable].sort());
    assert.match(r2.text, /left fable alone/);
  });

  test("a bare report describes what is actually offered, even if excluded names every tier (env misconfig; the command itself never reaches this)", () => {
    // JEV_ROUTER_EXCLUDE naming all four tiers reaches tiersReply with
    // excluded = every tier; offeredTiers falls back to the full ladder
    // rather than offering nothing, and the reply must say so instead of
    // claiming every tier is both offered and off.
    const r = tiersCommand("", [...TIERS]);
    assert.match(r.text, /Every tier is offered/);
    assert.doesNotMatch(r.text, /off\./);
  });

  test("off or on alone, with no tier named, changes nothing and says so", () => {
    const bareOff = tiersCommand("off", []);
    assert.deepEqual(bareOff.excluded, []);
    assert.match(bareOff.text, /name at least one tier/i);
    const bareOn = tiersCommand("on", ["fable"]);
    assert.deepEqual(bareOn.excluded, ["fable"], "unchanged, not cleared");
    assert.match(bareOn.text, /name at least one tier/i);
  });

  test("an unknown word or tier changes nothing and says so", () => {
    const bad = tiersCommand("maybe fable", []);
    assert.deepEqual(bad.excluded, []);
    assert.match(bad.text, /not on or off/);
    const tier = tiersCommand("off gpt", []);
    assert.deepEqual(tier.excluded, []);
    assert.match(tier.text, /"gpt" is not a tier/);
  });

  test("the status report names excluded tiers only when there are some", () => {
    assert.doesNotMatch(statusReport(base), /excluded/);
    assert.match(
      statusReport({ ...base, excluded: ["fable"], offered: ["haiku", "sonnet", "opus"] }),
      /excluded\s+fable/,
    );
  });
});

describe("ceilingLine", () => {
  test("picks the common effort and lists the rest", () => {
    assert.equal(ceilingLine(ceilingAt("low")), "low for all");
    assert.equal(
      ceilingLine({ haiku: "low", sonnet: "medium", opus: "medium", fable: "xhigh" }),
      "medium (haiku: low, fable: xhigh)",
    );
  });
});

describe("the ceiling on a turn", () => {
  const jev = (tier: string, score: number) => ({
    ok: true as const,
    ms: 300,
    answers: {
      tier: { type: "choice", choice: tier, confidence: 0.9 },
      effort: { type: "score", score },
    },
  });

  test("a routed turn is capped at its tier's ceiling and says what Jev wanted", () => {
    const a = attemptOf("plan it", jev("opus", 4), TIERS, {
      sticky: null,
      running: null,
      ceiling: ceilingAt("medium"),
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "medium");
    assert.equal(a.decision.cappedEffort, "max");
    assert.match(liveLine(a), /capped from max/);
  });

  test("a continuation is re-capped, so a change mid-session binds", () => {
    const a = continuationOf("yes", decision, ceilingAt("high"));
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "high");
  });

  test("a subagent is capped too", () => {
    const a = spawnAttemptOf("review it", jev("opus", 3), TIERS, { type: "general-purpose", label: "review it" }, ceilingAt("medium"));
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "medium");
    assert.equal(a.decision.cappedEffort, "xhigh");
  });

  test("with no ceiling given nothing is capped", () => {
    const a = attemptOf("plan it", jev("fable", 4), TIERS);
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "max");
  });

  test("a shaky subagent pick says so in words", () => {
    const a = spawnAttemptOf(
      "audit",
      { ok: true, ms: 1, answers: { tier: { type: "choice", choice: "opus", confidence: 0.22 } } },
      TIERS,
      { type: "general-purpose", label: "audit" },
    );
    assert.ok("skipped" in a);
    assert.equal(a.skipped, "Jev 22% on opus, needs 50%");
  });
});

describe("a downgrade held on its price", () => {
  const jev = (tier: string) => ({
    ok: true as const,
    ms: 300,
    answers: {
      tier: { type: "choice", choice: tier, confidence: 0.99 },
      effort: { type: "score", score: 0 },
    },
  });
  const onFable = {
    tier: "fable" as const,
    model: "claude-fable-5-1",
    effort: "xhigh" as const,
    confidence: 0.9,
  };

  test("at a working context the switch is held, whatever Jev's confidence", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: 0.75,
      price: true,
      running: onFable,
      economics: { contextTokens: 150_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "fable");
    assert.equal(a.decision.held, "haiku");
    assert.equal(a.decision.effort, "low", "Jev's effort still applies");
    // stay: 150k·0.25 + 1.5k·50 = 0.0375 + 0.075; go: 150k·2 + 1.5k·5 + 150k·20 = 0.3 + 0.0075 + 3.0
    assert.equal(
      liveLine(a),
      "> ✳️ fable · low · kept fable: haiku costs $3.31 vs $0.11 · 300ms",
    );
  });

  test("at a small context the switch goes through", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: 0.75,
      running: onFable,
      economics: { contextTokens: 1_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
    assert.equal(a.decision.held, undefined);
  });

  test("with nothing known about the context there is nothing to protect", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, { sticky: 0.75, running: onFable });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
  });

  test("an upgrade is never priced: a sure one goes through at any context", () => {
    const onHaiku = { ...onFable, tier: "haiku" as const, model: "claude-haiku-4-5" };
    const a = attemptOf("plan the architecture", jev("fable"), TIERS, {
      sticky: 0.75,
      running: onHaiku,
      economics: { contextTokens: 300_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "fable");
    assert.equal(a.decision.held, undefined);
  });

  test("past 100k an upgrade under 90% is held; below 100k the bar is the bar", () => {
    const onOpus = { ...onFable, tier: "opus" as const, model: "claude-opus-5-5" };
    const shaky = {
      ok: true as const,
      ms: 300,
      answers: {
        tier: { type: "choice", choice: "fable", confidence: 0.82 },
        effort: { type: "score", score: 3 },
      },
    };
    const big = attemptOf("plan it", shaky, TIERS, {
      sticky: 0.75,
      running: onOpus,
      economics: { contextTokens: 250_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in big);
    assert.equal(big.decision.tier, "opus");
    assert.equal(big.decision.held, "fable");
    assert.equal(big.decision.heldCost, undefined, "held on doubt, not price");
    assert.match(liveLine(big), /kept opus: Jev 82% on fable, needs 90%/);
    const small = attemptOf("plan it", shaky, TIERS, {
      sticky: 0.75,
      running: onOpus,
      economics: { contextTokens: 50_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in small);
    assert.equal(small.decision.tier, "fable");
  });

  test("the same rung on a different model is priced too: a session on claude-opus-5 stays there", () => {
    const onSession = { tier: "opus" as const, model: "claude-opus-5", effort: "medium" as const, confidence: 1 };
    const a = attemptOf("implement it", jev("opus"), TIERS, {
      sticky: 0.75,
      price: true,
      running: onSession,
      economics: { contextTokens: 200_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.model, "claude-opus-5");
    assert.equal(a.decision.heldModel, "claude-opus-5-5");
    // stay: 200k·0.5 + 1.5k·25 = 0.1 + 0.0375; go: 200k·8 + 1.5k·20 + 200k·10 = 1.6 + 0.03 + 2.0
    assert.match(liveLine(a), /kept claude-opus-5: claude-opus-5-5 costs \$3\.63 vs \$0\.14/);
    const fresh = attemptOf("implement it", jev("opus"), TIERS, {
      sticky: 0.75,
      running: onSession,
      economics: { contextTokens: 200, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in fresh);
    assert.equal(fresh.decision.model, "claude-opus-5-5", "at a small context the ladder's model wins");
  });

  test("a turn too long for the tier Jev named stays where it is, whatever the price or the ask", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: null,
      running: onFable,
      economics: { contextTokens: 300_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "fable");
    assert.equal(a.decision.heldWindow, 300_000);
    assert.equal(
      liveLine(a),
      "> ✳️ fable · low · kept fable: too long for haiku (300k) · 300ms",
    );
    const forced = attemptOf("use haiku", { ok: false, ms: 0, reason: "forced" }, TIERS, {
      sticky: null,
      running: onFable,
      forced: "haiku",
      economics: { contextTokens: 300_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in forced);
    assert.equal(forced.decision.tier, "fable", "the API would refuse it, so it is not sent");
  });

  test("a turn too long for the tier Jev named, with nothing to stay on, is left to the session model", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: null,
      running: null,
      economics: { contextTokens: 300_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("skipped" in a);
    assert.equal(a.skipped, "too long for haiku (300k)");
  });

  test("the [1m] spelling of the session's model is kept, and is not a switch", () => {
    const on1m = { tier: "opus" as const, model: "claude-opus-5-5[1m]", effort: "medium" as const, confidence: 1 };
    const a = attemptOf("implement it", jev("opus"), TIERS, {
      sticky: 0.75,
      running: on1m,
      economics: { contextTokens: 200_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.model, "claude-opus-5-5[1m]");
    assert.equal(a.decision.held, undefined);
  });

  test("with stickiness off the price is not consulted", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: null,
      running: onFable,
      economics: { contextTokens: 150_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
  });

  test("a forced tier is never held", () => {
    const a = attemptOf("use haiku", { ok: false, ms: 0, reason: "forced" }, TIERS, {
      sticky: 0.75,
      running: onFable,
      forced: "haiku",
      economics: { contextTokens: 150_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
    assert.equal(a.decision.forced, true);
  });

  test("the status report shows the context and where a downgrade stops paying", () => {
    const routed: Attempt = { prompt: "plan", ms: 300, decision: onFable };
    addUsage(routed, usageOf("claude-fable-5-1", { output_tokens: 1500, cache_read_input_tokens: 199_000, cache_creation_input_tokens: 0 }));
    const report = statusReport({ ...base, contextTokens: 200_000, running: onFable, attempts: [routed] });
    assert.match(report, /cache\s+1h writes · 200k context · fable→haiku pays below \d+k/);
  });
});

describe("dollars", () => {
  test("the report totals the session", () => {
    assert.match(statusReport({ ...base, spent: 12.345 }), /spent\s+\$12\.35 this session/);
    assert.doesNotMatch(statusReport(base), /spent/);
  });
});

describe("withoutImitations", () => {
  const footer = "\n\n```\nopus-5-5 ✓ medium · haiku costs $1.77 vs $0.057 · $0.21 · 450k in (99% cached) · 3k out\n```";
  test("drops a summary the model typed at the end of its text", () => {
    assert.equal(withoutImitations(`Merged and pushed.${footer}`), "Merged and pushed.");
  });
  test("drops a summary with notes under its first line", () => {
    const withNotes = "Done.\n\n```\nopus-5-5 ✓ medium · Jev 32% · $0.14 · 351k in (99% cached) · 2k out\nkept opus: Jev 32% on fable, needs 90%\n```\n";
    assert.equal(withoutImitations(withNotes), "Done.");
  });
  test("drops a route line the model typed at the start, with its rule", () => {
    assert.equal(
      withoutImitations("> ✳️ opus · medium · kept opus: Jev 32% on fable, needs 90% · 407ms\n\n---\n\nChecking the store."),
      "Checking the store.",
    );
  });
  test("leaves a line or summary quoted in the middle alone", () => {
    const quoted = `The line reads:\n\n> ✳️ opus · medium · Jev 94% · 353ms\n\nand the summary:${footer}\n\nThat is expected.`;
    assert.equal(withoutImitations(quoted), quoted);
  });
  test("leaves ordinary text and code blocks alone", () => {
    const text = "Run this:\n\n```bash\nnpm test\n```";
    assert.equal(withoutImitations(text), text);
  });
});

describe("ImitationFilter: the same result however the text is split", () => {
  const footer = "\n\n```\nopus-5-5 ✓ medium · Jev 32% · $0.14 · 351k in (99% cached) · 2k out\nkept opus: Jev 32% on fable, needs 90%\n```";
  const cases: [string, string][] = [
    ["> ✳️ opus · medium · kept opus: Jev 32% on fable, needs 90% · 430ms\n\n---\n\nThe restart came back clean.", "The restart came back clean."],
    // The bare form IMITATED_LINE also strips: the rule directly under the
    // line, one newline instead of a blank line before it. A prior version
    // only checked the streaming split against the blank-line form, so a
    // split right after that single newline ("...12ms\n", then "-", then
    // "--\n\n") desynced at the very first "-" and let "---\n\n" leak through
    // as ordinary text (measured 2026-09-24).
    ["> ✳️ opus · medium · 12ms\n---\n\nReal text.", "Real text."],
    [`Merged and pushed.${footer}`, "Merged and pushed."],
    [`> ⚠️ not routed: timeout\n\n---\n\nDone.${footer}\n`, "Done."],
    ["Run this:\n\n```bash\nnpm test\n```\n\nThen check.", "Run this:\n\n```bash\nnpm test\n```\n\nThen check."],
    ["Plain text with `code` and > a quote.", "Plain text with `code` and > a quote."],
    [`Quoted:${footer}\n\nstill talking`, `Quoted:${footer}\n\nstill talking`],
    ["> a real quote\n\nmore", "> a real quote\n\nmore"],
    ["```\nplain block\n```", "```\nplain block\n```"],
  ];
  const run = (text: string, cuts: number[]) => {
    const f = new ImitationFilter<{ kind: "text"; index: number; text: string }>();
    let out = "";
    let from = 0;
    for (const at of [...cuts, text.length]) {
      for (const c of f.push({ kind: "text", index: 0, text: text.slice(from, at) })) out += c.text;
      from = at;
    }
    for (const c of f.end()) out += c.text;
    return out;
  };
  for (const [text, want] of cases) {
    test(JSON.stringify(text.slice(0, 40)), () => {
      assert.equal(run(text, []), want, "whole");
      for (let i = 1; i < text.length; i++) assert.equal(run(text, [i]), want, `split at ${i}`);
      for (let size = 1; size <= 5; size++) {
        const cuts: number[] = [];
        for (let i = size; i < text.length; i += size) cuts.push(i);
        assert.equal(run(text, cuts), want, `pieces of ${size}`);
      }
    });
  }
  test("a new block releases what the last one held", () => {
    const f = new ImitationFilter<{ kind: "text"; index: number; text: string }>();
    const a = f.push({ kind: "text", index: 0, text: "> " });
    assert.deepEqual(a, []);
    const b = f.push({ kind: "text", index: 1, text: "next" });
    assert.deepEqual(b.map((c) => [c.index, c.text]), [[0, "> "], [1, "next"]]);
  });
});

describe("addUsage prices each step at the model that answered it", () => {
  test("a turn whose steps ran on two models", () => {
    const a: Attempt = { prompt: "p", ms: 0, decision: { tier: "opus", model: "claude-opus-5-5", effort: "medium", confidence: 1 } };
    const step = (model: string) => ({ model, input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    addUsage(a, step("claude-fable-5-1"));
    addUsage(a, step("claude-haiku-4-5"));
    assert.equal(a.cost, 50 + 5, "fable's output price for one step, haiku's for the other");
  });
});

describe("ImitationFilter: every summary shape the plugin writes", () => {
  test("a copied multi-turn or unrouted summary is dropped too", () => {
    for (const head of [
      "3 turns: fable, opus, fable (2 woken by tasks) · $28.10 · 7.4M in (99% cached) · 61k out",
      "opus-5-5 · not routed: timed out after 1500ms · $3.84 · 5.3M in (94% cached) · 14k out",
    ]) {
      const text = `Done.\n\n\`\`\`\n${head}\n\`\`\``;
      assert.equal(withoutImitations(text), "Done.");
      const f = new ImitationFilter<{ kind: "text"; index: number; text: string }>();
      let out = "";
      for (let i = 0; i < text.length; i += 4) for (const c of f.push({ kind: "text", index: 0, text: text.slice(i, i + 4) })) out += c.text;
      for (const c of f.end()) out += c.text;
      assert.equal(out, "Done.");
    }
  });
});

describe("ImitationFilter: a summary quoted early in a block still streams", () => {
  test("a closed summary-shaped fence followed by text is released as it arrives", () => {
    const f = new ImitationFilter<{ kind: "text"; index: number; text: string }>();
    const text = "Here is what /jev showed:\n\n```\nopus-5-5 ✓ medium · Jev 90% · $0.10 · 10k in (90% cached) · 1k out\n```\n\nSo the cache is warm. More follows here.";
    let out = "";
    for (let i = 0; i < text.length; i += 6) for (const c of f.push({ kind: "text", index: 0, text: text.slice(i, i + 6) })) out += c.text;
    assert.ok(out.includes("So the cache is warm."), `streamed before the block ended: ${JSON.stringify(out.slice(-60))}`);
    for (const c of f.end()) out += c.text;
    assert.equal(out, text);
  });
});
