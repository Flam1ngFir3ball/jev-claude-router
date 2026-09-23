import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  baseModel,
  breakEvenTokens,
  fitsWindow,
  isDowngrade,
  PRICE,
  priceOfModel,
  switchVerdict,
  ttlOf,
  usageCost,
  usd,
} from "../hooks/pricing.ts";

describe("pricing", () => {
  test("the list matches Anthropic’s page for the four ladder models", () => {
    // platform.claude.com/docs/en/about-claude/pricing, 2026-09-23
    assert.deepEqual(PRICE.haiku, {
      input: 1,
      write5m: 1.25,
      write1h: 2,
      read: 0.1,
      output: 5,
    });
    assert.deepEqual(PRICE.fable, {
      input: 10,
      write5m: 12.5,
      write1h: 20,
      read: 0.25,
      output: 50,
    });
    assert.equal(PRICE.opus.read, 0.2);
    assert.equal(PRICE.sonnet.write1h, 4);
  });

  test("a dated id, a ladder id and the session model all price", () => {
    assert.equal(priceOfModel("claude-haiku-4-5-20251001"), PRICE.haiku);
    assert.equal(priceOfModel("claude-fable-5-1"), PRICE.fable);
    assert.equal(priceOfModel("claude-opus-5-5"), PRICE.opus);
    assert.equal(priceOfModel("claude-opus-5")?.read, 0.5);
    assert.equal(priceOfModel("<synthetic>"), null);
  });

  test("the one-hour cache is the default, and the only other is five minutes", () => {
    assert.equal(ttlOf(undefined), "1h");
    assert.equal(ttlOf("5m"), "5m");
    assert.equal(ttlOf("anything else"), "1h");
  });

  test("a turn is priced from its four counts, at the session’s cache TTL", () => {
    const usage = {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 10_000,
    };
    // haiku: 1000·1 + 10000·2 + 100000·0.1 + 2000·5 = 1000+20000+10000+10000 = 41000 µ$
    assert.equal(usageCost("claude-haiku-4-5", usage, "1h"), 0.041);
    // 5m writes bill 1.25 instead of 2: 1000+12500+10000+10000
    assert.equal(usageCost("claude-haiku-4-5", usage, "5m"), 0.0335);
    assert.equal(usageCost("<synthetic>", usage), null);
  });

  test("a downgrade is a step down the ladder", () => {
    assert.equal(isDowngrade("fable", "haiku"), true);
    assert.equal(isDowngrade("opus", "sonnet"), true);
    assert.equal(isDowngrade("haiku", "fable"), false);
    assert.equal(isDowngrade("opus", "opus"), false);
  });

  test("at a working context, a downgrade from fable never pays", () => {
    const v = switchVerdict("fable", "haiku", 200_000, 1_500);
    // stay: 200k·0.25 + 1.5k·50 = 0.05 + 0.075 = $0.125
    assert.equal(Math.round(v.stay * 1000) / 1000, 0.125);
    // go: 200k·2 (haiku write) + 1.5k·5 + 200k·20 (fable re-write) = 0.4 + 0.0075 + 4 = $4.41
    assert.equal(Math.round(v.go * 1000) / 1000, 4.408);
    assert.equal(v.hold, true);
  });

  test("at a small context, the cheaper output carries the switch", () => {
    const v = switchVerdict("fable", "haiku", 1_000, 1_500);
    assert.equal(v.hold, false);
  });

  test("the five-minute cache halves the write and moves the bar", () => {
    const oneHour = switchVerdict("fable", "haiku", 3_000, 1_500, "1h");
    const fiveMin = switchVerdict("fable", "haiku", 3_000, 1_500, "5m");
    assert.ok(fiveMin.go < oneHour.go);
  });

  test("the break-even context is where go equals stay", () => {
    const be = breakEvenTokens("fable", "haiku", 1_500);
    assert.ok(be > 0);
    assert.equal(switchVerdict("fable", "haiku", be, 1_500).hold, false);
    assert.equal(switchVerdict("fable", "haiku", be + 50, 1_500).hold, true);
  });

  test("an upgrade has no break-even, since the dearer output never saves", () => {
    assert.equal(breakEvenTokens("haiku", "fable", 1_500), 0);
  });

  test("haiku's window is 200k and the rest take a million", () => {
    assert.equal(fitsWindow("haiku", 150_000), true);
    assert.equal(fitsWindow("haiku", 190_000), false, "headroom for the prompt and the reply");
    assert.equal(fitsWindow("haiku", 300_000), false);
    assert.equal(fitsWindow("sonnet", 300_000), true);
    assert.equal(fitsWindow("fable", 900_000), true);
    assert.equal(fitsWindow("fable", 990_000), false);
  });

  test("the engine's [1m] suffix does not make a different model", () => {
    assert.equal(baseModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
    assert.equal(baseModel("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(baseModel("claude-sonnet-5[1m]"), "claude-sonnet-5");
  });

  test("dollars read at the precision a turn needs", () => {
    assert.equal(usd(4.408), "$4.41");
    assert.equal(usd(0.36), "$0.36");
    assert.equal(usd(0.125), "$0.13");
    assert.equal(usd(0.0235), "$0.024");
    assert.equal(usd(0.0035), "$0.0035");
  });
});
