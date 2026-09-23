/**
 * Provider resolution: which backend (TypeSafe direct or Vercel AI Gateway)
 * should handle this request, based on available keys and user overrides.
 *
 * Precedence:
 * 1. JEV_ROUTER_PROVIDER=typesafe|gateway forces one (and errors if its key is missing)
 * 2. TypeSafe direct if TYPESAFE_API_KEY is set
 * 3. Gateway if AI_GATEWAY_API_KEY is set
 * 4. Error if neither is set
 *
 * TYPESAFE_BASE_URL overrides the TypeSafe endpoint base (defaults to
 * https://api.typesafe.ai). Only https://api.typesafe.ai and hosts under
 * *.typesafe.ai are accepted unless JEV_ROUTER_ALLOW_CUSTOM_BASE=1.
 */

export type ProviderResult =
  | {
      ok: true;
      name: "typesafe" | "gateway";
      endpoint: string;
      model: string;
      apiKey: string;
    }
  | {
      ok: false;
      reason: string;
    };

export type ProviderEnv = {
  TYPESAFE_API_KEY: string | undefined;
  AI_GATEWAY_API_KEY: string | undefined;
  JEV_ROUTER_PROVIDER: string | undefined;
  TYPESAFE_BASE_URL: string | undefined;
  JEV_ROUTER_ALLOW_CUSTOM_BASE?: string | undefined;
};

const TYPESAFE_BASE_DEFAULT = "https://api.typesafe.ai";
const GATEWAY_BASE = "https://ai-gateway.vercel.sh";

/**
 * Resolves a TypeSafe API base URL. Rejects non-https and unknown hosts
 * unless custom bases are explicitly allowed — otherwise a mistyped or
 * malicious settings value would send the Bearer key elsewhere.
 */
export function typesafeBaseOf(
  raw: string | undefined,
  allowCustom: string | undefined,
): { ok: true; base: string } | { ok: false; reason: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, base: TYPESAFE_BASE_DEFAULT };

  let url: URL;
  try {
    url = new URL(trimmed.replace(/\/$/, ""));
  } catch {
    return { ok: false, reason: "TYPESAFE_BASE_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "TYPESAFE_BASE_URL must use https" };
  }

  const host = url.hostname.toLowerCase();
  const allowed =
    host === "api.typesafe.ai" || host.endsWith(".typesafe.ai");
  const customOk = flagOn(allowCustom);
  if (!allowed && !customOk) {
    return {
      ok: false,
      reason:
        "TYPESAFE_BASE_URL host is not allowlisted; set " +
        "JEV_ROUTER_ALLOW_CUSTOM_BASE=1 to permit it",
    };
  }
  return { ok: true, base: `${url.origin}${url.pathname}`.replace(/\/$/, "") };
}

function flagOn(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

function typesafeProvider(
  apiKey: string,
  env: ProviderEnv,
): ProviderResult {
  const base = typesafeBaseOf(
    env.TYPESAFE_BASE_URL,
    env.JEV_ROUTER_ALLOW_CUSTOM_BASE,
  );
  if (!base.ok) return base;
  return {
    ok: true,
    name: "typesafe",
    endpoint: `${base.base}/v1/systemone`,
    model: "jev-latest",
    apiKey,
  };
}

export function providerOf(env: ProviderEnv): ProviderResult {
  const forced = (env.JEV_ROUTER_PROVIDER ?? "").toLowerCase().trim();

  if (forced === "typesafe") {
    if (!env.TYPESAFE_API_KEY) {
      return {
        ok: false,
        reason: "JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set",
      };
    }
    return typesafeProvider(env.TYPESAFE_API_KEY, env);
  }

  if (forced === "gateway") {
    if (!env.AI_GATEWAY_API_KEY) {
      return {
        ok: false,
        reason: "JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set",
      };
    }
    return {
      ok: true,
      name: "gateway",
      endpoint: `${GATEWAY_BASE}/v1/evaluate`,
      model: "typesafe-ai/jev",
      apiKey: env.AI_GATEWAY_API_KEY,
    };
  }

  if (env.TYPESAFE_API_KEY) {
    return typesafeProvider(env.TYPESAFE_API_KEY, env);
  }

  if (env.AI_GATEWAY_API_KEY) {
    return {
      ok: true,
      name: "gateway",
      endpoint: `${GATEWAY_BASE}/v1/evaluate`,
      model: "typesafe-ai/jev",
      apiKey: env.AI_GATEWAY_API_KEY,
    };
  }

  return {
    ok: false,
    reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
  };
}
