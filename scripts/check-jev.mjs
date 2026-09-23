/**
 * Checks whether Jev (TypeSafe direct or Vercel AI Gateway) will serve requests.
 *
 *   npm run check-jev
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { providerOf } from "../hooks/provider.ts";

const settings = JSON.parse(
  readFileSync(`${homedir()}/.claude/settings.json`, "utf8"),
);

const env = settings?.env ?? {};
const provider = providerOf({
  TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
  AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
  JEV_ROUTER_PROVIDER: env.JEV_ROUTER_PROVIDER,
  TYPESAFE_BASE_URL: env.TYPESAFE_BASE_URL,
  JEV_ROUTER_ALLOW_CUSTOM_BASE: env.JEV_ROUTER_ALLOW_CUSTOM_BASE,
  JEV_ROUTER_JEV_MODEL: env.JEV_ROUTER_JEV_MODEL,
});

if (!provider.ok) {
  console.error(provider.reason);
  process.exit(1);
}

const fingerprint = createHash("sha256")
  .update(provider.apiKey)
  .digest("hex")
  .slice(0, 12);
console.log(`provider       ${provider.name}`);
console.log(
  `key            ${provider.apiKey.length} chars, sha256[:12]=${fingerprint}`,
);
console.log(`endpoint       ${provider.endpoint}`);

const auth = { authorization: `Bearer ${provider.apiKey}` };

if (provider.name === "gateway") {
  const credits = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
    headers: auth,
  });
  const balance = credits.ok ? await credits.json() : null;
  if (!credits.ok) {
    console.log(
      `credits        HTTP ${credits.status} — the key itself is not being accepted`,
    );
    process.exit(1);
  }
  console.log(
    `credits        balance ${balance.balance}, used ${balance.total_used}`,
  );
}

const body = {
  state: "health check from jev-claude-router",
  model: provider.model,
  questions: {
    tier: {
      type: "choice",
      instructions: "Which model tier should answer a trivial rename?",
      criteria: {
        haiku: "Trivial.",
        sonnet: "Straightforward.",
        opus: "Complex.",
        fable: "Hard reasoning.",
      },
    },
  },
};

const res = await fetch(provider.endpoint, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
const redacted = text.replaceAll(provider.apiKey, "[redacted]");

if (!res.ok) {
  console.log(`evaluate       HTTP ${res.status}`);
  console.log(redacted.slice(0, 500));
  process.exit(1);
}

console.log(`evaluate       ok`);
try {
  const parsed = JSON.parse(text);
  console.log(
    `answers        ${JSON.stringify(parsed.answers ?? parsed).slice(0, 200)}`,
  );
} catch {
  console.log(redacted.slice(0, 200));
}
