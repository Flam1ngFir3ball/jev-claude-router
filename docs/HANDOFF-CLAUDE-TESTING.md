# Handoff for Claude — live testing jev-router audit fixes

Branch: `cursor/routing-audit-fixes-d69b`  
Base: `local-tuning` (includes medium/xhigh/max/ultra ceilings from PR #4 work)  
Unit tests: `npm test` (expect green) · `npm run typecheck`

This handoff is what to verify **in a real Claude Code session**. The unit
suite cannot see live Jev latency, cache %, or engine silent-downgrades.

---

## What changed (summary)

| Area | Behavior now |
|------|----------------|
| Sticky | **On by default** at 0.75. Opt out: `/jev sticky off` or `JEV_ROUTER_STICKY=0` |
| Forced override | `"use opus …"` **skips Jev** (0 fetches), effort = **medium**, tag `forced` |
| Jev timeout | Aborts in-flight fetch (`AbortController`) |
| Provider errors | `typesafe said HTTP …` / `gateway said HTTP …` (not always “gateway”) |
| Continuations | Dropped bare `k` / `go` / `next` / `approved` (too eager) |
| SessionMode | Replaces prior `jev → …` / `jev off` crumbs instead of appending |
| Cap commands | `/jev max on` while xhigh off appends a **Note:** that tighter ceiling still binds |
| TYPESAFE_BASE_URL | Only `*.typesafe.ai` unless `JEV_ROUTER_ALLOW_CUSTOM_BASE=1` |
| Overrides kill-switch | `JEV_ROUTER_ALLOW_OVERRIDE=0` |
| Notify soft-continue | Opt-in: `JEV_ROUTER_NOTIFY_CONTINUE=1` |
| Cost model | `npm run measure-switch-cost` (offline). README no longer claims flat 10× |
| Effort ceilings | Default **medium**; raise with medium → xhigh → max → ultra |

---

## Pre-flight

1. Install/link this plugin from the branch (or `claude plugin` validate).
2. Ensure a key is set (`TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`).
3. Run `npm run check-jev` — should print provider + `evaluate ok`.
4. Optional: `npm run measure-switch-cost` and skim break-evens.

Suggested settings for a clean test session:

```json
{
  "env": {
    "JEV_ROUTER_STICKY": "1",
    "JEV_ROUTER_STICKY_CONFIDENCE": "0.75",
    "JEV_ROUTER_MEDIUM_OFF": "0",
    "JEV_ROUTER_XHIGH_OFF": "0",
    "JEV_ROUTER_MAX_OFF": "0",
    "JEV_ROUTER_ULTRA_OFF": "0"
  }
}
```

For default-ceiling tests, **omit** the `*_OFF` keys (medium/xhigh/max/ultra default off).

---

## Manual test matrix

Check each box in the live session. Paste `/jev` output or route lines when something fails.

### A. Sticky default

- [ ] Fresh session, no `JEV_ROUTER_STICKY` set → `/jev` shows sticky **on**, ~75%.
- [ ] `JEV_ROUTER_STICKY=0` → sticky off; shaky tier flips freely.
- [ ] `/jev sticky off` then `/jev sticky` restores a bar.

### B. Forced override (no Jev)

- [ ] After any turn, send `use haiku for this` → route shows `forced`, effort **medium**, and the turn feels instant (no ~400–1500ms Jev wait).
- [ ] `use opus …` while sticky would have held → still opus (not held).
- [ ] `JEV_ROUTER_ALLOW_OVERRIDE=0` → `use opus` is **not** forced; Jev decides.

### C. Continuations

- [ ] After a proposal: `yes` / `ok` / `go ahead` / `lgtm` → `continue`, same tier/effort, no Jev.
- [ ] Bare `k`, `go`, `next`, `approved` → **not** continue (Jev runs or normal route).

### D. Effort ceilings

- [ ] Defaults (no env): `/jev` shows medium/xhigh/max/ultra **off for all**; turns cap at medium.
- [ ] `/jev medium on` then `/jev xhigh on` → xhigh can land.
- [ ] `/jev max on` while xhigh still off → reply includes **Note: xhigh is still off**.
- [ ] `/jev ultra on` while max off → **Note: max is still off** (or xhigh if that’s tighter).
- [ ] Full open path: medium on → xhigh on → max on → ultra on → Jev score 5 can show `ultra` (or engine silent-downgrade — note what API usage reports).

### E. Timeout / errors

- [ ] `JEV_ROUTER_TIMEOUT_MS=1` → turn unrouted with `timed out after 1ms` (fail-open).
- [ ] Bad TypeSafe key → `/jev` / unrouted reason says **`typesafe said HTTP …`**, not gateway.

### F. SessionMode / announce

- [ ] Switch tiers across a few turns; footer/mode strip should show **one** `jev → …`, not a trail of old ones.
- [ ] `/jev quiet` then `/jev loud`.

### G. Subagents

- [ ] Spawn a general-purpose agent; `/jev` shows `[agent:…]` row with its own model.
- [ ] `/jev off` mid-session; resumed agent steps still respect prior spawn decision (or stay on session model if off is authoritative — confirm current behavior).

### H. Notify soft-continue (opt-in)

- [ ] Without env: task-notification wake still classifies (Jev called).
- [ ] With `JEV_ROUTER_NOTIFY_CONTINUE=1` and a prior routed turn: notification turn tagged `continue`, no new Jev call.

### I. Cost / sticky economics (observation)

- [ ] At **small** context (~20–40k): note whether sticky holding fable→haiku looks expensive vs switching (compare cache % and feel). Aligns with measure script (~90k BE for fable→haiku).
- [ ] At **large** context (~100k+): sticky hold should feel more justified.

### J. Ultra / engine boundary

- [ ] With all ceilings open and Jev returning ultra: does the engine accept `effort: ultra`, or silently downgrade? Record usage model + any CLAUDE_EFFORT env.

---

## Known follow-ups (do not block shipping)

1. **Effort-only Jev ask on forced turns** — currently medium always; could ask score-only later.
2. **Fable effort-hold** — Sonnet-only today; measure whether Fable effort flips bust cache.
3. **Separate sticky bar for Sonnet effort** vs tier.
4. **Context-aware sticky** (auto-relax below ~90k) — needs token count at `turn.start`.
5. **Sonnet “$0.12 / half prefix”** anecdote — remeasure if changing effort hold.

---

## Commands cheat sheet

```
/jev                          # status
/jev sticky off|on|0.6
/jev low|medium|xhigh|max|ultra  off|on [tier]
/jev quiet|loud
/jev off|on

npm test
npm run typecheck
npm run check-jev
npm run measure-switch-cost
npm run try-prompts
```

---

## If something fails

Capture: prompt text, `/jev` dump, route line, whether a Jev wait was felt, env vars related to sticky/ceilings. Prefer a minimal repro (2–3 turns).
