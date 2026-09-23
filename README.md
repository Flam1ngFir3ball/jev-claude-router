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
              first text chunk ← '> ✳️ `fable` · xhigh · 97% · 641ms\n\n---\n\n' + text
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
  provider  typesafe · TYPESAFE_API_KEY is set
  budget    1500ms
  sticky    on, switch needs 75%
  low       on (JEV_ROUTER_LOW_OFF=1)
  medium    off for all · capped at medium
  xhigh     off for all · capped at high
  tiers     haiku, sonnet, opus, fable

  Recent turns, newest first:
   653ms  fable·medium 0.61  [notify] Agent "Review library-sync cluster" com…
          answered claude-fable-5-1 ✓  cache 98%  45k in  1k out
     0ms  unrouted — [agent:general-purpose] Review library-sync cluster
          answered claude-opus-5-5  cache 82%  22k in  0k out
   641ms  fable·medium 0.97  help me plan the architecture
          answered claude-fable-5-1 ✓  cache 91%  130k in  2k out
   402ms  haiku·medium 0.75  rename the variable foo to bar
          answered claude-haiku-4-5 ✓  cache 4%  128k in  0k out
    12ms  unrouted — gateway said HTTP 403 (customer_verification_required)
```

Not every turn is you typing, and the history says which are not. A prompt
that spawns background agents produces more turns than replies: each agent
that finishes wakes the main loop with a `<task-notification>`, and the engine
starts a fresh turn with that XML as its text. Those are tagged `[notify]`,
with the notification's summary in place of the envelope, and the same tag
rides in the route line and footer of the reply they produce (`· notify ·`).
Without it, one prompt that dispatched three reviewers reads as one reply that
changed model three times.

The agents themselves are the `[agent:type]` rows. A subagent's loop gets no
`turn.start`; it is routed at `agent.spawn` instead, where its task is in
hand as text (see *Subagents* below). The row shows the tier Jev picked, or
why it was left alone (`under the 0.5 bar`, a timeout), with the model that
answered it, so the requests one prompt really caused are all on the screen.
Nothing is written into a subagent's reply: that text is a tool result its
parent reads.

The same `answered` information is under each reply as it happens, in the
footer below; `/jev` is where you go to see it across turns.

An unrouted turn says why. That matters because the router fails open, so a
dead provider and a missing plugin look identical from the outside.

The `answered` line under each turn is the API's own report, taken from the
`usage` on each step's `stop` chunk: which model actually answered, and what
the turn's requests carried. The route line above it is what the mod asked
for; this is what it got. `✓` means they agree (a dated id such as
`claude-opus-5-5-20260901` still counts); `≠ claude-opus-5-5` means something else
answered, which is the one case worth looking into. There is no need to proxy
traffic or force a bogus model id to check the rewrite lands.

`cache` is the share of the turn's input read from the prompt cache. The
cache is per model, so the turn after a switch runs cold: `cache 4%` on the
haiku turn above is the price of leaving fable. Cache reads bill at a tenth of
uncached input, so a switch on a large context costs roughly ten times what
staying would have, once. Watch this number to see whether Jev's switching is
eating what the cheaper tiers save.

**The first line of every reply.** The route is written into the reply's
own text, as the first text chunk streams through `turn.step`:

```markdown
> ✳️ `opus` · high · 98% · 555ms

---

Here is the implementation...
```

Markdown, because the line rides in the reply's text and that is what the
transcript renders, so it is the only styling available. The blockquote sets
it off from prose with a rail and dimmer text; the tier is inline code,
which the theme colours. The blank line before `---` is load-bearing: a
rule on the line directly after text is a setext heading underline, and the
route would render as a heading.

An unrouted turn opens with `> ⚠️ \`unrouted\` · reason`. A `?` after the
percentage means Jev was under 50% sure.

**The footer under every finished reply**, which is the same information
settled. The top line is what the router asked for, before the reply exists;
the footer is what the API says it got, and it can only be written once the
response is whole:

```
──────────────────────────────────────────────────────
jev  fable·xhigh · 97% · 641ms
api  claude-fable-5-1 ✓ · cache 90% · 130k in · 1k out
```

`api` is read off the `usage` on the step's stop chunk, so `✓` is the API's
own confirmation that the model rewrite landed — no proxy, no bogus model id.
A dated id such as `claude-fable-5-1-20260901` still counts as a match; a real
mismatch reads `claude-opus-5-5 ≠ claude-fable-5-1`.

`cache` is the share of the turn's input read from the prompt cache. The cache
is per model, so the turn after a switch runs cold:

```
─────────────────────────────────────────────────────
jev  haiku·medium · 75% · 402ms
api  claude-haiku-4-5 ✓ · cache 4% · 128k in · 0k out
```

That `4%` is the price of leaving fable. Cache reads bill at a tenth of
uncached input, so a switch on a large context costs roughly ten times what
staying would have, once. Watch it to see whether the switching is eating what
the cheaper tiers save.

The footer is fenced because markdown collapses leading whitespace and joins
consecutive lines: unfenced, the rule and the two rows render as one run-on
paragraph. `<details>` was tried first, for a fold; the desktop app renders it
as raw tags.

It is emitted as a chunk the hook built rather than one the engine streamed,
at **one past the last text block's index**, and only on a step whose stop
reason ends the turn — a `tool_use` step is mid-reply. The index is
load-bearing: a chunk yielded at an index the engine has already streamed is
dropped silently. Probed live, a chunk at `lastTextIndex` never reached the
transcript and one at `lastTextIndex + 1` did, so the footer opens a block of
its own and the reply above it is untouched.

Note that `claude -p` shows only the *last* text block in its `result`, so the
reply looks like it vanished when the footer lands. It has not:
`--output-format stream-json --verbose` shows both blocks whole.

`/jev quiet` drops both the line and the footer without turning routing off;
`/jev loud` brings them back. Both ride in the reply's recorded text, so the
model sees them on its own past replies; that is the standing cost of a marker
on a surface that draws neither render sites nor `ui.log`.

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
- `TYPESAFE_BASE_URL=https://api.example.com` overrides the TypeSafe endpoint
  base (defaults to `https://api.typesafe.ai`). Useful for custom deployments.
- `JEV_ROUTER_EXCLUDE=fable,haiku` drops those tiers from the question
  entirely, so Jev is never offered them. Excluding all four is ignored.
- `JEV_ROUTER_TIMEOUT_MS=2500` changes how long a turn waits for Jev before
  giving up and running unrouted. The default is 1500ms. Ten live calls on
  2026-09-20 ran 402ms to 839ms, so an earlier 800ms default was failing open
  on the slowest of them.
- `/jev sticky` makes a tier switch clear a confidence bar before the model
  moves, `/jev sticky 0.6` sets that bar, `/jev sticky off` stops. `--sticky`
  works too. See below.
- `JEV_ROUTER_STICKY=1` and `JEV_ROUTER_STICKY_CONFIDENCE=0.6` set the same
  thing for a session before it starts, for a project that always wants it.
  The command overrides them from then on.
- `/jev low off` blocks effort above low (medium through max) on every tier
  and caps those turns at `low`; `/jev low off opus` for one tier;
  `/jev low on` turns it back on. Opt-in — unset leaves medium allowed.
- `JEV_ROUTER_LOW_OFF=1` (or `all`) seeds the low ceiling; `0`/`off` clears it.
- `/jev medium off` blocks effort above medium (high, xhigh, and max) on
  every tier and caps those turns at `medium`; `/jev medium off opus` for one
  tier; `/jev medium on` / `/jev medium on fable` turn it back on. The route
  line says `capped:high` (or `capped:xhigh`) when a turn was cut down.
  **Off for all tiers is the default** (session ceiling is medium).
- `JEV_ROUTER_MEDIUM_OFF=0` (or `off`/`false`/`none`) allows high;
  unset/`1`/`all` keeps the default medium ceiling; `opus,fable` for named
  ones. The command overrides.
- `/jev xhigh on` allows effort at or above xhigh (xhigh and max) on every
  tier; `/jev xhigh on fable` for one tier; `/jev xhigh off` / `/jev xhigh off opus`
  block it again and cap those turns at `high`. Also **off by default** —
  raise the ceiling with `/jev medium on` then `/jev xhigh on`.
- `JEV_ROUTER_XHIGH_OFF=0` (or `off`/`false`/`none`) allows xhigh everywhere;
  unset/`1`/`all` keeps the default block; `opus,fable` blocks only named
  ones. The command overrides.

## Holding a shaky switch

The prompt cache is per model. A session cached under fable is cold for
haiku, so the turn that switches pays full input tokens and a slower first
token. A router that flips tier on a 51% hunch can pick the cheaper model
every time and still cost more than staying put.

Run `/jev sticky` and a turn that names a different tier than the last one
has to clear the bar to move. Below it, the turn runs on the tier already
loaded, and says so:

```
> ✳️ `fable` · low · 61% · held:haiku · 512ms
```

Jev wanted haiku, was 61% sure, and the bar is 75%, so the turn stayed on
fable. The same `held:haiku` appears in the footer and in `/jev`, because a
hold nobody can see is indistinguishable from a router that is not running.

Only the model is held, on Opus and Haiku. There the effort Jev asked for is
applied either way, since the engine sends it per request and it costs no
cache: a held turn still thinks harder or less hard than the one before it.
Sonnet is the exception, measured 2026-09-22: an effort change there rewrites
everything after the system block, about half the prefix. So a turn that
stays on Sonnet also holds its effort unless Jev's confidence in the effort
score (a separate number from the tier's, and usually the shakier) clears the
same bar; the footer says `held-effort:xhigh` for what Jev wanted.

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

A session that should always be sticky can say so before it starts, with
`JEV_ROUTER_STICKY=1` in the `env` block of settings.json. The command wins
after that.

## Two things stickiness cannot catch

**A bare go-ahead.** Jev reads "yes", "ok", "go ahead" as trivial with
near-total confidence (measured: "yes" 1.00, "y" 0.98), which clears any bar
and drops a fable task to haiku. It is right about the text and wrong about
the work, which is whatever the last turn proposed. So a prompt that is only
a go-ahead (`y`, `yes`, `ok`, `sure`, `go ahead`, `continue`, `do it`, `lgtm`
and the like, trailing punctuation aside) runs on the previous turn's tier and
effort without asking Jev, tagged `continue`. Anything longer is a prompt.

**A tier you named.** "use opus for this" scores opus at 0.43, under the bar,
so stickiness refused it. A tier named with a run-on verb (`use`, `do it using`,
`switch to`, `route to`, `run this on`, `go with`) is taken as read,
needs no answer from Jev, and is tagged `forced`. Jev's effort still applies.
Bare "on", "for", "with", and "using" are not verbs here: "search for opus
docs" is a search, "happy with opus" and "I'm using opus for comparison" are
not routes. Negations skip only the first run-on after them, so a later
affirmative still wins ("don't use haiku use opus" → opus). "why not use
opus" is an affirmative ask. A tier the environment excluded cannot be named
back in.

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
`> ✳️ \`opus\` · high · 40%?` means Jev was under 50% sure of the tier.

An unrouted turn announces itself too, with the reason:

```
> ⚠️ `unrouted` · gateway said HTTP 403 (customer_verification_required)
```

## Layout

```
hooks/register.ts   the six hooks, the per-turn cache, the turn history
hooks/jev.ts        the request shape, timeout, named failures
hooks/provider.ts   which backend (TypeSafe direct or gateway) to use
hooks/policy.ts     the tiers, the criteria, answers → model and effort
hooks/label.ts      decision → footer string
hooks/status.ts     the per-turn line, what /jev prints, usage per turn
tests/              node:test suites; register.test.ts drives the real hooks
                    with a fake engine and asserts the stream transform
scripts/            check-jev and try-prompts, for setup and tuning
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
