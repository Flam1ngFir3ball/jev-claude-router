/**
 * Cache-switch break-even model from Anthropic public pricing.
 * No network calls. Run: node scripts/measure-switch-cost.mjs
 *
 * Prices checked 2026-09-23 against platform.claude.com/docs pricing.
 * Opus row is Opus 5.5 ($4/$20, cache read $0.20 = 5%).
 * Fable cache read $0.25 = 2.5%.
 */

const PRICE = {
  haiku: { in: 1, out: 5, cacheRead: 0.1, write5m: 1.25 },
  sonnet: { in: 2, out: 10, cacheRead: 0.2, write5m: 2.5 },
  opus: { in: 4, out: 20, cacheRead: 0.2, write5m: 5 },
  fable: { in: 10, out: 50, cacheRead: 0.25, write5m: 12.5 },
};

const contexts = [20, 30, 45, 58, 80, 100, 130].map((k) => k * 1000);
const outTok = 2000;

function usd(n) {
  return `$${n.toFixed(4)}`;
}

console.log("Prices $/MTok (in / out / cacheRead / 5m write)");
for (const [t, p] of Object.entries(PRICE)) {
  console.log(
    `  ${t.padEnd(6)} ${p.in}/${p.out}  read ${p.cacheRead}  write ${p.write5m}`,
  );
}

console.log(
  `\nFable (warm) → cheaper tier: switch turn pays 5m write on full context; stay pays cache read.`,
);
console.log(`Output assumed ${outTok} tokens.\n`);
console.log(
  "ctx    stay-fable  →opus switch  BE+   →sonnet switch  BE+   →haiku switch  BE+",
);
console.log("─────  ──────────  ────────────  ────  ──────────────  ────  ─────────────  ────");

for (const Ctok of contexts) {
  const C = Ctok / 1e6;
  const O = outTok / 1e6;
  const stay = PRICE.fable.cacheRead * C + PRICE.fable.out * O;
  const cells = ["opus", "sonnet", "haiku"].map((to) => {
    const sw = PRICE[to].write5m * C + PRICE[to].out * O;
    const perTo = PRICE[to].cacheRead * C + PRICE[to].out * O;
    const save = stay - perTo;
    const upfront = sw - stay;
    const be =
      save <= 0 ? "∞" : String(Math.max(0, Math.ceil(upfront / save)));
    return { sw, be };
  });
  console.log(
    `${String(Ctok / 1000).padStart(4)}k  ${usd(stay).padStart(10)}  ` +
      `${usd(cells[0].sw).padStart(12)}  ${cells[0].be.padStart(4)}  ` +
      `${usd(cells[1].sw).padStart(14)}  ${cells[1].be.padStart(4)}  ` +
      `${usd(cells[2].sw).padStart(13)}  ${cells[2].be.padStart(4)}`,
  );
}

console.log(`
BE+ = additional warm turns on the cheaper tier needed to amortize the switch.
Negative upfront (haiku at small/medium ctx) means the switch turn itself is cheaper.

Sticky hold of fable when Jev wants haiku SAVES money on the switch turn only
above ~100k context (with these assumptions). Below that, holding is a cost.
`);
