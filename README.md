# jev-router

A Claude Code plugin that picks the model and effort for each turn with
[Jev](https://docs.typesafe.ai), TypeSafe's decision model. It works with
TypeSafe's direct API or the Vercel AI Gateway.

[MIT licensed](LICENSE).

When you send a prompt, Jev is asked two questions at once: which tier should
answer it, and how hard that model should think. Every model request in the
turn then goes to that model at that effort, unless switching would cost more
than it saves. A line at the top of the reply says what ran, and a summary
underneath says what it cost.

```
you type a prompt
      ↓
turn.start   ask Jev  →  tier: fable   effort: xhigh
      ↓      apply the bar, the price check, the window guard, the ceiling
turn.step    each request → model: claude-fable-5-1, effort: medium
      ↓
reply        > ✳️ fable · medium · Jev 97% · capped from xhigh · 641ms
             …
             fable-5-1 ✓ medium · Jev 97% · $0.14 · 130k in (91% cached) · 2k out
```

## Features

| Feature | What it does |
| --- | --- |
| Per-turn routing | Jev picks a tier and an effort for every prompt, and each model request in that turn is rewritten to match. |
| Confidence bar | A switch to a different tier needs 75% confidence from Jev. An upgrade once the context is past 100k needs 90%. |
| Price checks | A move to a cheaper tier only happens if it saves money, cache included. A move to a dearer tier is held when rewriting the cache would cost more than $1 over staying. |
| Context-window guard | A turn never goes to a tier whose window it does not fit. |
| Effort ceiling | Caps the effort each tier may be asked for. The default is `medium` on every tier. |
| Go-aheads, wake-ups and named tiers | "yes" continues on the last turn's tier without asking Jev, and so does a turn the engine starts when a background task finishes; "use opus" routes straight to opus. |
| Subagents | Each spawned agent is routed on its own task. |
| Route line and summary | One line at the top of each reply, one cost summary under it. |
| `/jev` | Status, settings and the recent turns, each with the reason for its route. |
| First-request effort | Fable runs `medium` as `high` on a conversation's first request; the router sends `high` there and says so, and only there. |
| Compaction by Jev | At each compaction, Jev scores every tool call and the stale ones are dropped or cut; the conversation itself stays verbatim instead of being summarised. On by default. |
| Session state | Routing history, spend and settings survive a plugin reload. |
| One copy acts | However many copies of the plugin are loaded, only one routes a turn and writes its line and summary. |
| Fails open | Any failure leaves the turn exactly as it would run without the plugin, and the line says why. |

## The ladder

| Tier | For | Model |
| --- | --- | --- |
| `haiku` | Trivial. A lookup, a rename, a yes or no. | `claude-haiku-4-5` |
| `sonnet` | Straightforward and minor, no real decision to make. | `claude-sonnet-5` |
| `opus` | Plain implementation carrying some complexity. | `claude-opus-5-5` |
| `fable` | Planning, brainstorming, architecture, systematic debugging. | `claude-fable-5-1` |

The policy lives in `TIER_CRITERIA` in `hooks/policy.ts`. Those strings are
what Jev is told each tier is for. To change the router's behaviour, edit
them; nothing else needs to change.

## Setup

1. Get a key: a [TypeSafe API key](https://console.typesafe.ai/keys), or a
   [Vercel AI Gateway](https://vercel.com/dashboard) key. A gateway key only
   works on an account with a payment card on file; without one, every request
   fails with `HTTP 403 customer_verification_required`.
2. Add it to the `env` block of `~/.claude/settings.json`, and enable
   function hooks:

   ```json
   {
     "env": {
       "TYPESAFE_API_KEY": "...",
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
     }
   }
   ```

   `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is required. Without it the plugin
   loads and silently does nothing. If both keys are set, TypeSafe direct is
   used; `JEV_ROUTER_PROVIDER=gateway` forces the gateway.
3. Install the plugin. For one session, run
   `claude --plugin-dir /path/to/jev-router`. To load it in every session,
   place the folder at `~/.claude/skills/jev-router/`.
4. Check it: `npm run check-jev` reports which provider is configured and
   whether it is serving. Then run `/jev` in a session.

## What you see

### The route line

The first line of each reply says what the turn ran on and why:

```markdown
> ✳️ opus · high · Jev 98% · 555ms
```

The tier, the effort, Jev's confidence in the tier, and how long Jev took.
Anything that changed Jev's pick is written in plain words:

| Line says | Meaning |
| --- | --- |
| `kept fable: Jev 61% on haiku, needs 75%` | Jev wanted haiku but was not sure enough to switch. |
| `kept fable: haiku costs $4.41 vs $0.13` | The downgrade would have cost more than staying, cache included. |
| `kept opus: fable costs $5.03 vs $0.08, over the $1.00 limit` | The upgrade would have cost more than the limit over staying. |
| `kept fable: too long for haiku (310k)` | The context does not fit haiku's window. |
| `haiku too long, moved up only to sonnet` | The running tier outgrew its window; the turn went to the cheapest tier that fits, not Jev's pick. |
| `capped from xhigh` | Jev asked for more effort than the ceiling allows. |
| `your pick` | The prompt named the tier. |
| `1st request runs medium as high` | Fable runs `medium` as `high` on a conversation's first request, so the router sends `high` and says so. |
| `> ⚠️ not routed: <reason>` | Routing failed; the turn ran on the session model. |

The line is written into the reply's own text, as markdown, because that is
the one channel every Claude Code surface draws (terminal, desktop, IDE).

### The summary

Under each finished reply, one fenced block reports what the API says
actually answered and what it cost:

```
fable-5-1 ✓ xhigh · Jev 97% · $0.14 · 130k in (91% cached) · 2k out
```

- `✓` means the model that answered is the one the router asked for. A
  mismatch shows `opus-5 ⚠ asked fable-5-1`.
- Dollars are Anthropic's list price (`hooks/pricing.ts`), with cache writes
  at the one-hour rate Claude Code uses.
- `91% cached` is the share of input read from the prompt cache.

A reply that launched background agents spans several turns. It gets one
summary once every agent has finished, covering all of them:

```
3 turns: fable, opus, fable (2 woken by tasks) · $28.10 · 7.4M in (99% cached) · 61k out
agents: Explore haiku $0.020, general-purpose opus $0.31
turn 2: kept fable: haiku costs $4.41 vs $0.13
```

Lines after the first appear only when something did not run as Jev asked.
A task that finishes after its reply's summary was written wakes the loop
once more; that turn is listed in `/jev` and adds no second block.

The model sees past lines and summaries in its own replies and can write
look-alikes with invented figures. The plugin removes a route line at the
start of the model's text and a summary at its end before writing the real
ones. One quoted mid-reply is left alone.

`/jev quiet` turns off the line and the summary without stopping routing;
`/jev loud` turns them back on.

In the terminal, the session-mode footer also shows the current route
(`jev: opus, medium effort`). The app's own model picker does not change: it
shows the session model, and the router rewrites individual requests, not
the session.

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
     0ms  not routed — [general-purpose agent] Review library-sync cluster · not routed at spawn…
          → opus-5-5 · $0.023 · 22k in (82% cached) · 0k out
   641ms  fable·medium  Jev 97%; capped from xhigh  help me plan the architecture
          → fable-5-1 ✓ · $0.14 · 130k in (91% cached) · 2k out
   352ms  fable·low  kept fable: haiku costs $1.02 vs $0.020  what is 2+2
          → fable-5-1 ✓ · $0.020 · 47k in (99% cached) · 0k out
    12ms  not routed — gateway said HTTP 403 (customer_verification_required)
```

- `session` is the model the session runs on, and the tier that is currently
  warm.
- `cache` is the context being priced and the size below which the cheapest
  downgrade still pays.
- `spent` is the session's total at list price, routed turns or not.
- Each turn shows the decision and its reason, then (`→`) what the API
  reports actually answered.
- Rows for turns you did not type are labelled: `[task finished]` for a
  background agent waking the loop (it continues the reply's route, with
  no Jev call and no extra line), `[continuing]` for the engine's own nudge
  (the same), and `[type agent]` for a subagent.

## How a turn is routed

### The window guard

A turn is never sent to a tier whose context window it does not fit. Haiku
4.5 takes 200k tokens and the other tiers take a million, less 16k headroom
for the prompt and reply. This applies whatever Jev said and even when the
prompt named the tier. The turn stays on the tier already running, or on the
session model if nothing is running yet.

When the tier already running is the one that no longer fits (haiku past
184k) and Jev's pick was held back by doubt or by the upgrade limit, the
turn moves up only as far as it must: to the cheapest tier that fits, not
all the way to Jev's pick. The line says `haiku too long, moved up only to
sonnet`.

### The confidence bar and the price check

The prompt cache is per model. Switching tiers writes the whole context to
the new model's cache, and switching back writes it again. At a few hundred
thousand tokens of context that costs dollars, often more than the switch
saves. So a switch has to clear three checks:

- **Confidence.** A turn that picks a different tier from the one running
  moves only if Jev's confidence is at least 75%. An upgrade once the context
  is past 100k needs 90%, since it rewrites the whole context to a pricier
  cache (`UPGRADE_CONTEXT_TOKENS` and `UPGRADE_CONFIDENCE` in `policy.ts`).
- **Price, for a downgrade.** The turn is priced twice: on the running tier
  with its cache warm, and on the cheaper tier cold plus the write to come
  back. It moves only if going is cheaper.
- **Price, for an upgrade.** Going writes the whole context to the dearer
  tier's cache and pays its output price; staying reads the warm cache. The
  move is held when going costs more than `JEV_ROUTER_UPGRADE_MAX` over
  staying ($1 by default). With a typical turn that allows an upgrade up to
  about 48k of context from opus to fable, 126k from sonnet to opus, and
  254k from haiku to sonnet. A tier named in the prompt is not held.

A held turn runs on the tier already warm and says why. The effort Jev asked
for still applies on Opus, Haiku and Fable, since effort is sent per request
and does not touch the cache. On Sonnet, an effort change rewrites much of
the cache, so the effort is held too unless Jev's effort confidence clears
the same bar.

The hold follows the tier actually running, not the one Jev named, so a run
of unsure picks cannot creep the session downward one turn at a time. A
compaction or `/clear` empties the cache, so the next turn starts fresh.

On `claude --resume`, after `/model`, or when routing is switched on
mid-session, the first routed turn is priced against the model that is
actually warm. When the engine reports that a resumed session's cache has
expired, staying is priced as a rewrite too, until the first response
writes it again. A turn that runs unrouted (Jev timed out) runs on the
session model, and that model is then what is warm. A session on a model
outside the ladder (for example `claude-opus-5`) is treated the same way:
moving it to `claude-opus-5-5` means a cold cache, so the move is priced
like a downgrade.

`npm run measure-switch-cost` prints what a switch costs at each context
size.

### The effort ceiling

Each tier has a maximum effort, `medium` by default. A turn Jev wanted
higher runs at the ceiling, and the line says `capped from xhigh`. Raise it
with `/jev ceiling`.

Fable 5.1 runs `medium` as `high` on the first request of a conversation, so
the router sends `high` there and says so (`FIRST_TURN_EFFORT` in
`policy.ts`). Only the first request counts: after a compaction the effort
asked for is the effort that runs; `/clear` starts a new conversation.
Claude Code sends no effort to Sonnet 5, so its effort setting has no
effect.

### Go-aheads and wake-ups

Jev scores a bare "yes" as trivial, which is right about the text and wrong
about the work. A prompt that is only a go-ahead (`y`, `yes`, `ok`, `sure`,
`go ahead`, `continue`, `do it`, `lgtm` and similar) continues on the previous
turn's tier and effort without asking Jev. With nothing to continue, it stays
on the session model.

Turns the engine starts on its own are treated the same way: a background
task finishing (its `<task-notification>` is the turn's text) and the
engine's own nudge both continue the reply's route without a Jev call, so
they add no latency and cannot switch the model under a reply in progress.
`JEV_ROUTER_NOTIFY_CONTINUE=0` asks Jev about notifications anyway.

### Naming a tier

A tier named with a routing verb (`use opus`, `switch to fable`,
`route to haiku`, `run this on sonnet`, `go with opus`) skips Jev, runs at
medium effort, and shows `your pick`. Plain mentions are not routes:
"search for opus docs" and "I'm using opus for comparison" are ordinary
prompts. A negation cancels only the next route ("don't use haiku, use opus"
routes to opus). Text you paste, code, and quoted lines are not read for
this: a pasted document that says "use opus" as an example does not route. Only the window guard overrides a named tier, and a tier
excluded by `JEV_ROUTER_EXCLUDE` cannot be named.
`JEV_ROUTER_ALLOW_OVERRIDE=0` turns this off.

### Subagents

Each spawned agent is routed on its own task at `agent.spawn`, unless the
call named a model or is a fork. There is no hold to the parent's tier: a
subagent starts with an empty context, so it has no cache to lose. Below
50% confidence (`SUBAGENT_CONFIDENCE` in `policy.ts`) the agent is left on
its default model. Agents appear in `/jev` and in the reply's summary. Nothing
is written into a subagent's own reply, because its parent reads that text as
a tool result.

## Compaction by Jev

When the context fills up, Claude Code compacts the conversation into a
summary, and detail is lost. With the plugin, a compaction instead asks Jev
about every tool call in the transcript, in one request: does this call
still matter, and does its full output still need to be there verbatim?
Calls that no longer matter are removed with their results; calls that
matter but whose output does not are kept with the first 300 characters of
the result and a note; everything else stays exactly as it was. The first
message and the six most recent are never touched.

```
compact   on, Jev prunes tool calls · last: kept 41/87 messages, 63% smaller (12 calls kept, 9 cut, 30 dropped) · 2.1s
```

The engine's own summary runs instead, and `/jev` says why, when:

- Jev removes less than 25% of the transcript (`JEV_ROUTER_COMPACT_MIN_REDUCTION`),
- scoring takes longer than 8 seconds (`JEV_ROUTER_COMPACT_TIMEOUT_MS`),
- the provider is the Vercel AI Gateway, which does not serve the yes/no
  question type this uses (TypeSafe direct is required), or
- Jev fails.

What Jev sees is the conversation's text and each tool call's input (up
to 1,000 characters of it, so a Write or Edit call's content is included);
tool results are described only by their size and whether they errored,
never sent. Long transcripts are abridged to fit. `/compact` with
instructions of its own is left to the engine's summary, which can follow
them. The engine compacts ahead of time and then for real a few messages
later; the transcript is scored once and the new messages appended.

`/jev compact off` restores the engine's summary; `/jev compact on` brings
Jev back. `JEV_ROUTER_COMPACT=0` starts a session with it off, and
`/jev off` turns compaction off along with routing. The scoring comes from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT), vendored under `hooks/compaction/`; see *Credits*.

## Commands

| Command | Effect |
| --- | --- |
| `/jev` | Status and recent turns. |
| `/jev on`, `/jev off` | Turn routing on or off. |
| `/jev quiet`, `/jev loud` | Hide or show the line and summary. Routing and history continue. |
| `/jev sticky`, `/jev sticky 0.6`, `/jev sticky off` | Turn the confidence bar on, set it, or turn it off. The price checks are separate. |
| `/jev price`, `/jev price on`, `/jev price off` | Show, turn on, or turn off the downgrade and upgrade price checks. Off, switches follow Jev and the confidence bar alone. |
| `/jev ceiling` | Show the effort ceiling. |
| `/jev ceiling xhigh`, `/jev xhigh` | Raise every tier's ceiling. |
| `/jev ceiling xhigh fable`, `/jev xhigh fable` | Raise one tier's ceiling. |
| `/jev ceiling off` | Remove every cap (`max`). |
| `/jev compact`, `/jev compact on`, `/jev compact off` | Show, turn on, or turn off compaction by Jev. |

Commands override the matching environment settings for the rest of the
session.

## Configuration

All settings go in the `env` block of `~/.claude/settings.json`.

| Variable | Default | Effect |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | | TypeSafe direct key. |
| `AI_GATEWAY_API_KEY` | | Vercel AI Gateway key. |
| `JEV_ROUTER_PROVIDER` | TypeSafe if its key is set | `typesafe` or `gateway`. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Only `*.typesafe.ai` unless `JEV_ROUTER_ALLOW_CUSTOM_BASE=1`. |
| `JEV_ROUTER_JEV_MODEL` | `jev-latest` | Pin a Jev version, e.g. `jev-1.13.0`, so confidences stay stable across TypeSafe releases. |
| `JEV_ROUTER_TIMEOUT_MS` | `1500` | How long a turn waits for Jev. Capped at 8000. |
| `JEV_ROUTER_STICKY` | on | `0` switches freely. |
| `JEV_ROUTER_STICKY_CONFIDENCE` | `0.75` | The confidence bar. |
| `JEV_ROUTER_PRICE_CHECK` | on | `0` turns the downgrade and upgrade price checks off. |
| `JEV_ROUTER_UPGRADE_MAX` | `1` | Dollars an upgrade may cost over staying, or `off` for no limit. |
| `JEV_ROUTER_CEILING` | `medium` | Effort ceiling: `xhigh` for all tiers, or per tier, e.g. `fable:xhigh,opus:high`. |
| `JEV_ROUTER_CACHE_TTL` | `1h` | Cache lifetime used for pricing: `1h` (what Claude Code writes) or `5m`. |
| `JEV_ROUTER_EXCLUDE` | | Tiers never offered to Jev, e.g. `fable,haiku`. |
| `JEV_ROUTER_ALLOW_OVERRIDE` | on | `0` ignores tiers named in prompts. |
| `JEV_ROUTER_COMPACT` | on | `0` leaves compaction to the engine's summary. |
| `JEV_ROUTER_COMPACT_TIMEOUT_MS` | `8000` | How long Jev may take to score a transcript before the engine's summary runs instead. At most 8000: the hook's own budget is 10 seconds. |
| `JEV_ROUTER_COMPACT_MIN_REDUCTION` | `0.25` | The share of the transcript Jev must remove for its result to stand; `40%` works too. |
| `JEV_ROUTER_NOTIFY_CONTINUE` | on | `0` asks Jev about each task-notification turn instead of continuing the reply's route. |

## Session state and multiple copies

The routing history, spend, the tier being held, the open reply and the
`/jev` settings are saved in Claude Code's per-plugin store
(`~/.claude/plugins/store/jev-router_*.json`) and restored after a plugin
update or reload. The twenty most recent sessions are kept.

More than one copy of the plugin can be loaded at once, for example after a
reload or when the app continues a conversation under a new session id.
Only one copy acts on each turn:

- Within one process, the most recently loaded copy acts and older copies
  stand aside.
- Across processes, the newest copy records itself as the session's owner in
  the store.
- Each turn is claimed in the store by the newest copy for 60 seconds, keyed
  by the prompt text and the context size. A copy that does not hold the
  claim passes the turn through untouched: no Jev call, no model change, no
  line, no summary.
- A copy never adds a line or summary that is already in the stream.

Two separate sessions that receive the identical prompt within the same
minute while carrying exactly the same context size would route only one
of them. If the store cannot be read, every copy proceeds as usual.

## When it does nothing

The router fails open. A turn it cannot decide runs exactly as it would
without the plugin, and the line says why:

- no API key is set (no request is made)
- Jev takes longer than the timeout
- the provider refuses the key, errors, or returns something unreadable
- Jev names a tier that was not offered

The only cost of a failure is the wait, capped at the timeout. Prompts are
cut to their first 12,000 characters before Jev sees them.

Low confidence is not a failure: the pick is still subject to the bar, and the
line shows the confidence.

```
> ⚠️ not routed: gateway said HTTP 403 (customer_verification_required)
```

## Tuning

```
npm run check-jev                     # is the configured provider serving?
npm run try-prompts                   # Jev's tier, effort and confidence on sample prompts
npm run try-prompts -- "your prompt"
npm run measure-switch-cost           # what a switch costs at each context size
npm run bench-overhead                # engine calls and plugin time per turn, with a fake engine
```

`try-prompts` is the tuning loop: edit `TIER_CRITERIA`, run it, and check
the picks moved the way you wanted. No script prints a key.

Sample output:

```
  ms  tier    effort  conf  prompt
 839  haiku   low     1.00  what is 2+2
 402  haiku   medium  0.75  rename the variable foo to bar in utils.ts
 482  sonnet  medium  0.66  add a --verbose flag to the CLI
 555  opus    high    0.98  implement cursor pagination for the reports endpoint
 641  fable   xhigh   0.97  the e2e suite passes alone but fails with the others
 734  fable   xhigh   1.00  help me plan the architecture for multi-tenant billing
```

Tier and effort are separate questions, so they can disagree: a short
question about unfamiliar code can be trivial to route but hard to answer,
which gives `haiku · xhigh`. The engine lowers an effort the model does not
support.

## Layout

```
hooks/register.ts   the hooks, settings, turn history, saved state, which copy acts
hooks/jev.ts        the Jev request, timeout and named failures
hooks/provider.ts   which backend to use, with endpoints and keys resolved
hooks/policy.ts     tiers, criteria, answers → model and effort, the ceiling, holds
hooks/pricing.ts    Anthropic list prices; turn cost and switch cost
hooks/persist.ts    session state to and from the plugin store
hooks/compactor.ts  compaction by Jev: the provider, the timeout, the fallback, /jev's line
hooks/compaction/   the vendored fast-jev-compaction scoring (MIT)
hooks/label.ts      the session-mode footer label
hooks/status.ts     the route line, the summary, /jev output, usage per turn
tests/              node:test suites; register.test.ts drives the real hooks
                    against a fake engine
scripts/            check-jev, try-prompts, measure-switch-cost, bench-overhead
```

## Development

```
npm run types    # once: fetch Claude Code's type definitions into .claude/types
npm run check    # typecheck, tests, plugin validate
git config core.hooksPath scripts/githooks   # once per clone: validate before every commit
```

Always run `claude plugin validate`. It checks the engine's load-time rules
without executing anything, and prints every event hooked, every `$` call
and every environment variable read. One rule matters most: `$` may only be
passed to functions declared at the top level of the module. Breaking it
stops the module from loading, silently: every turn runs unrouted while
`tsc` and the tests still pass. The pre-commit hook runs validate for this
reason.

## Backends

Both backends take the same `choice` and `score` questions and return the same
`answers` shape.

| | TypeSafe direct | Vercel AI Gateway |
| --- | --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST https://ai-gateway.vercel.sh/v1/evaluate` |
| Body | `{ model, state, questions }` | `{ model, state, questions }` (model ignored) |
| Precision | four decimal places | two decimal places |
| Question types | `choice`, `score`, `noul` | `choice`, `score` |

## Credits

Compaction by Jev is built on
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by
[tamaratran](https://github.com/tamaratran): the idea of scoring every tool
call with Jev and keeping the conversation verbatim, and the scoring library
itself, are that project's. Its `src/` (commit `e3f262a7f4d4`) is vendored
unchanged under `hooks/compaction/` with its MIT licence in
`LICENSE-fast-jev-compaction`. jev-router adds the wiring to its own
provider and settings, the `/jev compact` toggle, the fallback rules, the
cache across the engine's precompute and real compaction, and the `/jev`
reporting.

Routing is built with [Jev](https://docs.typesafe.ai), TypeSafe's decision
model, over the TypeSafe API or the Vercel AI Gateway.
