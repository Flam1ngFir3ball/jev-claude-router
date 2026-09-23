# jev-router

Picks the model for each turn with [Jev](https://docs.typesafe.ai), TypeSafe's
decision model. Supports both TypeSafe's direct API and the Vercel AI Gateway.

[MIT licensed](LICENSE).

You type a prompt. Before the turn runs, Jev is asked two questions at once:
which tier should answer this, and how hard should it think. Every model
request in that turn then goes to the model Jev named, and a line above the
reply says which one.

```
Context    you type a prompt
              ↓
turn.start    ask Jev  →  tier: fable   effort: 3
              ↓
turn.step     next({ ...e, model: 'claude-fable-5-1', effort: 'xhigh' })
              first text chunk ← '> ✳️ fable · xhigh effort · Jev 97% sure · 641ms\n\n---\n\n' + text
              ↓
/jev          the full history, with reasons for anything unrouted
```

## The ladder

| Tier | For | Model |
| --- | --- | --- |
| `haiku` | Trivial. A lookup, a rename, a yes or no. | `claude-haiku-4-5` |
| `sonnet` | Straightforward and minor, no real decision to make. | `claude-sonnet-5` |
| `opus` | Plain implementation carrying some complexity. | `claude-opus-5-5` |
| `fable` | Planning, brainstorming, architecture, systematic debugging. | `claude-fable-5-1` |

The policy lives in `TIER_CRITERIA` in `hooks/policy.ts`. Those strings are
what Jev is told each tier is for, so editing them is how you change the
router's behaviour. Nothing else needs to change.

## Setup

### Provider: TypeSafe direct or Vercel AI Gateway

Get either a TypeSafe API key or an AI Gateway key and put it in the `env` block
of `~/.claude/settings.json`. The router prefers TypeSafe direct when both keys
are set:

```json
{
  "env": {
    "TYPESAFE_API_KEY": "...",
    "AI_GATEWAY_API_KEY": "...",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

**For TypeSafe direct:** Get a key from your [TypeSafe account](https://console.typesafe.ai/keys).

**For the Vercel AI Gateway:** Get a key from your [Vercel dashboard](https://vercel.com/dashboard) and note
that the gateway **needs a card on the account**, not just a key. A valid key
on an account with no payment method gets:

```
HTTP 403  customer_verification_required
"AI Gateway requires a valid credit card on file to service requests."
```

A personal-scope gateway key needs a card before it serves anything, even on free
credits. A team-scope key reportedly does not.

**Forcing a provider:** If both keys are set and you want to use the gateway,
set `JEV_ROUTER_PROVIDER=gateway`. Similarly, `JEV_ROUTER_PROVIDER=typesafe`
forces TypeSafe direct.

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not optional. Without it the mod loads
and silently does nothing, with no warning.

Because the router fails open, setup issues show up as the mod doing nothing
at all rather than as an error. Run `npm run check-jev` when nothing seems to
route to see which provider is configured and whether it's serving.

Then run Claude Code with the mod:

```
claude --plugin-dir ~/Desktop/jev-router
```

To keep it on permanently, move the folder to `~/.claude/skills/jev-router/`,
where it loads on its own next session.

## Knowing whether it is working

Four signals, in order of how much you can trust them.

**`/jev`** prints the full state. A command's output row draws on every
surface, so this always works:

```
jev-router
  routing   on
  surface   desktop
  provider  typesafe · TYPESAFE_API_KEY is set · jev-latest
  budget    1500ms
  sticky    on, switch needs 75% (90% up past 100k), and a downgrade has to pay
  ceiling   medium (fable: xhigh)
  session   claude-opus-5, running on fable
  cache     1h writes · 201k context · fable→haiku pays below 3k
  tiers     haiku, sonnet, opus, fable
  announce  on, a line per turn
  spent     $4.12 this session

  Recent turns, newest first:
   653ms  fable·medium  Jev 61% sure  [woken by a finished task] Agent "Review library-sync…
          answered by claude-fable-5-1 ✓ · $0.061 · 45k in, 98% cached · 1k out
     0ms  not routed — [general-purpose agent] Review library-sync cluster · not routed at spawn…
          answered by claude-opus-5-5 · $0.023 · 22k in, 82% cached · 0k out
   641ms  fable·medium  Jev 97% sure; capped from xhigh  help me plan the architecture
          answered by claude-fable-5-1 ✓ · $0.14 · 130k in, 91% cached · 2k out
   352ms  fable·low  stayed on fable: haiku would cost $1.02 vs $0.02  what is 2+2
          answered by claude-fable-5-1 ✓ · $0.02 · 47k in, 99% cached · 0k out
    12ms  not routed — gateway said HTTP 403 (customer_verification_required)
```

Everything here is in words. `Jev 61% sure` is Jev's confidence in the tier;
`only` appears under 50%. What follows the confidence is why the turn did not
run exactly as Jev asked: `stayed on fable: haiku would cost $1.02 vs $0.02`
is a downgrade the price held (see below), `stayed on fable: Jev wanted
haiku, only 61% sure` one the bar held, `capped from xhigh` the ceiling,
`as you asked` a tier the prompt named, `medium runs as high on a first
request` an engine quirk (see *Commands and switches*).

Not every turn is you typing, and the history says which are not. A prompt
that spawns background agents produces more turns than replies: each agent
that finishes wakes the main loop with a `<task-notification>`, and the engine
starts a fresh turn with that XML as its text. Those rows say `[woken by a
finished task]`, with the notification's summary in place of the envelope.
The engine's own nudge ("The user hasn't heard from you in a while") is a
turn too; it continues the last decision without asking Jev, is listed as
`[nudged by the engine, continuing]`, and writes nothing into the reply.

The agents themselves are the `[type agent]` rows. A subagent's loop gets no
`turn.start`; it is routed at `agent.spawn` instead, where its task is in
hand as text (see *Subagents* below). The row shows the tier Jev picked, or
why it was left alone (`Jev said sonnet but was only 22% sure (under 50%)`,
a timeout), with the model that answered it, so the requests one prompt
really caused are all on the screen. Nothing is written into a subagent's
reply: that text is a tool result its parent reads.

`answered by` is the API's own report, taken from the `usage` on each step's
`stop` chunk: which model actually answered, and what the turn's requests
carried. The route line is what the mod asked for; this is what it got. `✓`
means they agree (a dated id such as `claude-opus-5-5-20260901` still
counts); `answered by claude-opus-5 — asked for claude-fable-5-1` means
something else answered, which is the one case worth looking into. There is
no need to proxy traffic or force a bogus model id to check the rewrite
lands.

The dollars are the turn at Anthropic's list price (`hooks/pricing.ts`,
checked 2026-09-23, and checked live against the engine's own
`total_cost_usd`: $0.497 against $0.4967), with cache writes billed at the
one-hour rate Claude Code uses; `spent` in the header is the session's
total, routed turns and not. `98% cached` is the share of the turn's input
read from the prompt cache; the cache is per model, so the turn after a
switch runs cold, and that is what the hold below is for.

**The first line of every reply.** The route is written into the reply's
own text, as the first text chunk streams through `turn.step`:

```markdown
> ✳️ opus · high effort · Jev 98% sure · 555ms

---

Here is the implementation...
```

Markdown, because the line rides in the reply's text and that is what the
transcript renders, so it is the only styling available. The blockquote sets
it off from prose with a rail and dimmer text. The blank line before `---`
is load-bearing: a rule on the line directly after text is a setext heading
underline, and the route would render as a heading.

An unrouted turn opens with `> ⚠️ not routed · <why> · the session model
answers`. A held or capped turn says so in the same words as `/jev`:

```markdown
> ✳️ fable · low effort · stayed on fable: haiku would cost $1.02 vs $0.02 · 352ms
```

**The summary under every finished reply**, once, however many turns the
reply spanned. The top line is what the router asked for, before the reply
exists; the summary is what the API says it got, and it can only be written
once the response is whole:

```
──────────────────────────────────────────────────────────────────────────
Model  answered by claude-fable-5-1 ✓ at xhigh effort · Jev 97% sure, 641ms
Cost   $0.14 · 130k in, 91% cached · 2k out
```

A reply that spawned background work is several turns — the one you typed,
then one per task that finished and woke the loop — and a block under each
read as one reply changing model three times. So the summary waits until no
background agent is still running, then covers the lot:

```
─────────────────────────────────────────────────────────────────────
Model  3 turns: fable·xhigh ✓, opus·high ✓, fable·xhigh ✓ (2 woken by finished tasks)
Agents Explore on haiku ($0.02), general-purpose on opus ($0.31)
Cost   $28.10 · 7.4M in, 99% cached · 61k out
Note   turn 2: stayed on fable: haiku would cost $4.41 vs $0.13
```

`Note` rows say what did not run exactly as Jev asked, in the same words as
everywhere else. A mid-turn compaction is not the end of a reply (it was
taken for one once, and wrote a second summary under the same reply).

The summary is fenced because markdown collapses leading whitespace and
joins consecutive lines: unfenced, the rule and the rows render as one
run-on paragraph. `<details>` was tried first, for a fold; the desktop app
renders it as raw tags.

It is emitted as a chunk the hook built rather than one the engine streamed,
at **one past the last text block's index**, and only on a step whose stop
reason ends the turn — a `tool_use` step is mid-reply. The index is
load-bearing: a chunk yielded at an index the engine has already streamed is
dropped silently. Probed live, a chunk at `lastTextIndex` never reached the
transcript and one at `lastTextIndex + 1` did, so the summary opens a block
of its own and the reply above it is untouched.

Note that `claude -p` shows only the *last* text block in its `result`, so the
reply looks like it vanished when the summary lands. It has not:
`--output-format stream-json --verbose` shows both blocks whole.

`/jev quiet` drops both the line and the summary without turning routing
off; `/jev loud` brings them back. Both ride in the reply's recorded text, so
the model sees them on its own past replies; that is the standing cost of a
marker on a surface that draws neither render sites nor `ui.log`.

The line is part of the recorded message, so the model sees its own past
replies open with it. That is the cost of a marker that reaches the desktop
app: two cleaner mechanisms were tried first and neither drew there. An
`AssistantMessage` render rewrite was correct against the generated types
and drew nothing; `$.ui.log`, documented as a dim transcript row, also drew
nothing. That tab reports `$.session.surface()` as `unknown` and appears to
be an SDK host that drops both. Reply text and command output are the two
channels that reach it.

**The footer**, via `SessionMode`. Terminal only in practice, so treat its
absence as meaning nothing.

The app's own model indicator will never change. It shows the *session*
model, which this mod does not touch — the rewrite happens per request, in
`turn.step`.

## Commands and switches

- `/jev` prints the status above. `/jev on` and `/jev off` set routing
  explicitly rather than toggling blind.
- `/jev quiet` and `/jev loud` control the line at the top of each reply.
  Quiet still routes and still records, so `/jev` shows what you missed.
- `JEV_ROUTER_PROVIDER=typesafe|gateway` forces a specific provider. If both
  keys are set, the default is TypeSafe direct; use this to force the gateway.
- `TYPESAFE_BASE_URL=https://api.typesafe.ai` overrides the TypeSafe endpoint
  base (default). Only `api.typesafe.ai` / `*.typesafe.ai` are allowed unless
  `JEV_ROUTER_ALLOW_CUSTOM_BASE=1`.
- `JEV_ROUTER_ALLOW_OVERRIDE=0` disables natural-language tier overrides
  ("use opus"). On by default.
- `JEV_ROUTER_NOTIFY_CONTINUE=1` soft-continues task-notification turns on the
  previous route instead of re-asking Jev. Off by default.
- `JEV_ROUTER_EXCLUDE=fable,haiku` drops those tiers from the question
  entirely, so Jev is never offered them. Excluding all four is ignored.
- `JEV_ROUTER_TIMEOUT_MS=2500` changes how long a turn waits for Jev before
  giving up and running unrouted. The default is 1500ms. Ten live calls on
  2026-09-20 ran 402ms to 839ms, so an earlier 800ms default was failing open
  on the slowest of them.
- `/jev sticky` makes a tier switch clear a confidence bar before the model
  moves, and holds a downgrade that would cost more than it saves;
  `/jev sticky 0.6` sets the bar, `/jev sticky off` switches freely.
  `--sticky` works too. See below. **On by default** at 0.75.
- `JEV_ROUTER_STICKY=0` turns sticky off for a session; `JEV_ROUTER_STICKY_CONFIDENCE=0.6`
  sets the bar. The command overrides them from then on.
- `JEV_ROUTER_CACHE_TTL=5m` prices switches against the five-minute cache.
  The default is `1h`, which is what Claude Code writes (every one of 18,204
  writes in a week of transcripts, checked 2026-09-23).
- `/jev ceiling` shows the most effort each tier may be asked for;
  `/jev ceiling xhigh` raises every tier to it, `/jev ceiling xhigh fable`
  one tier, `/jev ceiling off` lifts every cap (which is `max`; the engine has
  no rung above it). **The default is `medium` on every tier.** A turn Jev
  wanted higher is cut to the ceiling and the route line says
  `capped from xhigh` for what it wanted.
- `JEV_ROUTER_CEILING=xhigh`, or `fable:xhigh,opus:high` for some tiers,
  seeds the ceiling; the command overrides it from then on. Two engine facts,
  measured 2026-09-23 on Claude Code 2.1.280 by the transcript's
  `perTurnEffort`: on Fable 5.1 the **first turn** of a conversation runs
  `medium` as `high` (five of five; honoured from the second turn on, three
  of three), so the router sends `high` there and the route line says so,
  while the turn after starts from the `medium` Jev asked for
  (`FIRST_TURN_EFFORT` in policy.ts is the whole table); and the engine
  sends **no effort at all to Sonnet 5** (`perTurnEffort` absent), so the
  Sonnet effort hold below is a no-op on that build. Opus 5.5 honours all
  five. Fable effort changes between turns are free: medium→low→medium wrote
  638 and 286 tokens, not the messages block.
- `JEV_ROUTER_JEV_MODEL=jev-1.13.0` pins the Jev version on the direct API.
  The default `jev-latest` is an alias that moves when TypeSafe ships, and
  the confidences the bar is tuned against can move with it. A passthrough
  such as OpenRouter spells the same pin `jev-1.13`.

## Holding a shaky switch, and a switch that costs more than it saves

The prompt cache is per model. A session cached under fable is cold for
haiku, so the turn that switches writes its whole context to haiku's cache,
and the turn that comes back writes it all again to fable's, at $20 per
million tokens. Over a week of this machine's transcripts (18,459 requests,
checked 2026-09-23) the median context at a main-thread switch was 150k to
330k tokens, and 31 of 38 returns from haiku to fable paid that re-write in
full: a trivial question answered on haiku at 234k cost about $4.40 in cache
writes to save $0.07 of output. A router that follows Jev's word at that
size costs more than never routing at all — measured, not modelled: over 255
routed turns the shipped policy came to $92 where staying put came to $8.

Before either bar, one rule that nothing lifts: **the tier has to take the
prompt at all.** Haiku 4.5's window is 200k tokens; the rest take a
million. A turn carrying more than a tier's window (less 16k for the prompt
and the reply) is not sent there, whatever Jev said, whatever the price,
and even when the prompt named it — the API would refuse it with "Prompt is
too long", and a week of transcripts holds three of those, each right after
a turn at 358k–605k was routed to haiku. The turn stays on the tier already
running (`stayed on fable: haiku takes 200k and this turn carries 310k`),
or, with nothing running, on the session model.

So a switch has to clear two bars, and `/jev sticky off` lifts both:

- **Jev's doubt.** A turn that names a different tier than the last one has
  to clear the confidence bar (0.75) to move. An **upgrade past 100k
  context** has to clear 90% (or the bar, if higher): it writes the whole
  context to the dearer tier, five dollars for fable at 250k, and over a
  week of transcripts 54 of 72 routed upgrades ran under 75% confidence and
  7 more under 90%, every one past 100k, while prompts that are plainly
  planning work measure 0.97 to 1.00 (`UPGRADE_CONTEXT_TOKENS`,
  `UPGRADE_CONFIDENCE` in policy.ts). `use fable` is not an upgrade in this
  sense and is never held.
- **The price, for a downgrade.** The turn is priced twice, from the context
  the engine reports it will carry and the last turn's output: on the running
  tier with its cache warm, and on the cheaper tier cold with the return
  write added. If going costs at least what staying does, it stays. An
  upgrade is never priced: whether the task needs fable is Jev's call, not
  the cache's.

Held either way, the turn runs on the tier already loaded, and says so:

```
> ✳️ fable · low effort · stayed on fable: Jev wanted haiku, only 61% sure · 512ms
> ✳️ fable · low effort · stayed on fable: haiku would cost $4.41 vs $0.13 · 301ms
```

The first: Jev wanted haiku, was 61% sure, and the bar is 75%. The second:
Jev was sure, and going ($4.41) cost more than staying ($0.13). The same
words appear in the summary and in `/jev`, because a hold nobody can see is
indistinguishable from a router that is not running; `/jev` also prints the
context it is pricing against and where the cheapest downgrade stops paying
(`fable→haiku pays below 3k`), so a hold is never a surprise.
`npm run measure-switch-cost` prints the whole table.

What this means in practice: on a fable- or opus-homed session, the main
loop's tier is settled in its first few turns while the context is small and
a switch is cheap, and after that the router's work is picking the **effort**
on the tier already warm (a trivial question on fable at `low` is a few cents;
the same question after a detour to haiku is dollars), moving **up** when a
task needs it, and routing **subagents**, which start with an empty
conversation and so have no cache to lose. A compaction empties the cache and
the context both, so the hold is dropped and the next turn starts from Jev;
so does `/clear`.

A session the router did not route from the start is still running on
something. On `claude --resume` the engine says what (`classic.SessionStart`:
the model, the context, and whether the cache has likely expired), and the
first routed turn is priced against that model's warm cache — `/jev on` after
a stretch off, or a plugin loaded into a live session, seeds the same from
`$.session.model()` when the engine reports context. A session on a model
off the ladder (`claude-opus-5`, say) that Jev keeps on the same rung is a
switch too, to `claude-opus-5-5` and a cold cache, and is priced like a
downgrade: at 200k it stays, and the line says `stayed on claude-opus-5:
claude-opus-5-5 would cost $3.63 vs $0.14`. `/model` mid-session moves what
the next routed turn is priced against. `/jev` shows all of this on its
`session` line.

Only the model is held, on Opus and Haiku. There the effort Jev asked for is
applied either way, since the engine sends it per request and it costs no
cache: a held turn still thinks harder or less hard than the one before it.
Sonnet is the exception, measured 2026-09-22: an effort change there rewrites
everything after the system block, about half the prefix. So a turn that
stays on Sonnet also holds its effort unless Jev's confidence in the effort
score (a separate number from the tier's, and usually the shakier) clears the
same bar; the line says `kept medium effort: Jev wanted xhigh, only 49% sure`.

What the next turn holds to is the tier actually running, not the one Jev
named. Three shaky haiku calls in a row will not creep the session onto haiku
one turn at a time. An unrouted turn leaves the sticky hold alone (nothing
routed to hold to), but clears what a bare go-ahead would continue: that turn
ran on the session model, so "yes" must not re-apply the older routed tier.
A go-ahead with nothing to continue stays on the session model and does not
ask Jev (which would clear sticky with a near-certain haiku pick). `/jev off`
clears both the sticky hold and the continue target for the same reason.

The bar starts at 0.75, which is a starting point rather than a measured
optimum. Retune it in place with `/jev sticky 0.6` and watch the next few
turns; `npm run try-prompts` prints Jev's confidence across a set of prompts,
which is the other input to picking a number. `/jev sticky` on its own keeps
a bar you have already set, so turning it off and on again does not lose it.

A session that wants sticky **off** can say so before it starts, with
`JEV_ROUTER_STICKY=0` in the `env` block of settings.json. The command wins
after that. Sticky is on by default at 0.75.

## Two things stickiness cannot catch

**A bare go-ahead.** Jev reads "yes", "ok", "go ahead" as trivial with
near-total confidence (measured: "yes" 1.00, "y" 0.98), which clears any bar
and drops a fable task to haiku. It is right about the text and wrong about
the work, which is whatever the last turn proposed. So a prompt that is only
a go-ahead (`y`, `yes`, `ok`, `sure`, `go ahead`, `continue`, `do it`, `lgtm`
and the like, trailing punctuation aside) runs on the previous turn's tier and
effort without asking Jev, tagged `continue`. Anything longer is a prompt.

**A tier you named.** "use opus for this" used to score opus at 0.43 under
the sticky bar, so stickiness refused it. A tier named with a run-on verb
(`use`, `do it using`, `switch to`, `route to`, `run this on`, `go with`) is
taken as read, **skips Jev entirely**, uses medium effort, and is tagged
`forced`. Bare "on", "for", "with", and "using" are not verbs here: "search
for opus docs" is a search, "happy with opus" and "I'm using opus for
comparison" are not routes. Negations skip only the first run-on after them,
so a later affirmative still wins ("don't use haiku use opus" → opus). "why
not use opus" is an affirmative ask. A tier the environment excluded cannot
be named back in. `JEV_ROUTER_ALLOW_OVERRIDE=0` disables this channel.

## Subagents

Each spawn is classified on its own prompt at `agent.spawn` and given the
model Jev picks, unless the call named a model itself or is a fork (which
inherits, and whose model the engine ignores). The subagent's own steps then
carry that model and effort. There is no hold to the parent's tier: a
subagent starts with an empty conversation, so there is no cache to keep
warm; measured, a haiku loop under a fable parent cost $0.023 against about
$0.34 inherited. What there is instead is a floor, `SUBAGENT_CONFIDENCE` in
policy.ts (0.5, calibrated on subagent-style prompts: the specified ones
scored 0.72 to 0.98, a vague audit 0.22). Under it the spawn is left alone
and `/jev` says so.

## Checking and tuning

```
npm run check-jev        # is the configured provider serving?
npm run try-prompts      # what tier does Jev give a spread of prompts?
npm run try-prompts -- "your prompt"
```

`check-jev` detects which provider is configured and runs the appropriate
diagnostic. For the gateway it checks credits; for TypeSafe direct it makes a
live call. `try-prompts` is the tuning loop: edit `TIER_CRITERIA`, run it, and
see whether the picks moved the way you wanted. Neither script ever prints the key.

Measured on 2026-09-20 against the shipped criteria:

```
  ms  tier    effort  conf  prompt
 839  haiku   low     1.00  what is 2+2
 508  haiku   xhigh   0.86  what does this function return
 402  haiku   medium  0.75  rename the variable foo to bar in utils.ts
 482  sonnet  medium  0.66  add a --verbose flag to the CLI
 426  opus    high    0.66  write a test for the pagination helper
 555  opus    high    0.98  implement cursor pagination for the reports endpoint
 483  opus    xhigh   0.97  refactor the auth module to use the new session interface
 641  fable   xhigh   0.97  the e2e suite passes alone but fails with the others
 734  fable   xhigh   1.00  help me plan the architecture for multi-tenant billing
 479  fable   xhigh   1.00  should we use event sourcing here or is that overkill
```

Note row two. Tier and effort are separate questions, so they can disagree:
an out-of-context question reads as trivial to route but hard to answer. The
engine silently downgrades an effort the chosen model does not support, so
this is harmless, but it is why a `haiku·xhigh` label is possible.

## When it does nothing

The router fails open at every step, and a turn it cannot decide runs exactly
as it would without the mod:

- no `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, no request is made at all
- the provider takes longer than the timeout (1500ms by default)
- the provider refuses the key, errors, or returns a body we cannot read
- Jev names a tier that was not offered

The only cost of a failure is the latency spent waiting, capped at the timeout.

Low confidence is not a failure. The pick is used and the line marks it, so
`> ✳️ opus · high effort · Jev only 40% sure` means Jev was under 50% sure of the tier.

An unrouted turn announces itself too, with the reason:

```
> ⚠️ not routed · gateway said HTTP 403 (customer_verification_required) · the session model answers
```

## Layout

```
hooks/register.ts   the seven hooks, the settings read once, the turn history
hooks/jev.ts        the request shape, timeout, named failures
hooks/provider.ts   which backend (TypeSafe direct or gateway) to use
hooks/policy.ts     the tiers, the criteria, answers → model and effort,
                    the ceiling, what a hold is
hooks/pricing.ts    Anthropic's list prices; what a turn cost, what a switch
                    would cost
hooks/label.ts      decision → SessionMode label
hooks/status.ts     the per-turn line, what /jev prints, usage per turn
tests/              node:test suites; register.test.ts drives the real hooks
                    with a fake engine and asserts the stream transform
scripts/            check-jev, try-prompts and measure-switch-cost, for
                    setup and tuning
```

`jev.ts` takes `fetch` and `sleep` as arguments rather than importing them, so
the tests run with no engine and no network. `provider.ts` is pure: it takes
environment variables and returns which provider to use, with all credentials
and endpoints already resolved.

## Working on it

```
npm run types    # once: fetches Anthropic's claude-code.d.ts into .claude/types (gitignored)
npm run check    # typecheck, tests, plugin validate
git config core.hooksPath scripts/githooks   # once per clone: validate before every commit
```

`plugin validate` is not optional. It does static analysis and prints every
event the module hooks, everything it calls on `$`, and every environment
variable it reads or writes, without executing anything. It also applies the
engine's load-time rule that `$` may only be passed to a function declared at
the top of the file: a closure inside `register` that takes `$` makes the
whole module refuse to load, and it does so silently, so every turn runs
unrouted while `tsc` and the tests pass (measured 2026-09-23; the only other
trace is `hooks module ... failed to load` in `~/.claude/debug/`). The
pre-commit hook exists for that. It also catches shape errors that are easy to
get wrong, such as `turn.step` needing to be an `async function*` because it
streams.

There is no `claude plugin test` in Claude Code 2.1.275, so the engine-level
test kit described in the upstream `mods/README.md` is not available yet.

## Backends

Both backends speak the same `choice` and `score` question types and the same
`answers` response shape, so the request/response handling is identical.

**TypeSafe direct** endpoint: `POST https://api.typesafe.ai/v1/systemone`.
Bearer auth, body is `{ model: "jev-latest", state, questions }`. Probabilities
and confidences come back rounded to four decimal places. Supports all three
question types: `choice`, `score`, and `noul`.

**Vercel AI Gateway** endpoint: `POST https://ai-gateway.vercel.sh/v1/evaluate`.
Bearer auth, body is `{ model, state, questions }` (the gateway ignores the
model field). Probabilities and confidences come back rounded to two decimal
places. Only supports `choice` and `score` — the gateway rejects `noul` outright.
