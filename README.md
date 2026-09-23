# jev-router

A Claude Code plugin that picks the model and effort for every turn with
[Jev](https://docs.typesafe.ai), TypeSafe's decision model, and weighs each
switch against what it costs.

> **This is a fork.** It is an extended version of
> [satviksinha/jev-model-router](https://github.com/satviksinha/jev-model-router)
> by Satvik Sinha, with cost-aware routing, compaction by Jev (built on
> [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)),
> session persistence and a number of other additions. See
> [What this fork adds](#what-this-fork-adds) and [Credits](#credits).

MIT licensed ([LICENSE](LICENSE)).

## Contents

1. [How it works](#how-it-works)
2. [Quick start](#quick-start)
3. [What you see](#what-you-see)
4. [How a turn is routed](#how-a-turn-is-routed)
5. [Compaction by Jev](#compaction-by-jev)
6. [Reliability](#reliability)
7. [Commands](#commands)
8. [Configuration](#configuration)
9. [Tuning and development](#tuning-and-development)
10. [What this fork adds](#what-this-fork-adds)
11. [Credits](#credits)

---

## How it works

For every prompt you send, Jev answers two questions in one request: which
tier should handle it, and how hard that model should think. The plugin then
checks the answer against the conversation's cost and size before any request
goes out, and rewrites each model request in the turn to the result.

```
you type a prompt
      ↓
turn.start   ask Jev          →  tier: fable, effort: xhigh
      ↓      apply the checks →  window, confidence, price, ceiling
turn.step    each request     →  model: claude-fable-5-1, effort: medium
      ↓
reply        > ✳️ fable · medium · Jev 97% · capped from xhigh · 641ms
             …your reply…
             fable-5-1 ✓ medium · Jev 97% · $0.14 · 130k in (91% cached) · 2k out
```

The four tiers:

| Tier | For | Model |
| --- | --- | --- |
| `haiku` | Trivial: a lookup, a rename, a yes or no. | `claude-haiku-4-5` |
| `sonnet` | Straightforward and minor, no real decision to make. | `claude-sonnet-5` |
| `opus` | Plain implementation carrying some complexity. | `claude-opus-5-5` |
| `fable` | Planning, brainstorming, architecture, systematic debugging. | `claude-fable-5-1` |

What Jev is told each tier is for lives in `TIER_CRITERIA` in
`hooks/policy.ts`. Editing those strings is how you change the router's
judgement; nothing else needs to change.

Why the checks matter: Claude's prompt cache is per model. Moving a long
conversation to another model rewrites the whole context into that model's
cache, which at a few hundred thousand tokens costs dollars. A router that
follows every pick can cost more than it saves, so this one only switches
when the switch is worth it, and says so when it is not.

## Quick start

1. **Get a key.** A [TypeSafe API key](https://console.typesafe.ai/keys)
   (recommended; compaction by Jev needs it) or a
   [Vercel AI Gateway](https://vercel.com/dashboard) key. A gateway key only
   works on an account with a payment card on file.
2. **Add it to `~/.claude/settings.json`**, with function hooks enabled:

   ```json
   {
     "env": {
       "TYPESAFE_API_KEY": "...",
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
     }
   }
   ```

   Without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` the plugin loads and silently
   does nothing.
3. **Install it.** Place the folder at `~/.claude/skills/jev-router/` to load
   it in every session, or run `claude --plugin-dir /path/to/jev-router` for
   one session.
4. **Check it.** `npm run check-jev` reports the provider and whether it
   answers. In a session, `/jev` shows the router's state.

Everything else has a working default: the confidence bar at 75%, price
checks on, a $1 upgrade limit, an effort ceiling of `medium`, and compaction
by Jev on.

## What you see

### The route line

Each reply opens with one line saying what ran and why:

```markdown
> ✳️ opus · high · Jev 98% · 555ms
```

The tier, the effort, Jev's confidence in the tier, and how long Jev took.
When a check changed Jev's pick, the reason is written in plain words:

| The line says | Meaning |
| --- | --- |
| `kept fable: Jev 61% on haiku, needs 75%` | Jev wanted haiku but was not sure enough to switch. |
| `kept fable: haiku costs $4.41 vs $0.13` | Moving down would have cost more than staying, cache included. |
| `kept opus: fable costs $5.03 vs $0.08, over the $1.00 limit` | Moving up would have cost more than the upgrade limit over staying. |
| `kept fable: too long for haiku (310k)` | The conversation does not fit haiku's window. |
| `haiku too long, moved up only to sonnet` | The running tier outgrew its window; the turn went to the cheapest tier that fits. |
| `capped from xhigh` | Jev asked for more effort than the ceiling allows. |
| `your pick` | You named the tier in your prompt. |
| `1st request runs medium as high` | Fable runs `medium` as `high` on a conversation's first request, so that is what is sent. |
| `> ⚠️ not routed: <reason>` | Routing failed; the turn ran on the session model. |

The line is part of the reply's text because that is the one channel every
Claude Code surface draws: terminal, desktop app and IDE. The app's own model
picker does not change, since the router rewrites individual requests, not
the session. In the terminal the session-mode footer also shows the route
(`jev: opus, medium effort`).

### The summary

Under each finished reply, one block reports what the API says actually
answered and what it cost at Anthropic's list price:

```
fable-5-1 ✓ xhigh · Jev 97% · $0.14 · 130k in (91% cached) · 2k out
```

`✓` means the model that answered is the one the router asked for; a
mismatch reads `opus-5 ⚠ asked fable-5-1`. `91% cached` is the share of
input read from the prompt cache.

A reply that launched background agents spans several turns and still gets
one summary, written once every agent has finished:

```
3 turns: fable, opus, fable (2 woken by tasks) · $28.10 · 7.4M in (99% cached) · 61k out
agents: Explore haiku $0.020, general-purpose opus $0.31
turn 2: kept fable: haiku costs $4.41 vs $0.13
```

Lines after the first appear only when something did not run as Jev asked.

`/jev quiet` hides the line and the summary without stopping routing;
`/jev loud` brings them back.

### `/jev`

```
jev-router:
  routing   on
  surface   desktop
  provider  typesafe · TYPESAFE_API_KEY is set · jev-latest
  budget    1500ms
  sticky    on, switch needs 75% (90% up past 100k)
  price     on, a downgrade has to pay, an upgrade may cost $1.00 over staying
  ceiling   medium (fable: xhigh)
  compact   on, Jev prunes tool calls · last: kept 41/87 messages, 63% smaller (12 calls kept, 9 cut, 30 dropped) · 2.1s
  session   claude-opus-5, running on fable
  cache     1h writes · 201k context · fable→haiku pays below 3k
  tiers     haiku, sonnet, opus, fable
  announce  on, a line per turn
  spent     $4.12 this session

  Recent turns, newest first:
     0ms  fable·medium    [task finished] Agent "Review library-sync…
          → fable-5-1 ✓ · $0.061 · 45k in (98% cached) · 1k out
   641ms  fable·medium  Jev 97%; capped from xhigh  help me plan the architecture
          → fable-5-1 ✓ · $0.14 · 130k in (91% cached) · 2k out
   352ms  fable·low  kept fable: haiku costs $1.02 vs $0.020  what is 2+2
          → fable-5-1 ✓ · $0.020 · 47k in (99% cached) · 0k out
    12ms  not routed — gateway said HTTP 403 (customer_verification_required)
```

- `session` is the model the session runs on, and the tier that is warm.
- `cache` is the context being priced, and the size below which the
  cheapest downgrade still pays.
- `spent` is the session's total at list price, routed turns or not.
- Each turn shows the decision and its reason, then (`→`) what actually
  answered. Turns you did not type are labelled `[task finished]`,
  `[continuing]` or `[type agent]`.

## How a turn is routed

The checks run in this order. Each one can only narrow what the one before
allowed.

### 1. Your own words first

**Naming a tier.** A tier named with a routing verb (`use opus`,
`switch to fable`, `route to haiku`, `run this on sonnet`, `go with opus`)
skips Jev, runs at medium effort and shows `your pick`. Plain mentions are
not routes: "search for opus docs" and "I'm using opus for comparison" are
ordinary prompts. A negation cancels the next route ("don't use haiku, use
opus" goes to opus). Pasted content, code and quoted lines are not read for
this, so a pasted document that says "use opus" as an example does not
route. `JEV_ROUTER_ALLOW_OVERRIDE=0` turns this off, and a tier excluded with
`JEV_ROUTER_EXCLUDE` cannot be named back in.

**Go-aheads.** Jev scores a bare "yes" as trivial, which is right about the
text and wrong about the work. A prompt that is only a go-ahead (`y`, `yes`,
`ok`, `sure`, `go ahead`, `continue`, `do it`, `lgtm` and similar) continues
on the previous turn's tier and effort without asking Jev.

**Wake-ups.** A turn the engine starts itself, when a background task
finishes or with its own "still working" nudge, continues the reply's route
without a Jev call, so it adds no latency and cannot switch the model under
a reply in progress. `JEV_ROUTER_NOTIFY_CONTINUE=0` asks Jev about finished
tasks anyway.

### 2. The window guard

A turn is never sent to a tier whose context window it does not fit. Haiku
4.5 takes 200k tokens and the other tiers a million, less 16k of headroom.
This applies whatever Jev said, and even to a tier you named: the turn stays
on the tier already running.

When the running tier is the one that no longer fits (haiku past 184k) and
Jev's pick is held back by the checks below, the turn moves up only as far
as it must, to the cheapest tier that fits.

### 3. The confidence bar

A switch to a different tier than the one running needs Jev to be at least
75% sure. Moving **up** once the context is past 100k needs 90%, because it
rewrites the whole context into a pricier cache. The bar follows the tier
actually running, so a run of unsure picks cannot creep the session down one
turn at a time. `/jev sticky 0.6` moves the bar; `/jev sticky off` removes
it.

### 4. The price checks

- **Moving down** is priced twice: staying on the running tier with its
  cache warm, and going to the cheaper tier cold plus the rewrite to come
  back. The turn moves only if going is cheaper.
- **Moving up** writes the context into the pricier tier's cache. The move
  is held when it would cost more than `JEV_ROUTER_UPGRADE_MAX` over staying
  ($1 by default). With a typical turn that allows an upgrade up to about
  48k of context from opus to fable, 126k from sonnet to opus, and 254k from
  haiku to sonnet.

`/jev price off` turns both off, independently of the confidence bar.
`npm run measure-switch-cost` prints what a switch costs at each size.

The price follows the cache that is actually warm:

- After `claude --resume`, `/model`, or turning routing back on, the first
  turn is priced against the model that answered last.
- A turn that ran unrouted (Jev timed out) warms the session model.
- A resumed session whose cache the engine reports as expired prices staying
  as a rewrite too, until the first response writes the cache again.
- A session on a model outside the ladder (say `claude-opus-5`) is treated
  the same way: moving it to `claude-opus-5-5` means a cold cache.
- A compaction by Jev keeps the start of the conversation verbatim, so the
  cache stays partly warm and the router keeps its hold. The engine's own
  summary compaction resets both.

### 5. Effort

A held turn still gets the effort Jev asked for on Haiku, Opus and Fable,
since effort is sent per request and costs no cache. On Sonnet an effort
change rewrites much of the cache, so the effort is held too unless Jev is
sure enough of it. (Claude Code currently sends no effort to Sonnet 5.)

Each tier has an effort ceiling, `medium` by default. A turn Jev wanted
higher runs at the ceiling and says `capped from xhigh`. `/jev ceiling`
changes it.

Fable 5.1 runs `medium` as `high` on the first request of a conversation,
so the router sends `high` there and says so. Only a conversation's first
request counts: after a compaction the effort asked for is the effort that
runs, and `/clear` starts a new conversation.

### 6. Subagents

Each spawned agent is routed on its own task, unless the call named a model
or is a fork. A subagent starts with an empty context, so there is no cache
to protect and no hold to the parent's tier; below 50% confidence it is left
on its default model. Agents appear in `/jev` and in the reply's summary,
never in the agent's own reply, which its parent reads as a tool result.

## Compaction by Jev

When a conversation fills its context, Claude Code compacts it into a
summary and detail is lost. With this plugin, a compaction asks Jev about
every tool call in the transcript instead, in one request: does this call
still matter, and does its full output still need to be there?

| Jev's answer | What happens |
| --- | --- |
| The output still matters | Kept exactly as it was. |
| The call matters, its output does not | Kept, with the first 300 characters of the result and a note. |
| Neither | Removed, call and result together. |

Text messages are never changed, and the first message and the six most
recent are never touched. What remains is the conversation itself, verbatim.

```
compact   on, Jev prunes tool calls · last: kept 41/87 messages, 63% smaller (12 calls kept, 9 cut, 30 dropped) · 2.1s
```

The engine's summary runs instead, and `/jev` says why, when Jev removes
less than 25%, takes longer than 8 seconds, fails, or the provider is the
Vercel gateway (which does not answer the yes/no questions this uses). A
`/compact` with instructions of its own is left to the engine's summary,
which can follow them.

What Jev sees: the conversation's text and each tool call's input (up to
1,000 characters, so a Write or Edit call's content is included). Tool
results are described only by their size and whether they errored; their
contents are never sent. Claude Code compacts ahead of time and then for
real a few messages later; the transcript is scored once.

`/jev compact off` restores the engine's summary, and `/jev off` turns
compaction by Jev off along with routing.

## Reliability

**It fails open.** A turn the router cannot decide runs exactly as it would
without the plugin, and the line says why: no key, Jev too slow, an error or
an unreadable answer, or a tier that was not offered. The only cost is the
wait, capped at the timeout. Prompts are cut to their first 12,000
characters before Jev sees them.

**State survives a reload.** The routing history, spend, the tier being
held, the open reply and every `/jev` setting are saved in Claude Code's
per-plugin store (`~/.claude/plugins/store/jev-router_*.json`) and restored
after an update or reload. The twenty most recently used sessions are kept.

**One copy acts.** More than one copy of the plugin can be loaded at once,
after a reload or when the app continues a conversation under a new id. The
newest copy acts and the others pass the turn through untouched: no Jev
call, no model change, no line, no summary. Within one process this is
decided in memory; across processes, by an owner record and a 60-second
claim on each turn in the store.

**Its own marks stay single.** The model sees past lines and summaries in
its own replies and can write look-alikes with invented figures. The plugin
removes a route line at the start of the model's text and a summary at its
end, as the text streams, before writing the real ones. One quoted mid-reply
is left alone.

## Commands

| Command | Effect |
| --- | --- |
| `/jev` | Status, settings and recent turns. |
| `/jev on`, `/jev off` | Turn routing (and compaction by Jev) on or off. |
| `/jev quiet`, `/jev loud` | Hide or show the route line and summary. |
| `/jev sticky`, `/jev sticky 0.6`, `/jev sticky off` | Turn the confidence bar on, set it, or turn it off. |
| `/jev price`, `/jev price on`, `/jev price off` | Show or toggle the price checks. |
| `/jev ceiling` | Show the effort ceiling. |
| `/jev ceiling xhigh`, `/jev xhigh` | Raise every tier's ceiling. |
| `/jev ceiling xhigh fable`, `/jev xhigh fable` | Raise one tier's ceiling. |
| `/jev ceiling off` | Remove every cap. |
| `/jev compact`, `/jev compact on`, `/jev compact off` | Show or toggle compaction by Jev. |

A command overrides the matching setting below for the rest of the session,
and is kept across reloads.

## Configuration

All settings go in the `env` block of `~/.claude/settings.json`.

**Provider**

| Variable | Default | Effect |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | | TypeSafe direct key. |
| `AI_GATEWAY_API_KEY` | | Vercel AI Gateway key. |
| `JEV_ROUTER_PROVIDER` | TypeSafe if its key is set | `typesafe` or `gateway`. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Only `*.typesafe.ai` is accepted unless `JEV_ROUTER_ALLOW_CUSTOM_BASE=1`. |
| `JEV_ROUTER_JEV_MODEL` | `jev-latest` | Pin a Jev version (e.g. `jev-1.13.0`) so confidences stay stable across releases. |
| `JEV_ROUTER_TIMEOUT_MS` | `1500` | How long a turn waits for Jev. At most 8000. |

**Routing**

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_ROUTER_STICKY` | on | `0` removes the confidence bar. |
| `JEV_ROUTER_STICKY_CONFIDENCE` | `0.75` | The confidence bar. |
| `JEV_ROUTER_PRICE_CHECK` | on | `0` turns both price checks off. |
| `JEV_ROUTER_UPGRADE_MAX` | `1` | Dollars an upgrade may cost over staying, or `off`. |
| `JEV_ROUTER_CACHE_TTL` | `1h` | Cache lifetime used for pricing: `1h` (what Claude Code writes) or `5m`. |
| `JEV_ROUTER_CEILING` | `medium` | Effort ceiling: `xhigh` for all tiers, or per tier, e.g. `fable:xhigh,opus:high`. |
| `JEV_ROUTER_EXCLUDE` | | Tiers never offered to Jev, e.g. `fable,haiku`. |
| `JEV_ROUTER_ALLOW_OVERRIDE` | on | `0` ignores tiers named in prompts. |
| `JEV_ROUTER_NOTIFY_CONTINUE` | on | `0` asks Jev about finished-task turns. |

**Compaction**

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_ROUTER_COMPACT` | on | `0` leaves compaction to the engine's summary. |
| `JEV_ROUTER_COMPACT_TIMEOUT_MS` | `8000` | How long scoring may take. At most 8000, under the hook's 10-second budget. |
| `JEV_ROUTER_COMPACT_MIN_REDUCTION` | `0.25` | The share Jev must remove for its result to stand (`40%` works too). |

## Tuning and development

### Scripts

```
npm run check-jev              # is the configured provider serving?
npm run try-prompts            # Jev's tier, effort and confidence on sample prompts
npm run try-prompts -- "text"  # the same for one prompt
npm run measure-switch-cost    # what a switch costs at each context size
npm run bench-overhead         # engine calls and plugin time per turn, with a fake engine
```

`try-prompts` is the tuning loop: edit `TIER_CRITERIA`, run it, check the
picks moved the way you wanted. No script prints a key.

```
  ms  tier    effort  conf  prompt
 839  haiku   low     1.00  what is 2+2
 402  haiku   medium  0.75  rename the variable foo to bar in utils.ts
 482  sonnet  medium  0.66  add a --verbose flag to the CLI
 555  opus    high    0.98  implement cursor pagination for the reports endpoint
 641  fable   xhigh   0.97  the e2e suite passes alone but fails with the others
 734  fable   xhigh   1.00  help me plan the architecture for multi-tenant billing
```

Tier and effort are separate questions and can disagree: a short question
about unfamiliar code can be trivial to route but hard to answer.

### Layout

```
hooks/register.ts   the hooks, settings, turn history, saved state, which copy acts
hooks/policy.ts     tiers, criteria, answers → model and effort, holds, the ceiling
hooks/pricing.ts    Anthropic list prices; turn cost and switch cost
hooks/status.ts     the route line, the summary, /jev, the copied-marker filter
hooks/persist.ts    session state to and from the plugin store
hooks/compactor.ts  compaction by Jev: provider, timeout, fallback, /jev line
hooks/compaction/   the vendored fast-jev-compaction scoring (MIT)
hooks/jev.ts        the Jev request, timeout and named failures
hooks/provider.ts   which backend to use, with endpoints and keys resolved
hooks/label.ts      the session-mode footer label
tests/              node:test suites; register.test.ts drives the real hooks
                    against a fake engine
scripts/            check-jev, try-prompts, measure-switch-cost, bench-overhead
```

### Working on it

```
npm run types    # once: fetch Claude Code's type definitions into .claude/types
npm run check    # typecheck, tests, plugin validate
git config core.hooksPath scripts/githooks   # once per clone: validate before every commit
```

Always run `claude plugin validate`. It checks the engine's load-time rules
without executing anything. The rule that matters most: `$` may only be
passed to functions declared at the top level of the module. Breaking it
stops the module from loading, silently: every turn runs unrouted while
`tsc` and the tests still pass. The pre-commit hook runs validate for this
reason.

### Backends

| | TypeSafe direct | Vercel AI Gateway |
| --- | --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST https://ai-gateway.vercel.sh/v1/evaluate` |
| Body | `{ model, state, questions }` | `{ model, state, questions }` (model ignored) |
| Precision | four decimal places | two decimal places |
| Question types | `choice`, `score`, `noul` | `choice`, `score` |
| Compaction by Jev | Yes | No (needs `noul`) |

## What this fork adds

The original [jev-model-router](https://github.com/satviksinha/jev-model-router)
routes each turn by Jev's tier and effort, with the route line, a per-turn
footer, `/jev`, an opt-in confidence bar, subagent routing, and both
backends. This fork keeps that design and adds:

| Area | Addition |
| --- | --- |
| Cost | Price checks on downgrades and upgrades, with a dollar limit on upgrades and a separate toggle; list prices with one-hour cache writes; pricing from the cache actually warm after resume, `/model`, an unrouted turn or an expired cache. |
| Safety | The context-window guard, with a step up only as far as needed; a higher confidence bar for upgrades past 100k; the confidence bar on by default. |
| Effort | The effort ceiling (default `medium`); Fable's first-request effort; the Sonnet effort hold. |
| Your words | Named tiers, with pasted, quoted and code text ignored; go-aheads; finished tasks and nudges continuing without a Jev call. |
| Compaction | Compaction by Jev, built on fast-jev-compaction. |
| Display | One summary per reply covering its turns and agents; plain-language reasons; the filter for copied lines and summaries. |
| Reliability | State saved across reloads; one copy acting however many are loaded; bounded store growth; usage records tolerated when fields are missing. |
| Tooling | `measure-switch-cost` and `bench-overhead`; about 400 tests. |

## Credits

- **[jev-model-router](https://github.com/satviksinha/jev-model-router)** by
  [Satvik Sinha](https://github.com/satviksinha): the original plugin this
  fork is built on, and its MIT licence ([LICENSE](LICENSE)).
- **[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)**
  by [tamaratran](https://github.com/tamaratran): the idea of scoring every
  tool call with Jev and keeping the conversation verbatim, and the scoring
  library itself. Its `src/` (commit `e3f262a7f4d4`) is vendored unchanged
  under `hooks/compaction/`, with its MIT licence in
  [LICENSE-fast-jev-compaction](LICENSE-fast-jev-compaction). This fork adds
  the wiring to its provider and settings, the toggle, the fallback rules,
  the reuse across the engine's two compaction passes, and the `/jev`
  reporting.
- **[Jev](https://docs.typesafe.ai)** by TypeSafe: the decision model behind
  every route and every compaction.
