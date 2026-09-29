/**
 * Tests for provider resolution: which backend (TypeSafe direct or Vercel
 * Gateway) should be used, based on available keys and user overrides.
 */

import assert from "assert";
import { describe, it } from "node:test";

import { providerOf, typesafeBaseOf } from "../hooks/provider.ts";

describe("providerOf", () => {
  it("prefers TypeSafe direct when TYPESAFE_API_KEY is set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("falls back to gateway when only AI_GATEWAY_API_KEY is set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("returns error when no keys are set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    });
  });

  it("respects JEV_ROUTER_PROVIDER=typesafe override", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "typesafe",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("respects JEV_ROUTER_PROVIDER=gateway override", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "gateway",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("errors when forced provider=typesafe but key is missing", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "typesafe",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set",
    });
  });

  it("errors when forced provider=gateway but key is missing", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: "gateway",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set",
    });
  });

  it("applies TYPESAFE_BASE_URL override when custom bases are allowed", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
      JEV_ROUTER_ALLOW_CUSTOM_BASE: "1",
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.example.com/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("refuses a foreign TYPESAFE_BASE_URL without an allow", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
    });

    assert.equal(provider.ok, false);
  });

  it("ignores TYPESAFE_BASE_URL when provider is gateway", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("ignores unrecognised JEV_ROUTER_PROVIDER value and uses defaults", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "unknown",
      TYPESAFE_BASE_URL: undefined,
    });

    // Falls back to default precedence (TypeSafe wins)
    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });
});

describe("TYPESAFE_BASE_URL allowlist", () => {
  it("default and typesafe.ai hosts are allowed", () => {
    assert.equal(typesafeBaseOf(undefined, undefined).ok, true);
    assert.equal(
      typesafeBaseOf("https://api.typesafe.ai", undefined).ok,
      true,
    );
    assert.equal(
      typesafeBaseOf("https://staging.typesafe.ai", undefined).ok,
      true,
    );
  });

  it("foreign hosts need an explicit allow", () => {
    const blocked = typesafeBaseOf("https://evil.example", undefined);
    assert.equal(blocked.ok, false);
    const allowed = typesafeBaseOf("https://evil.example", "1");
    assert.equal(allowed.ok, true);
  });

  it("http is refused", () => {
    assert.equal(typesafeBaseOf("http://api.typesafe.ai", "1").ok, false);
  });
});

describe("audit regressions (2026-09-28)", () => {
  it("a whitespace-only TypeSafe key does not beat a real gateway key, and a key is trimmed", () => {
    const p = providerOf({ TYPESAFE_API_KEY: "  ", AI_GATEWAY_API_KEY: "gw-key\n", JEV_ROUTER_PROVIDER: undefined, TYPESAFE_BASE_URL: undefined });
    assert.ok(p.ok);
    if (p.ok) {
      assert.strictEqual(p.name, "gateway");
      assert.strictEqual(p.apiKey, "gw-key");
    }
  });
  it("a base that already ends in the endpoint's path is not doubled", () => {
    for (const raw of ["https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/systemone/"]) {
      const b = typesafeBaseOf(raw, undefined);
      assert.deepStrictEqual(b, { ok: true, base: "https://api.typesafe.ai" }, raw);
    }
    assert.deepStrictEqual(typesafeBaseOf("https://proxy.typesafe.ai/jev", undefined), { ok: true, base: "https://proxy.typesafe.ai/jev" });
  });
});

describe("JEV_ROUTER_PROVIDER's other names (2026-09-29)", () => {
  it("vercel means the gateway, direct means TypeSafe", () => {
    const env = { TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gw", TYPESAFE_BASE_URL: undefined };
    const v = providerOf({ ...env, JEV_ROUTER_PROVIDER: "vercel" });
    assert.ok(v.ok && v.name === "gateway");
    const d = providerOf({ ...env, JEV_ROUTER_PROVIDER: "direct" });
    assert.ok(d.ok && d.name === "typesafe");
  });
});
