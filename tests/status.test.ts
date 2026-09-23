import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  announceReply,
  attemptOf,
  ceilingCommand,
  ceilingLine,
  continuationOf,
  heldMark,
  spawnAttemptOf,
  stickyCommand,
  liveLine,
  REPLY_SEPARATOR,
  statusReport,
  toggleReply,
  type Status,
  addUsage,
  cacheRatio,
  usageFooter,
  type Attempt,
  type Usage,
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

const noKeyProvider: ProviderResult = {
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
  offered: ["haiku", "sonnet", "opus", "fable"],
  excluded: [],
  announce: true,
  attempts: [],
  spent: 0,
};

describe("status report", () => {
  test('the first lines answer "is this even on"', () => {
    const lines = statusReport(base).split("\n");
    assert.match(lines[1] ?? "", /routing\s+on/);
    assert.match(lines[2] ?? "", /surface\s+desktop/);
    assert.match(lines[3] ?? "", /gateway.*AI_GATEWAY_API_KEY is set/);
  });

  test("a missing key is stated loudly, not implied", () => {
    const text = statusReport({ ...base, provider: noKeyProvider });
    assert.match(text, /NO KEYS — nothing will route/);
  });

  test("routing off says how to turn it back on", () => {
    assert.match(statusReport({ ...base, enabled: false }), /off \(\/jev on\)/);
  });

  test("before any turn it says so rather than showing an empty table", () => {
    assert.match(statusReport(base), /No turns yet/);
  });

  test("a routed turn shows tier, effort, confidence and latency", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "plan the migration", ms: 641, decision }],
    });
    assert.match(text, /641ms/);
    assert.match(text, /fable·xhigh 0\.97/);
    assert.match(text, /plan the migration/);
  });

  test("an unrouted turn shows why, which is the whole point", () => {
    const text = statusReport({
      ...base,
      attempts: [
        {
          prompt: "x",
          ms: 12,
          skipped: "gateway said HTTP 403 (customer_verification_required)",
        },
      ],
    });
    assert.match(text, /unrouted — gateway said HTTP 403/);
  });

  test("a low-confidence pick is called out in words, not a symbol", () => {
    const text = statusReport({
      ...base,
      attempts: [
        { prompt: "x", ms: 400, decision: { ...decision, confidence: 0.3 } },
      ],
    });
    assert.match(text, /low confidence/);
  });

  test("excluded tiers are listed only when there are some", () => {
    assert.doesNotMatch(statusReport(base), /excluded/);
    assert.match(
      statusReport({
        ...base,
        excluded: ["fable"],
        offered: ["haiku", "sonnet", "opus"],
      }),
      /excluded\s+fable/,
    );
  });

  test("a long prompt is trimmed so the report stays one screen", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "a".repeat(200), ms: 1, decision }],
    });
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("toggling reports the state it moved to", () => {
    assert.match(toggleReply(true), /on\./);
    assert.match(toggleReply(false), /session model/);
  });
});

describe("live line", () => {
  test("a routed turn is announced with tier, effort, confidence and latency", () => {
    assert.equal(
      liveLine({ prompt: "plan the migration", ms: 641, decision }),
      "> ✳️ `fable` · xhigh · 97% · 641ms",
    );
  });

  test("an unrouted turn announces why, rather than going silent", () => {
    assert.equal(
      liveLine({
        prompt: "x",
        ms: 12,
        skipped: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
      }),
      "> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    );
  });

  test("a shaky pick is marked so a bad route is visible as it happens", () => {
    assert.match(
      liveLine({
        prompt: "x",
        ms: 400,
        decision: { ...decision, confidence: 0.3 },
      }),
      /· 30%\? ·/,
    );
  });

  test("the line is a blockquote with the tier as inline code, since that is what the transcript can colour", () => {
    const line = liveLine({ prompt: "x", ms: 641, decision });
    assert.ok(line.startsWith("> "), line);
    assert.match(line, /`fable`/);
  });

  test("the separator is a rule with a blank line before it, or --- would make the route a heading", () => {
    assert.equal(REPLY_SEPARATOR, "\n\n---\n\n");
  });

  test("the line stays short enough not to wrap", () => {
    const line = liveLine({ prompt: "a".repeat(300), ms: 641, decision });
    assert.ok(line.length < 60, line);
  });

  test("announcing can be turned off without turning routing off", () => {
    assert.match(announceReply(false), /quietly/);
    assert.match(announceReply(true), /announce/);
    assert.match(statusReport({ ...base, announce: false }), /announce\s+off/);
  });
});

describe("attemptOf", () => {
  const offered = ["haiku", "sonnet", "opus", "fable"] as const;
  const skippedOf = (a: ReturnType<typeof attemptOf>) =>
    "skipped" in a ? a.skipped : "UNEXPECTEDLY ROUTED";

  test("a good answer becomes a routed attempt", () => {
    const attempt = attemptOf(
      "plan it",
      {
        ok: true,
        ms: 500,
        answers: { tier: { type: "choice", choice: "fable" } },
      },
      offered,
    );
    assert.equal("decision" in attempt && attempt.decision.tier, "fable");
    assert.equal(attempt.ms, 500);
  });

  test("a failed call keeps its reason, so the line can say why", () => {
    assert.equal(
      skippedOf(
        attemptOf(
          "x",
          { ok: false, ms: 9, reason: "timed out after 1500ms" },
          offered,
        ),
      ),
      "timed out after 1500ms",
    );
  });

  test("an answer naming a tier we did not offer is its own reason", () => {
    assert.match(
      skippedOf(
        attemptOf("x", { ok: true, ms: 5, answers: { tier: {} } }, offered),
      ),
      /named no tier we offered/,
    );
  });

  test("a forced Sonnet turn keeps Jev’s effort even when sticky would hold it", () => {
    const attempt = attemptOf(
      "use sonnet for this",
      {
        ok: true,
        ms: 10,
        answers: {
          tier: { type: "choice", choice: "sonnet", confidence: 0.9 },
          effort: { type: "score", score: 3, confidence: 0.2 },
        },
      },
      offered,
      {
        sticky: 0.75,
        running: {
          tier: "sonnet",
          model: "claude-sonnet-5",
          effort: "low",
          confidence: 0.9,
          effortConfidence: 0.9,
        },
        forced: "sonnet",
      },
    );
    assert.equal("decision" in attempt && attempt.decision.effort, "xhigh");
    assert.equal("decision" in attempt && attempt.decision.forced, true);
    assert.equal(
      "decision" in attempt && attempt.decision.heldEffort,
      undefined,
    );
  });

  test("heldMark stacks every outcome that applied", () => {
    const stacked = heldMark({
      prompt: "x",
      ms: 1,
      decision: {
        tier: "sonnet",
        model: "claude-sonnet-5",
        effort: "low",
        confidence: 0.4,
        held: "haiku",
        heldEffort: "xhigh",
        forced: true,
      },
    });
    assert.equal(stacked, "held:haiku · held-effort:xhigh · forced");
  });
});

describe("usage: what actually answered", () => {
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-fable-5-1",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });

  test("a stop chunk’s usage is kept on the turn", () => {
    const a = routed();
    addUsage(a, usage());
    assert.equal(a.usage?.model, "claude-fable-5-1");
    assert.equal(a.usage?.cache_read_input_tokens, 117_000);
  });

  test("a turn of several steps sums its counts and keeps the last model", () => {
    const a = routed();
    addUsage(a, usage({ input_tokens: 1000, output_tokens: 100 }));
    addUsage(
      a,
      usage({
        input_tokens: 2000,
        output_tokens: 200,
        model: "claude-fable-5-1-later",
      }),
    );
    assert.equal(a.usage?.input_tokens, 3000);
    assert.equal(a.usage?.output_tokens, 300);
    assert.equal(a.usage?.model, "claude-fable-5-1-later");
  });

  test("the cache ratio is what was read over everything the request carried", () => {
    assert.equal(cacheRatio(usage()), 0.9);
    assert.equal(
      cacheRatio(
        usage({
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ),
      0,
    );
  });

  test("the report confirms the model the API says answered", () => {
    const a = routed();
    addUsage(a, usage());
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-fable-5-1 ✓/);
    assert.match(text, /cache 90%/);
    assert.match(text, /130k in/);
  });

  test("a dated id still counts as the model that was asked for", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-fable-5-1-20260901" }));
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /claude-fable-5-1-20260901 ✓/,
    );
  });

  test("a different model answering is flagged, which is the whole point", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-opus-5-5" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-opus-5-5 ≠ claude-fable-5-1/);
    assert.doesNotMatch(text, /✓/);
  });

  test("an unrouted turn still shows what answered, with nothing to check against", () => {
    const a: Attempt = { prompt: "x", ms: 0, skipped: "timed out" };
    addUsage(a, usage({ model: "claude-opus-5-5" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-opus-5/);
    assert.doesNotMatch(text, /[✓≠]/);
  });

  test("a turn with no usage yet gets one line, not a blank second one", () => {
    const lines = statusReport({ ...base, attempts: [routed()] }).split("\n");
    assert.equal(lines.filter((l) => l.includes("answered")).length, 0);
  });

  test("the usage line stays within one screen", () => {
    const a = routed();
    addUsage(
      a,
      usage({
        model: "claude-fable-5-1-20260901-preview",
        cache_read_input_tokens: 1_900_000,
      }),
    );
    for (const line of statusReport({ ...base, attempts: [a] }).split("\n"))
      assert.ok(line.length < 100, line);
  });
});

describe("usage footer", () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-fable-5-1",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });
  const withUsage = (a: Attempt, u = usage()) => {
    addUsage(a, u);
    return a;
  };
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });

  test("a turn with no usage has no footer", () => {
    assert.equal(usageFooter(routed()), null);
  });

  test("it is a fenced block, or markdown eats the indent and joins the lines", () => {
    const lines = usageFooter(withUsage(routed()))!.split("\n");
    assert.equal(lines[0], "```");
    assert.equal(lines.at(-1), "```");
    assert.match(lines[1]!, /^─+$/);
  });

  test("the jev line is what was asked for", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(footer, /jev {2}fable·xhigh · 97% · 641ms/);
  });

  test("the api line is what answered, with the cost", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(
      footer,
      /api {2}claude-fable-5-1 ✓ · cache 90% · 130k in · 1k out/,
    );
  });

  test("a mismatch names both, which is the one case worth looking at", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-opus-5-5" })),
    )!;
    assert.match(footer, /api {2}claude-opus-5-5 ≠ claude-fable-5-1/);
  });

  test("a dated id is still the model that was asked for", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-fable-5-1-20260901" })),
    )!;
    assert.match(footer, /claude-fable-5-1-20260901 ✓/);
  });

  test("an unrouted turn reports what answered, with nothing to compare", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 0,
      skipped: "timed out after 1500ms",
    };
    const footer = usageFooter(
      withUsage(a, usage({ model: "claude-opus-5-5" })),
    )!;
    assert.match(footer, /jev {2}unrouted — timed out after 1500ms/);
    assert.match(footer, /api {2}claude-opus-5-5 · cache 90%/);
    assert.doesNotMatch(footer, /[✓≠]/);
  });

  test("the rule spans the widest line, and nothing wraps", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ cache_read_input_tokens: 1_900_000 })),
    )!;
    const lines = footer.split("\n");
    const rule = lines[1]!;
    const widest = Math.max(...lines.slice(2, -1).map((l) => [...l].length));
    assert.equal([...rule].length, widest);
    for (const line of lines) assert.ok([...line].length < 100, line);
  });
});

describe("turns that are not a typed prompt", () => {
  const notice = `<task-notification>
<task-id>a8fb449ee56c09</task-id>
<status>completed</status>
<summary>Agent "Review library-sync cluster" completed</summary>
</task-notification>`;

  test("a task notification is recognised and its summary kept as the prompt", () => {
    const a = attemptOf(notice, { ok: true, ms: 653, answers: {} as never }, [
      "fable",
    ]);
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, 'Agent "Review library-sync cluster" completed');
  });

  test("a notification without a summary falls back to its id", () => {
    const a = attemptOf(
      "<task-notification><task-id>abc123</task-id></task-notification>",
      { ok: false, ms: 0, reason: "x" },
      ["fable"],
    );
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, "task abc123");
  });

  test("a typed prompt has no kind", () => {
    assert.equal(
      attemptOf("plan it", { ok: false, ms: 0, reason: "x" }, ["fable"]).kind,
      undefined,
    );
  });

  const notify: Attempt = {
    prompt: 'Agent "Review library-sync cluster" completed',
    ms: 653,
    decision,
    kind: "notify",
  };

  test("the live line marks a notification turn, so a wake-up is not read as a reply to the person", () => {
    assert.equal(
      liveLine(notify),
      "> ✳️ `fable` · xhigh · 97% · notify · 653ms",
    );
  });

  test("the history tags it and shows the summary, not the envelope", () => {
    assert.match(
      statusReport({ ...base, attempts: [notify] }),
      /fable·xhigh 0\.97 {2}\[notify\] Agent "Review library-sync cluster" complet/,
    );
  });

  test("the footer’s jev row carries the tag", () => {
    addUsage(notify, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(notify)!,
      /jev {2}fable·xhigh · 97% · notify · 653ms/,
    );
  });

  test("a subagent’s steps are listed as unrouted, under the agent’s name", () => {
    const sub: Attempt = {
      prompt: "Review library-sync cluster",
      ms: 0,
      skipped: "subagent runs on the session model",
      kind: "agent",
      agent: { type: "Explore", label: "Review library-sync cluster" },
    };
    addUsage(sub, {
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const text = statusReport({ ...base, attempts: [sub] });
    assert.match(
      text,
      /unrouted — \[agent:Explore\] Review library-sync cluster/,
    );
    assert.match(text, /answered claude-opus-5-5 {2}cache 0%/);
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
    },
  };

  test("the line says what Jev wanted and did not get", () => {
    assert.equal(
      liveLine(held),
      "> ✳️ `fable` · low · 61% · held:haiku · 512ms",
    );
  });

  test("the history says so too, so a run of holds is visible", () => {
    assert.match(
      statusReport({ ...base, attempts: [held] }),
      /fable·low 0\.61 held:haiku {2}rename/,
    );
  });

  test("the footer carries it", () => {
    addUsage(held, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(held)!,
      /jev {2}fable·low · 61% · held:haiku · 512ms/,
    );
  });

  test("a held turn is not marked low-confidence twice over", () => {
    const line = liveLine(held);
    assert.doesNotMatch(line, /\?/);
  });

  test("the status report says whether stickiness is on", () => {
    assert.match(statusReport(base), /sticky\s+off/);
    assert.match(
      statusReport({ ...base, sticky: 0.75 }),
      /sticky\s+on, switch needs 75%/,
    );
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
    assert.match(r.text, /freely/);
  });

  test("a number sets the bar and turns it on", () => {
    assert.equal(stickyCommand("0.6", null).sticky, 0.6);
    assert.equal(
      stickyCommand("60", null).sticky,
      0.6,
      "a percentage is read as one",
    );
    assert.equal(
      stickyCommand("60%", null).sticky,
      0.6,
      "and so is one with a sign",
    );
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
    const report = statusReport({
      ...base,
      ceiling: { ...ceilingAt("medium"), fable: "xhigh" },
    });
    assert.match(report, /ceiling\s+medium \(fable: xhigh\)/);
    assert.match(report, /cache\s+1h writes · no context yet/);
  });

  test("ceilingLine picks the common effort and lists the rest", () => {
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

  test("a routed turn is capped at its tier's ceiling and tagged", () => {
    const a = attemptOf("plan it", jev("fable", 4), TIERS, {
      sticky: null,
      running: null,
      ceiling: ceilingAt("medium"),
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "medium");
    assert.equal(a.decision.cappedEffort, "max");
    assert.match(liveLine(a), /capped:max/);
  });

  test("a continuation is re-capped, so a change mid-session binds", () => {
    const running = {
      tier: "fable" as const,
      model: "claude-fable-5-1",
      effort: "xhigh" as const,
      confidence: 0.9,
    };
    const a = continuationOf("yes", running, ceilingAt("high"));
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "high");
  });

  test("a subagent is capped too", () => {
    const a = spawnAttemptOf(
      "review it",
      jev("opus", 3),
      TIERS,
      { type: "general-purpose", label: "review it" },
      ceilingAt("medium"),
    );
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "medium");
    assert.equal(a.decision.cappedEffort, "xhigh");
  });

  test("with no ceiling given nothing is capped", () => {
    const a = attemptOf("plan it", jev("fable", 4), TIERS);
    assert.ok("decision" in a);
    assert.equal(a.decision.effort, "max");
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
      running: onFable,
      economics: { contextTokens: 200_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "fable");
    assert.equal(a.decision.held, "haiku");
    assert.equal(a.decision.effort, "low", "Jev's effort still applies");
    assert.match(liveLine(a), /held:haiku·\$4\.41>\$0\.125/);
    assert.match(heldMark(a)!, /^held:haiku·\$/);
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
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: 0.75,
      running: onFable,
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
  });

  test("an upgrade is never priced: capability is Jev's call", () => {
    const onHaiku = { ...onFable, tier: "haiku" as const, model: "claude-haiku-4-5" };
    const a = attemptOf("plan the architecture", jev("fable"), TIERS, {
      sticky: 0.75,
      running: onHaiku,
      economics: { contextTokens: 300_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "fable");
  });

  test("with stickiness off the price is not consulted", () => {
    const a = attemptOf("what is 2+2", jev("haiku"), TIERS, {
      sticky: null,
      running: onFable,
      economics: { contextTokens: 200_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
  });

  test("a forced tier is never held", () => {
    const a = attemptOf("use haiku", { ok: false, ms: 0, reason: "forced" }, TIERS, {
      sticky: 0.75,
      running: onFable,
      forced: "haiku",
      economics: { contextTokens: 200_000, outputTokens: 1500, ttl: "1h" },
    });
    assert.ok("decision" in a);
    assert.equal(a.decision.tier, "haiku");
    assert.equal(a.decision.forced, true);
  });

  test("the status report shows the context and where a downgrade stops paying", () => {
    const routed: Attempt = { prompt: "plan", ms: 300, decision: onFable };
    addUsage(routed, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 1500,
      cache_read_input_tokens: 199_000,
      cache_creation_input_tokens: 0,
    });
    const report = statusReport({
      ...base,
      contextTokens: 200_000,
      attempts: [routed],
    });
    assert.match(report, /cache\s+1h writes · 200k context · fable→haiku pays below \d+k/);
  });
});

describe("dollars", () => {
  const priced: Attempt = {
    prompt: "plan",
    ms: 300,
    decision: {
      tier: "fable",
      model: "claude-fable-5-1",
      effort: "medium",
      confidence: 0.9,
    },
  };

  test("a turn's usage is priced at list, at the session's cache TTL", () => {
    addUsage(priced, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 10_000,
    });
    // 1000·10 + 10000·20 + 200000·0.25 + 2000·50 = 10000+200000+50000+100000 = $0.36
    assert.equal(priced.cost, 0.36);
    assert.match(usageFooter(priced)!, /2k out · \$0\.36/);
    assert.match(statusReport({ ...base, attempts: [priced] }), /2k out {2}\$0\.36/);
  });

  test("a second step adds to the same turn and re-prices the sum", () => {
    addUsage(priced, {
      model: "claude-fable-5-1",
      input_tokens: 0,
      output_tokens: 2000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.equal(priced.cost, 0.46);
  });

  test("a model with no price shows the tokens and no dollars", () => {
    const odd: Attempt = { prompt: "x", ms: 0, skipped: "off" };
    addUsage(odd, {
      model: "<synthetic>",
      input_tokens: 10,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.equal(odd.cost, undefined);
    assert.doesNotMatch(usageFooter(odd)!, /\$/);
  });

  test("the report totals the session", () => {
    assert.match(statusReport({ ...base, spent: 12.345 }), /spent\s+\$12\.35 this session/);
    assert.doesNotMatch(statusReport(base), /spent/);
  });
});
