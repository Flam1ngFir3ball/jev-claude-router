/**
 * Where a downgrade stops paying, from the same prices and the same sum the
 * router uses (hooks/pricing.ts). No network calls.
 *
 *   npm run measure-switch-cost            # the one-hour cache, which Claude Code writes
 *   npm run measure-switch-cost -- 5m      # the five-minute cache
 *   npm run measure-switch-cost -- 1h 800  # with an 800-token output
 *
 * `stay` is the turn on the running tier with its cache warm; `go` is the
 * same turn on the cheaper tier, cold, plus the write that comes due when
 * the session returns to the tier it left. The router holds the switch when
 * go ≥ stay. Output is the only term the cheaper tier wins on, so the
 * balance tips with context.
 */

import {
  breakEvenTokens,
  PRICE,
  PRICE_DATE,
  switchVerdict,
  usd,
} from "../hooks/pricing.ts";

const ttl = process.argv[2] === "5m" ? "5m" : "1h";
const outTok = Number(process.argv[3]) || 1500;
const contexts = [2, 5, 10, 20, 40, 60, 100, 150, 200, 300].map((k) => k * 1000);
const pairs = [
  ["fable", "opus"],
  ["fable", "sonnet"],
  ["fable", "haiku"],
  ["opus", "sonnet"],
  ["opus", "haiku"],
  ["sonnet", "haiku"],
];

console.log(`Prices $/MTok (input / output / cache read / ${ttl} write), ${PRICE_DATE}`);
for (const [t, p] of Object.entries(PRICE)) {
  const write = ttl === "1h" ? p.write1h : p.write5m;
  console.log(`  ${t.padEnd(6)} ${p.input}/${p.output}  read ${p.read}  write ${write}`);
}
console.log(`\nOutput assumed ${outTok} tokens. A cell is go/stay; ● = held.\n`);

const head = ["ctx".padStart(5), ...pairs.map(([a, b]) => `${a}→${b}`.padStart(16))];
console.log(head.join(" "));
for (const ctx of contexts) {
  const row = [`${ctx / 1000}k`.padStart(5)];
  for (const [from, to] of pairs) {
    const v = switchVerdict(from, to, ctx, outTok, ttl);
    row.push(`${usd(v.go)}/${usd(v.stay)}${v.hold ? "●" : " "}`.padStart(16));
  }
  console.log(row.join(" "));
}

console.log("\nA downgrade pays only below (tokens of context):");
for (const [from, to] of pairs) {
  const be = breakEvenTokens(from, to, outTok, ttl);
  console.log(`  ${`${from}→${to}`.padEnd(14)} ${be === 0 ? "never" : `${Math.round(be / 1000)}k`}`);
}
console.log(`
Measured over a week of this machine's transcripts (2026-09-23): the median
context at a main-thread switch was 150k–330k, and 31 of 38 returns from haiku
to fable paid the full re-write. At those sizes no downgrade pays; the savings
are in effort on the tier already warm, and in subagents, which start cold
either way.`);
