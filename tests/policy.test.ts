import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_STICKY_CONFIDENCE,
  decisionOf,
  effortOf,
  excludedTiers,
  forcedDecision,
  holdsSonnetEffort,
  isContinuation,
  MODEL_OF,
  offeredTiers,
  parseOverride,
  stickyDecision,
  stickyOf,
  SUBAGENT_CONFIDENCE,
  subagentDecision,
  thresholdOf,
  TIERS,
  type Decision,
  type Effort,
} from "../hooks/policy.ts";

const choice = (name: string, confidence = 0.9) => ({
  tier: { type: "choice", choice: name, confidence },
  effort: { type: "score", score: 2 },
});

describe("policy", () => {
  test("a tier Jev picked becomes that tier’s model id", () => {
    const d = decisionOf(choice("fable"));
    assert.equal(d?.tier, "fable");
    assert.equal(d?.model, "claude-fable-5-1");
  });

  test("every tier maps to a model id the engine knows", () => {
    for (const tier of TIERS) {
      assert.match(MODEL_OF[tier], /^claude-(haiku|sonnet|opus|fable)-/);
    }
  });

  test("a score rounds to the nearest effort level", () => {
    assert.equal(effortOf(0), "low");
    assert.equal(effortOf(2.4), "high");
    assert.equal(effortOf(2.6), "xhigh");
    assert.equal(effortOf(4), "max");
  });

  test("a score outside the ladder clamps instead of throwing", () => {
    assert.equal(effortOf(-3), "low");
    assert.equal(effortOf(99), "max");
  });

  test("a missing or unusable score falls back to medium", () => {
    assert.equal(effortOf(undefined), "medium");
    assert.equal(effortOf(Number.NaN), "medium");
    assert.equal(effortOf("high"), "medium");
  });

  test("a tier that was not offered is refused", () => {
    const offered = offeredTiers(excludedTiers("fable"));
    assert.equal(decisionOf(choice("fable"), offered), null);
    assert.equal(decisionOf(choice("opus"), offered)?.tier, "opus");
  });

  test("excluding every tier falls back to the full ladder", () => {
    const offered = offeredTiers(excludedTiers("haiku,sonnet,opus,fable"));
    assert.deepEqual(offered, [...TIERS]);
  });

  test("an unknown name in the exclude list is ignored", () => {
    assert.deepEqual([...excludedTiers("fable, nonsense")], ["fable"]);
    assert.deepEqual([...excludedTiers(undefined)], []);
  });

  test("malformed answers give no decision rather than a wrong one", () => {
    assert.equal(decisionOf(null), null);
    assert.equal(decisionOf({}), null);
    assert.equal(decisionOf({ tier: { type: "score", score: 1 } }), null);
    assert.equal(decisionOf({ tier: { type: "choice" } }), null);
    assert.equal(
      decisionOf({ tier: { type: "choice", choice: "gpt-5" } }),
      null,
    );
  });

  test("a missing confidence reads as no confidence, not as certainty", () => {
    const d = decisionOf({ tier: { type: "choice", choice: "opus" } });
    assert.equal(d?.confidence, 0);
  });
});

describe("sticky routing", () => {
  const at = (
    tier: string,
    effort: Effort = "high",
    confidence = 0.9,
  ): Decision => ({
    tier: tier as Decision["tier"],
    model: MODEL_OF[tier as Decision["tier"]],
    effort,
    confidence,
  });

  test("off by default, so a session routes as it always has", () => {
    assert.equal(stickyOf(undefined), false);
    assert.equal(stickyOf(""), false);
    assert.equal(stickyOf("0"), false);
    assert.equal(stickyOf("false"), false);
  });

  test("the flag is set the ways people actually set flags", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      assert.equal(stickyOf(on), true, on);
    }
  });

  test("the bar has a default and takes one from the environment", () => {
    assert.equal(thresholdOf(undefined), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0.6"), 0.6);
    assert.equal(thresholdOf("60"), 0.6, "a percentage is read as one");
  });

  test("an unusable bar falls back rather than pinning every turn", () => {
    assert.equal(thresholdOf("nonsense"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("-1"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("101"), DEFAULT_STICKY_CONFIDENCE);
  });

  test("the first turn of a session has nothing to hold to", () => {
    const d = stickyDecision(at("haiku", "low", 0.2), null, 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });

  test("a shaky switch is held on the previous tier", () => {
    const d = stickyDecision(at("haiku", "low", 0.6), at("fable"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.model, MODEL_OF.fable);
    assert.equal(
      d.held,
      "haiku",
      "what Jev wanted is kept, for the route line",
    );
  });

  test("a held switch keeps Jev’s effort confidence for Sonnet gating", () => {
    const fresh = {
      ...at("haiku", "high", 0.4),
      effortConfidence: 0.95,
    };
    const d = stickyDecision(fresh, at("sonnet", "low"), 0.75);
    assert.equal(d.tier, "sonnet");
    assert.equal(d.effortConfidence, 0.95);
    assert.equal(
      holdsSonnetEffort(d, at("sonnet", "low"), 0.75),
      false,
      "high effort confidence must still clear the bar after a tier hold",
    );
  });

  test("a confident switch goes through", () => {
    const d = stickyDecision(at("haiku", "low", 0.8), at("fable"), 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });

  test("confidence exactly at the bar switches, so the bar is a minimum", () => {
    assert.equal(
      stickyDecision(at("haiku", "low", 0.75), at("fable"), 0.75).tier,
      "haiku",
    );
  });

  test("effort still moves on a held turn, since it costs no cache", () => {
    const d = stickyDecision(at("haiku", "low", 0.6), at("fable", "max"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "low", "the new effort, on the old model");
  });

  test("the confidence kept is Jev’s own, not the one it cleared", () => {
    assert.equal(
      stickyDecision(at("haiku", "low", 0.6), at("fable"), 0.75).confidence,
      0.6,
    );
  });

  test("staying on the same tier is never a hold, however shaky", () => {
    const d = stickyDecision(at("fable", "low", 0.1), at("fable", "max"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "low");
    assert.equal(d.held, undefined);
  });
});


describe("a bare go-ahead", () => {
  test("is recognised in the forms people type, punctuation and case aside", () => {
    for (const text of [
      "yes",
      "y",
      "Yes.",
      "ok!",
      "OK",
      "okay",
      "k",
      "go ahead",
      "Go ahead.",
      "go ahead,",
      "yes,",
      "ok,",
      "sure,",
      "yes?",
      "continue",
      "proceed",
      "do it",
      "let's do it",
      "yes please",
      "sounds good",
      "lgtm",
      "  sure  ",
    ]) {
      assert.equal(isContinuation(text), true, JSON.stringify(text));
    }
  });

  test("anything that carries a task is not one", () => {
    for (const text of [
      "yes, and also fix the test",
      "ok do something else",
      "continue with the migration",
      "go to the next file",
      "use opus",
      "rename foo to bar",
      "no",
      "",
      "   ",
    ]) {
      assert.equal(isContinuation(text), false, JSON.stringify(text));
    }
  });
});

describe("a tier named in the prompt", () => {
  test("is read from the verbs that mean 'run on'", () => {
    assert.equal(parseOverride("use opus for this"), "opus");
    assert.equal(parseOverride("go with fable, do more research"), "fable");
    assert.equal(parseOverride("switch to haiku"), "haiku");
    assert.equal(parseOverride("run this on sonnet"), "sonnet");
    assert.equal(parseOverride("do it using opus"), "opus");
    assert.equal(parseOverride("go with haiku"), "haiku");
  });

  test("a model id names its tier too", () => {
    assert.equal(parseOverride("use claude-opus-5-5"), "opus");
    assert.equal(parseOverride("switch to claude-haiku-4-5"), "haiku");
  });

  test("case does not matter", () => {
    assert.equal(parseOverride("USE OPUS"), "opus");
    assert.equal(parseOverride("Go With Fable"), "fable");
  });

  test("the tier names as ordinary words are left alone", () => {
    for (const text of [
      "search for opus docs",
      "notes on haiku poetry",
      "write a sonnet",
      "what is the fable about",
      "the opus tier is expensive",
      "for haiku, what is the price",
      "I'm happy with opus so far",
      "compatible with haiku",
      "deal with fable later",
      "I'm using opus for comparison",
      "use sonnet-level thinking",
      "when using sonnet-level caching",
    ]) {
      assert.equal(parseOverride(text), null, text);
    }
  });

  test("negations are skipped and the last affirmative match wins", () => {
    assert.equal(parseOverride("don't use haiku, use opus"), "opus");
    assert.equal(parseOverride("Dont use haiku, use opus"), "opus");
    assert.equal(parseOverride("never use fable for this"), null);
    assert.equal(parseOverride("do not use sonnet"), null);
    assert.equal(parseOverride("not using opus today"), null);
    assert.equal(parseOverride("I don't want to use haiku"), null);
    assert.equal(parseOverride("do not try to use opus"), null);
    assert.equal(parseOverride("never ever use fable"), null);
    assert.equal(parseOverride("I won't use haiku"), null);
    assert.equal(parseOverride("can't use sonnet for this"), null);
    assert.equal(parseOverride("avoid using opus"), null);
    assert.equal(parseOverride("stop using haiku"), null);
    assert.equal(parseOverride("please don't use haiku"), null);
    assert.equal(parseOverride("why not use opus"), "opus");
    assert.equal(parseOverride("don't use haiku use opus"), "opus");
    assert.equal(parseOverride("don't use haiku and use opus"), "opus");
    assert.equal(parseOverride("won't use haiku then use opus"), "opus");
    assert.equal(parseOverride("doesn't use opus"), null);
    assert.equal(parseOverride("didn't use opus"), null);
    assert.equal(parseOverride("shouldn't use opus"), null);
    assert.equal(parseOverride("wouldn't use opus"), null);
    assert.equal(parseOverride("mustn't use opus"), null);
    assert.equal(parseOverride("can not use opus"), null);
    assert.equal(parseOverride("couldn't use opus"), null);
    assert.equal(parseOverride("must not use opus"), null);
    assert.equal(parseOverride("may not use fable"), null);
    assert.equal(parseOverride("stop using haiku and use opus"), "opus");
    assert.equal(parseOverride("avoid using haiku, use opus"), "opus");
    assert.equal(
      parseOverride("please stop using haiku and switch to opus"),
      "opus",
    );
    assert.equal(parseOverride("I don’t want to use haiku"), null); // U+2019
    assert.equal(isContinuation("let’s do it"), true); // U+2019
  });

  test("a tier the environment excluded cannot be named back in", () => {
    const offered = offeredTiers(excludedTiers("fable"));
    assert.equal(parseOverride("use fable", offered), null);
    assert.equal(parseOverride("use opus", offered), "opus");
  });

  test("no name is null, and an unknown name is no name", () => {
    assert.equal(parseOverride("just rename it"), null);
    assert.equal(parseOverride("use gpt-5"), null);
    assert.equal(parseOverride(""), null);
  });

  test("a forced decision takes the tier and keeps Jev’s effort", () => {
    const fresh = decisionOf({
      tier: { type: "choice", choice: "haiku", confidence: 0.43 },
      effort: { type: "score", score: 3, confidence: 0.6 },
    });
    const d = forcedDecision("opus", fresh);
    assert.equal(d.tier, "opus");
    assert.equal(d.model, MODEL_OF.opus);
    assert.equal(d.effort, "xhigh");
    assert.equal(d.confidence, 0.43, "Jev’s number, not a made-up 1.0");
    assert.equal(d.forced, true);
  });

  test("a forced decision needs no answer from Jev at all", () => {
    const d = forcedDecision("sonnet", null);
    assert.equal(d.tier, "sonnet");
    assert.equal(d.effort, "medium");
    assert.equal(d.confidence, 0);
  });
});

describe("effort on Sonnet", () => {
  const on = (
    tier: string,
    effort: Effort,
    effortConfidence: number,
  ): Decision => ({
    tier: tier as Decision["tier"],
    model: MODEL_OF[tier as Decision["tier"]],
    effort,
    confidence: 0.9,
    effortConfidence,
  });

  test("the effort answer’s own confidence is read, not the tier’s", () => {
    const d = decisionOf({
      tier: { type: "choice", choice: "sonnet", confidence: 0.81 },
      effort: { type: "score", score: 2.49, confidence: 0.49 },
    });
    assert.equal(d?.confidence, 0.81);
    assert.equal(d?.effortConfidence, 0.49);
  });

  test("an answer without one reads as no confidence", () => {
    const d = decisionOf({ tier: { type: "choice", choice: "sonnet" } });
    assert.equal(d?.effortConfidence, 0);
  });

  test("a shaky effort change while staying on Sonnet is held", () => {
    assert.equal(
      holdsSonnetEffort(on("sonnet", "high", 0.49), on("sonnet", "low", 0.9), 0.75),
      true,
    );
  });

  test("held in both directions: a rise would ratchet a stretch upward", () => {
    assert.equal(
      holdsSonnetEffort(on("sonnet", "low", 0.49), on("sonnet", "high", 0.9), 0.75),
      true,
    );
  });

  test("a confident change goes through, and the bar is a minimum", () => {
    assert.equal(
      holdsSonnetEffort(on("sonnet", "high", 0.8), on("sonnet", "low", 0.9), 0.75),
      false,
    );
    assert.equal(
      holdsSonnetEffort(on("sonnet", "high", 0.75), on("sonnet", "low", 0.9), 0.75),
      false,
    );
  });

  test("the same effort is nothing to hold", () => {
    assert.equal(
      holdsSonnetEffort(on("sonnet", "high", 0.1), on("sonnet", "high", 0.9), 0.75),
      false,
    );
  });

  test("only Sonnet: the other tiers take effort per request for free", () => {
    assert.equal(
      holdsSonnetEffort(on("opus", "high", 0.1), on("opus", "low", 0.9), 0.75),
      false,
    );
    assert.equal(
      holdsSonnetEffort(on("haiku", "high", 0.1), on("haiku", "low", 0.9), 0.75),
      false,
    );
  });

  test("a turn arriving on Sonnet from elsewhere is a model switch, not this", () => {
    assert.equal(
      holdsSonnetEffort(on("sonnet", "high", 0.1), on("opus", "low", 0.9), 0.75),
      false,
    );
    assert.equal(holdsSonnetEffort(on("sonnet", "high", 0.1), null, 0.75), false);
  });
});

describe("a subagent’s decision", () => {
  const fresh = (confidence: number): Decision => ({
    tier: "haiku",
    model: MODEL_OF.haiku,
    effort: "low",
    confidence,
  });

  test("goes through at the bar and above", () => {
    assert.equal(subagentDecision(fresh(SUBAGENT_CONFIDENCE))?.tier, "haiku");
    assert.equal(subagentDecision(fresh(0.98))?.tier, "haiku");
  });

  test("is dropped below it, leaving the spawn on its own model", () => {
    assert.equal(subagentDecision(fresh(0.22)), null);
    assert.equal(subagentDecision(null), null);
  });

  test("the bar is the one measured to split specified from vague tasks", () => {
    assert.equal(SUBAGENT_CONFIDENCE, 0.5);
  });
});
