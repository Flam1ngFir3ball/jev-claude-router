# Changelog

## 1.0.1 — 2026-09-24

Fixes found by two rounds of fresh audits after 1.0.0 shipped:

- **Session spend total.** A step whose model couldn't be priced (a
  synthetic or unrecognized model) either subtracted a previous step's
  already-billed cost from the session total, or — if it was the *first*
  step of a turn — caused every later priced step in that turn to add
  nothing, dropping the whole turn from `/jev`'s spend figure.
- **Negation parsing.** `parseOverride` recognized `shouldn't`/`wouldn't`/
  `couldn't`/`won't` but not their spaced equivalents (`should not`,
  `would not`, `could not`, `will not`); a sentence like "we should not use
  haiku for this" forced the very tier it refused.
- **Streamed route-line stripping.** A route line the model copied from its
  own past reply, with no blank line before its `---` rule, could desync
  from the streaming filter's wait check at the very first `-` character
  and leak the tail of the rule into the real reply.
- **Turn-claim collision.** Two different, unrelated warm sessions that
  happened to report the same context-token count for the same short
  prompt within the 60-second claim window would cede to each other,
  leaving one of them unrouted. The session id is now always part of the
  claim key.
- **Compaction batch concurrency.** A concurrency-limiting helper added to
  cap parallel Jev calls during compaction had a bookkeeping bug that let
  it grow unbounded after the first batch settled — measured at 7 of 8
  batches in flight instead of 2.
- **Decision confidence.** Clamped to 0–1 at the source; an out-of-range
  value from the provider would previously route live and then have the
  whole cached decision silently dropped on the next reload, since restore
  validation (rightly) rejects one outside that range.
- Removed `docs/HANDOFF-CLAUDE-TESTING.md` (internal testing notes that had
  leaked into the public release) and cleared the compaction prune cache on
  `/clear` (a stale score from the previous conversation could otherwise be
  reused).

428 tests, up from 417 at 1.0.0.

## 1.0.0 — 2026-09-23

The first release of this fork of
[satviksinha/jev-model-router](https://github.com/satviksinha/jev-model-router).
It routes every Claude Code turn with [Jev](https://docs.typesafe.ai), weighs
each switch against what it costs, and compacts with Jev instead of a lossy
summary. See the [README](README.md) for how each feature works.

### Routing

- **Per-turn routing.** Jev picks a tier (haiku, sonnet, opus, fable) and an
  effort for every prompt in one request; each model request in the turn is
  rewritten to match.
- **Confidence bar.** A switch needs 75% confidence from Jev; an upgrade past
  100k of context needs 90%. On by default; `/jev sticky`.
- **Downgrade price check.** A move to a cheaper tier happens only if it
  saves money once the cold cache and the rewrite to come back are counted.
- **Upgrade price limit.** A move to a pricier tier is held when rewriting
  the cache would cost more than $1 over staying; `JEV_ROUTER_UPGRADE_MAX`.
- **Separate price toggle.** `/jev price on|off` and `JEV_ROUTER_PRICE_CHECK`,
  independent of the confidence bar.
- **Context-window guard.** A turn never goes to a tier whose window it does
  not fit. When the running tier outgrows its window, the turn moves up only
  as far as it must, to the cheapest tier that fits.
- **Pricing from the warm cache.** After a resume, `/model`, an unrouted
  turn, turning routing back on, or an expired cache, the next switch is
  priced against the model that actually answered last. Models outside the
  ladder are priced as a cold switch.
- **Effort ceiling.** Caps the effort per tier, `medium` by default;
  `/jev ceiling`, `JEV_ROUTER_CEILING`.
- **First-request effort.** Fable 5.1 runs `medium` as `high` on a
  conversation's first request, so the router sends `high` there and says so,
  and only there (not after a compaction).
- **Sonnet effort hold.** On Sonnet, where an effort change rewrites much of
  the cache, the effort is held unless Jev is sure enough of it.
- **Named tiers.** "use opus", "switch to fable" and similar skip Jev. Plain
  mentions, negations, pasted content, code, quoted lines, text in double
  quotes and task notifications are not read as instructions.
- **Go-aheads.** "yes", "ok", "go ahead", "lgtm" and similar continue the
  previous turn's route without asking Jev.
- **Wake-ups.** Finished background tasks and the engine's own nudges
  continue the reply's route without a Jev call.
- **Subagents.** Each spawned agent is routed on its own task, with a 50%
  confidence floor.
- **Tier exclusion, version pin, timeout.** `JEV_ROUTER_EXCLUDE`,
  `JEV_ROUTER_JEV_MODEL`, `JEV_ROUTER_TIMEOUT_MS`.
- **Stays put when Jev fails.** A timeout or error keeps the turn on the
  tier already running instead of dropping to the session model.
- **Two backends.** TypeSafe direct or the Vercel AI Gateway, with custom
  bases allowed only when opted in.

### Compaction by Jev

- At each compaction, Jev scores every tool call in one request; stale calls
  are dropped with their results, stale outputs are cut to a 300-character
  head, and everything else stays verbatim. The first message and the six
  most recent are never touched. Built on
  [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
- Falls back to the engine's summary, with the reason in `/jev`, when Jev
  removes under 25%, takes over 8 seconds, fails, runs through the gateway,
  or `/compact` carries instructions of its own.
- Tool results are never sent to Jev, only their size.
- Scored once across the engine's precompute and real compaction passes.
- The router keeps its hold after a prune, since the start of the
  conversation stays cached, and scales the context it prices against.
- On by default; `/jev compact on|off`, `JEV_ROUTER_COMPACT`,
  `JEV_ROUTER_COMPACT_TIMEOUT_MS`, `JEV_ROUTER_COMPACT_MIN_REDUCTION`.

### What you see

- **Route line** at the top of each reply: tier, effort, Jev's confidence,
  latency, and any reason in plain words.
- **One summary per reply**: the model the API says answered, the cost at
  list price, tokens in with the cached share, tokens out; covering every
  turn and agent of a reply, written once its agents have finished.
- **`/jev`**: routing, provider, confidence bar, price checks, ceiling,
  compaction, the warm session and cache, spend, and recent turns with their
  reasons.
- **`/jev quiet|loud`** hides or shows the line and summary.
- **Copied-marker filter**: route lines and summaries the model copies into
  its own text are removed as the text streams.
- **Session-mode footer** in the terminal.

### Reliability

- **Fails safe**: when Jev is slow or errors, the turn stays on the tier
  already running; with nothing running, it runs as it would without the
  plugin. The line says why either way.
- **State survives reloads**: history, spend, holds, the open reply and every
  setting are saved per session; the 20 most recently used sessions are kept.
- **One copy acts** however many are loaded, by an in-process stamp, a
  session owner record and a 60-second claim on each turn.
- **Bounded growth** of every table and of the store; usage records with
  missing fields are tolerated; nothing can throw out of a hook.

### Tooling

- `check-jev`, `try-prompts`, `measure-switch-cost`, `bench-overhead`.
- 417 tests; `claude plugin validate` in the pre-commit hook.

### Credits

- [jev-model-router](https://github.com/satviksinha/jev-model-router) by
  Satvik Sinha, the original plugin (MIT).
- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by
  tamaratran, the compaction scoring, vendored under `hooks/compaction/`
  (MIT).
- [Jev](https://docs.typesafe.ai) by TypeSafe.
