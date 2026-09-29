# Changelog

<!--
  Every entry after 1.0.0 groups its items under "### Features" and
  "### Fixes" (only the sections that apply; a chore-only release can use
  "### Chores" instead). State what changed plainly — not how it was found
  (an audit, a bug report, a review) and not the investigation that went
  into it.
-->

## Unreleased

Ready and merged, held back from a version bump until approved:

### Features

- **The effort ceiling now defaults to `xhigh`**, matching the engine's own
  default, instead of `medium`. `JEV_ROUTER_CEILING` or `/jev ceiling`
  still adjust it per session, in either direction.

### Fixes

- **`/jev tiers off` on a tier already running.** Stickiness and the price
  checks no longer stay on a tier that has since been turned off — except
  when nothing was ever actually routed there (a session resumed onto that
  tier, say): staying on that genuinely-warm cache is still weighed against
  the real cost of switching, rather than forcing an expensive cold switch
  for no benefit. A task notification continuing an open reply now also
  asks Jev when that reply's tier has since been dropped, instead of
  silently going unrouted.
- **Outgrowing a tier's context window no longer falls through to fully
  unrouted just because the tier that was running got turned off.** It
  steps up to the next tier that fits, same as it always did when nothing
  was excluded.
- **The last-tier guard could keep the wrong tier on.** Naming an
  already-excluded tier last in `/jev tiers off` (e.g. one tier on, `/jev
  tiers off fable haiku` where haiku was already off) turned the actual
  last tier off and brought the redundant, already-off one back instead.
- **An old snapshot could silently clear `JEV_ROUTER_EXCLUDE`.** A session
  snapshot saved before tier exclusion was persisted restored as "nothing
  excluded," overwriting the environment's own setting the moment such a
  snapshot was resumed.
- **`JEV_ROUTER_EXCLUDE` naming every tier could invert the next `/jev
  tiers` command.** The full-ladder fallback made everything offered, but
  the stored exclusion list didn't agree with that, so the first tier
  command afterward read the stale list and acted on the wrong tier.
- The excluded-tiers display could claim every tier was both offered and
  off at once, when every tier was named excluded and the full-ladder
  fallback kicked in.
- **A reply that opened with its own `> ⚠️` warning lost it.** Only a
  line of the route line's own shape (a tier and Jev's latency, or
  `not routed:`) is now taken for a copied route line. A reply opening
  with two such warnings also used to switch routing off for the rest of
  that turn; it no longer does.
- **A reload or resume ignored a changed `JEV_ROUTER_*`.** The session
  snapshot restored sticky, the ceiling, excluded tiers, compact and the
  price checks over the environment whether or not a `/jev` command had
  set them. Only what a command set now outranks the environment.
- **A corrupt snapshot could send a request with no effort.** A ceiling
  missing a tier, or decisions on an unknown tier or effort, are refused.
- **The `sonnet` tier runs Claude Sonnet 5.5** (`claude-sonnet-5-5`), not
  the previous-generation `claude-sonnet-5`.
- **Prices:** Claude Fable 5 and Mythos 5 read the cache at $1/MTok (only
  5.1 reads at $0.25), and Claude Opus 4 and 4.1 cost $15/$75.
- **Gateway confidence** is the chosen tier's probability, not the largest
  one, and probabilities are clamped to 0–1.
- **`JEV_ROUTER_COMPACT_MIN_REDUCTION=1%`** means one percent, not all of
  it. A pruning reused between the engine's two compaction passes is held
  to the same minimum, and `/jev` shows its figures.
- **`/jev sticky` and `JEV_ROUTER_STICKY_CONFIDENCE`** take plain decimals:
  `%` always means a percentage, a bare number past 1 must be whole
  (`1.5` is refused), and hex is refused.
- **`JEV_ROUTER_TIMEOUT_MS` below 100** is taken for a mistake (seconds
  written as `1.5`) and the default used.
- **Provider settings:** a whitespace-only `TYPESAFE_API_KEY` no longer
  beats a real gateway key, keys are trimmed, and a `TYPESAFE_BASE_URL`
  ending in `/v1/systemone` no longer has the path doubled.
- **A switch interrupted before any response** no longer counts the new
  tier as warm when the next turn is priced.
- **The Sonnet effort hold** no longer holds to an effort the ceiling cuts
  anyway.
- **`/jev --on`, `--off`, `--quiet` and `--loud`** work like `--sticky`.
- **Display:** the footer no longer says "only 0% sure" for a tier you
  named or a failed Jev call; `1000k` reads `1.0M`; dollar figures just
  under $0.10 and $0.01 no longer show an extra digit; the `/jev` usage
  text lists `tiers`; the sticky line names `/jev sticky on`; the cache
  line skips tiers turned off and a subagent's output.

- **Talk about a tier no longer forces it.** A route phrase counts only
  when what opens its clause is a softener, a scope or a way of asking
  ("yes use opus", "can we use opus?", "for the migration use fable",
  "- use opus", "feel free to use opus"). Prose that only mentions a tier
  ("should I use opus or sonnet?", "they want to use opus", "the job will
  switch to haiku", "I told you not to use haiku", a `// use opus` comment)
  is an ordinary prompt. Held to a labelled set of 241 prompts in the tests;
  typos and shorthand ("plz", "can u"), `@claude`, and list markers
  (`+`, `- [ ]`, `(1)`, `a)`) are read as requests, as are "switch over
  to", "switch the model to" and a backticked tier (``use `opus` ``). A
  `// …` code comment line outside a fence is not read for it.
- **A finished task's result is not sent to Jev.** A notification that
  asks Jev sends only the task's one-line summary. The README has a new
  "What leaves your machine" section.
- **Resuming another session in the same process** no longer carries the
  previous session's `/jev` settings or on/off state into it, and releases
  the previous session's claim so another process can route it later.
  Day-old claims on sessions that never saved are cleaned up.
- **A task finishing after its reply was summarised** no longer writes a
  second route line and summary when the earlier turn went unrouted or
  `JEV_ROUTER_NOTIFY_CONTINUE=0`.
- **The subagent record is trimmed** to running agents past its limit; it
  used to keep every finished one and grow the snapshot without bound.
- **A switch counts as warm once the new model starts answering**, even
  if the turn is interrupted before usage arrives, and a switch still
  awaiting its first answer survives a reload.
- **Route lines are always one line**, whatever the failure reason says,
  and never show a negative latency.
- **Footer label:** no "only N% sure" on a held turn (that confidence is
  in the tier it did not move to) or on a go-ahead. A failed Jev call on an
  outgrown tier reads as a step up, not "kept".
- **Compaction:** `/jev` counts only results that were actually cut, and
  rebuilt tool results keep `isError: false`. Cuts in the Jev request and
  the compaction state no longer split an emoji. The timeout's timer ends
  with the call (so `npm run try-prompts` no longer waits out the full
  timeout), a fetch that throws at once is a failure rather than a
  rejection, and a provider's error text is kept as plain words.
- **Settings:** `JEV_ROUTER_COMPACT_TIMEOUT_MS` below 100 is taken for a
  mistake (a small budget above that is honoured); `JEV_ROUTER_EXCLUDE` accepts semicolons and spaces;
  `JEV_ROUTER_UPGRADE_MAX` refuses negatives and hex, as the timeouts now
  do; `JEV_ROUTER_STICKY_CONFIDENCE=60.5` is 60.5% again (only `1`–`10`
  must be whole); `JEV_ROUTER_PROVIDER` accepts `vercel` and `direct`.

- **A reload mid-turn keeps what the old copy had not saved yet**: the new
  copy takes its live state for the same session, so the spend and summary
  of a long tool-using turn are no longer short by the last few steps.
  Spend and the warm model while `/jev off` are saved too.
- **`/model` right after `/resume`** into another session is no longer
  undone by that session's snapshot.
- **An expired cache** is saved with the session and is judged afresh on
  each resume, so it neither carries into another session nor is lost on a
  reload.
- **A go-ahead after the engine's summary compaction** continues on the
  tier that proposed the work instead of running unrouted.
- **Fable's first-request effort** applies to the conversation's first
  request only, not to every step of its first turn.
- **The question to Jev says who wrote the text**: a subagent's task and a
  finished task's report are framed as such, not as a developer's request.
- **A finished task that wakes an idle session** gets its route line again
  when the previous turn ended without a summary.
- **Past the agent limit**, failed and killed agents are dropped before
  completed ones, which a message could still resume. A spawn another hook
  denied is not recorded. A subagent's compaction no longer replaces the
  main loop's saved scoring.
- **`/jev`:** `/jev -- off` and tabs between words are read as typed;
  `/jev tiers` and `/jev ceiling` take commas; `/jev sticky` takes
  `false`, `no` and `none` as off. The status names why the provider is not
  set up instead of always saying "no keys", reads a `[1m]` session model
  as the one running, and says an upgrade limit of 0 plainly. A held turn's
  summary no longer shows the other tier's confidence as its own; a
  multi-turn summary marks a tier you named; a running tier that was turned
  off is not called outgrown.
- **Snapshots:** every stored attempt is checked before it is trusted, as
  are the sticky bar and the last context size; old snapshots are pruned by
  when they were last saved, so a long-running session is never the one
  dropped.
- **A tier you named that did not fit** (kept on the running tier, or
  stepped up past it) reads "you picked haiku", not "your pick" on the tier
  that actually ran.
- **A reload never takes the old copy's state over a newer snapshot**
  another process saved in the same session; and a resume that says the
  cache expired is not overruled by the resumed session's snapshot.
- **`/clear` and a resume into another session** forget the previous
  conversation's compaction and finished agents; an agent still running
  across `/clear` keeps its routing.
- **Agents:** one spawned a moment ago, not yet listed, outlives completed
  ones past the limit; an agent the router left alone (named model, fork)
  gets one history row, not one per turn.
- **A reply of the engine's nudges alone** no longer grows the snapshot
  without end: past 64 turns the oldest after the person's own go, so the
  reply is still summarised. `/jev quiet` given mid-turn drops that turn's
  line too.
- **The cache line's break-even** is the cold one after an expired resume,
  and never rounded up (`pays below 450`, `4.1k`).
- **A negative token count** from the API counts as none, instead of a
  negative cost and a snapshot that can no longer load. A fetch that
  rejects with something other than an Error is still a named failure.
- **Reloads in a row, and a reload before a session's first save**, keep
  what the replaced copy held: the handoff follows the copy that holds the
  session in the store, and each copy carries on the save time it took over.
- **`/clear` then `/resume` into the old session** restores it instead of
  starting it empty and overwriting its snapshot; leaving a session (by
  `/clear` or a resume elsewhere) saves it first.
- **A notification that continued the route** no longer shows the earlier
  turn's "Jev N%" as if Jev had scored it.
- **Every numeric setting takes the same plain decimals** (no sign, hex or
  exponent; `1000.` is fine), and **every on/off setting the same off
  words** (`0`, `false`, `no`, `off`, `none`): `JEV_ROUTER_PRICE_CHECK=none`
  and `JEV_ROUTER_COMPACT=none` used to leave them on.
  `JEV_ROUTER_CEILING` takes semicolons and spaces between its parts.
- **The footer shows Jev's doubt on a notification Jev was asked about**,
  and none on one that continued the route.
- README examples now match what the plugin prints: the effort-cap
  diagram under the `xhigh` default, the summary and `/jev` costs, the
  agents line and dollar formats.
- **A claim left by a process that was killed** (no `session.end`) expires
  after 30 minutes unrefreshed, instead of leaving an older live copy
  unrouted for that session for good. The holder refreshes a separate
  `seen:` record every few minutes; the owner record itself stays the bare
  number earlier versions read, so a process still on an earlier version
  and this one never both act on a session.
- **Forks and other agents the router leaves alone** are kept apart from
  routed ones (their later turns too) and capped, so they neither grow the snapshot nor push out a
  routed agent. `/clear` with an unreadable agent list keeps running agents'
  routing.
- **Long inputs stay fast:** naming a tier in a 20k-character prompt took up
  to a minute, a reply ending in 100k blank lines about ten seconds, and a
  long run of spaces in an error message as long; each is now milliseconds.
- **Names from outside the plugin** (an agent's type, a model id, a task's
  summary) lose backticks, newlines and angle brackets before they are
  shown, so they cannot close the summary's fence or start a heading that
  reads as plugin output; `[1m]`, `_`, `#` and `|` stay as written.
- **A resume into another session** reads that session's model afresh
  instead of keeping the one this process was on, and an agent the router
  left alone keeps its single history row across a reload.
- **Every 33rd routed turn lost its route line, summary and usage row**:
  the trim of in-flight turns could evict the turn just started. The new
  turn is never the one trimmed.
- **A tier turned off** is no longer held to after an engine compaction in
  the middle of the turn that moved to it, nor after a resume that reports
  another model than the resumed session's snapshot.
- **`session.end` saves** what the throttled mid-turn saves had not.
- **A late wake-up for a reply already summarised** no longer writes the
  summary of whatever reply is open at the time.
- **Leaving a session saves only from the copy that still holds it**, so
  on `session.end` a copy a reload replaced cannot write its stale state
  over the newer one's (a `/jev off` reverted on the next start). A
  resume's reported model is not undone by a cut-short switch the resumed
  snapshot still held, and `seen:` records left behind by an earlier
  version are swept once old.
- **Two task notifications in one turn** send Jev both summaries and
  neither result (the second's result used to ride along).
- **A resume's reported model applies in a fresh process** too, where the
  snapshot was restored before the resume event arrived.
- **The footer says `jev: not routed`** for a turn that went unrouted,
  instead of the route of the turn before it.
- A copied route line with blank lines before its `---` rule is dropped
  with the rule when it streams, as when it arrives whole; the compaction
  fallback never reads "only 25% removed, needs 25%".
- **Two processes loaded in the same millisecond** no longer both route a
  session: their load stamps could be equal, and a per-copy id in the
  `seen:` record now decides which one holds it.
- **A notification's text sent to Jev is its summaries alone**: a result
  that quotes the closing tag can no longer carry what follows it along.
- **A task's result is not kept in the history or the store** when typed
  text comes before its notification: the prompt is kept as it is sent to
  Jev, text and summary.
- **Compaction's fallback no longer shows the provider's error body**,
  which can echo the key: it shows the status and error type, as a routed
  turn does, and a fallback restored from the store is printed as plain
  words.
- A spawn with no description or type, and a streamed chunk that is not
  text, pass through rather than throw or print "undefined".
- **A failed request's reason never carries the configured key**, however
  the error quotes it; a `Bearer` value that reads as a credential (a
  digit or underscore, sixteen characters, mixed case) is also redacted,
  in any case, and "Bearer required" or "Invalid Bearer token." stay as
  words.
- A notification's row reads its summary and task id from before the
  result, so a result that quotes either is not listed or stored; a
  subagent's prompt is cut at a notification as a typed one is.
- Looking for a notification is linear on any input, and a tag with
  attributes of any length, in any letter case, after any text (one with
  "İ" in it included), is still read as one, so its result is cut.
- **A prompt is cut at its first notification envelope, wherever it is and
  however it is quoted**: nothing after one reaches Jev or the store, since
  a result can quote closing tags and fences, and a trailer or a queued
  prompt after it cannot be told from the result. A prompt that quotes an
  example envelope has only what precedes it graded (see the README's
  "What leaves your machine").
- Only the chosen provider's key and pinned model are checked: a stale key
  for the other provider, or a pin the gateway ignores, blocks nothing; a
  pinned model with build metadata (`+build.5`) is accepted.
- A saved model id is one of the characters model ids use (ARNs, Vertex
  paths, `[1m]`, `+`), so one from a tampered store cannot carry markdown
  into the route line.
- `/jev` compares a long Bedrock or Vertex session model whole, not as cut
  for the line; "if it works, switch to haiku" is a condition again.
- A summary fence whose long first line streams in small pieces is held
  without rescanning it for each piece.
- **A `/model` alias is read for what it runs**: a tier's own alias
  (`opus`, `sonnet[1m]`) stands for that tier's model, so its warm cache is
  held; one that names no single model (`opusplan`, which runs Sonnet
  outside plan mode; `default`) makes no placeholder, rather than holding
  to "opus" with a cold switch priced as a stay. The session model is read
  afresh when a placeholder is made. An alias names the tier, not the
  version: a turn held on it takes the engine's own model of that tier at
  its first step (an older Opus behind `opus` included), for every step
  after and the turns that follow, so "kept" is a stay.
- A provider's spelling of the session model (`…@date`, `us.anthropic.…`)
  is not priced as a switch to itself, marked "⚠ asked" in the summary, or
  shown as "running on" another tier in `/jev`.
- **A provider's spelling of the routed model in usage**
  (`…@20260901`, `us.anthropic.…-v1:0`) is the same model: the turn stays
  routed, so `/jev tiers off` applies to it.
- A kept turn goes out in the engine's own spelling of the model, not
  respelled to `[1m]` or an alias.
- **After a resume that names no model, or a reload, the next turn checks
  the session's model**: a placeholder of the model the session ran on
  before (a turned-off tier included) is replaced by what it is on now,
  when the engine names a model id (an alias such as `opus` or `default`
  leaves a warm placeholder as it is).
- A NEL (U+0085) between `Bearer` and a token no longer hides the token
  from redaction.
- An answering model id a snapshot could not hold (a control character,
  markdown, a runaway length) is not adopted, so the snapshot stays
  readable.
- A stream cut short while a route-line look-alike is held still opens
  with the real line, and usage already read ahead is counted when the
  engine stops reading first.
- A request that fails with a bare number or blank text reads "unknown
  error".
- **A resume that names no model no longer carries an earlier resume's
  model into another session**: resuming one session and then another
  could send the first one's model (a tier turned off included) to the
  second.
- A reply that opens with a long route-line look-alike no longer turns
  the router off for the rest of the turn: only with no filter in place is
  a line-shaped opening taken for a line another copy wrote.
- Prose that opens with `<task-notification>` is a typed prompt, not a
  task's notification.
- A request that fails with nothing to say reads "unknown error", not
  "undefined" or "[object Object]"; a transcript message without text is
  left to the engine's summary.
- **A key with a line break or space inside it is refused** with the
  variable's name, rather than sent: the request would fail with an error
  quoting the header, key and all, into the route line and the store. Error
  text that quotes a `Bearer` value is redacted wherever it is shown.
- **A task's result stays out of compaction's requests to Jev**: a
  notification in the transcript is shown by its summary, as at the turn.
- **Typed text cannot hide the engine's notification**: a quote only keeps
  a notification the person's own when it closes past the notification's
  end, so an unclosed fence or paste cannot swallow the engine's envelope.
  Prose that names the tag is sent whole.
- A snapshot whose decision names one tier and another's model, whose
  lists run far past what the router keeps, or whose session model is not
  a model id, is refused or has that field dropped.
- `/jev` drops escape sequences from prompts and agent descriptions, and
  prints the surface, the session model and the Jev model plainly; a
  `JEV_ROUTER_JEV_MODEL` that is not a model id is refused.
- Compaction of a transcript whose calls alone cannot fit the budget is
  refused at once rather than after seconds of cutting; merging a long run
  of calls is linear. Long runs of spaces or slashes in
  `JEV_ROUTER_CEILING` and `TYPESAFE_BASE_URL` are read in linear time.
- More ways of asking politely are read as requests ("if you'd like",
  "unless you think otherwise", "until I switch back").
- A copied route line with many blank lines before its rule, or a copied
  summary with a very long first line, is stripped when streamed as it is
  whole.
- A notification the person quotes (in code, a paste or double quotes) is
  theirs: the prompt is sent with the request after it, and a prompt with
  a mention before the engine's own envelope is cut at the envelope.
- A condition that mentions the person or the model ("if you get a 429",
  "if my repo is large") still describes behaviour; only manners ("if you
  like", "unless you disagree", "until I say otherwise") are requests.
- A summary-shaped fence streamed in small pieces is checked as it grows,
  not rescanned for each piece.
- **A notification's result is withheld however its fields are ordered**:
  everything from the first notification tag on is read for its summary
  only, whatever shape the envelope has.
- `/jev off <tier>` and `/jev none` are refused as commands instead of being
  read as lifting every effort cap; `/jev ceiling off` still does.
- A ceiling lowered while an agent runs binds the agent's later requests.
- With only a gateway key, `/jev compact` and the status line say the
  engine's summary runs, rather than promising Jev's pruning.
- A compaction's "calls kept" counts the recent calls kept whole too.
- Tier naming reads "if you can", "until I say otherwise", "once again",
  "when in doubt" and the like as requests, and a new paragraph after the
  tier no longer counts as the tier naming something.
- **After a Jev prune, the context estimate takes off what the scoring
  removed, once.** The engine's messages carry a tool's output on the call
  and on the reply; counted each time, the estimate could fall to nothing,
  turning off the window guard and the price holds (a 340k context sent to
  haiku).
- **Text from outside the plugin cannot break the route line or the
  summary's fence**: every line break a renderer honours (`\r`, U+2028 and
  the like) is folded, control characters are dropped, and error reasons go
  through the same cleaning as model names.
- **A background task's result stays out of what Jev is sent** when it
  quotes a whole notification: only the first notification's summary is
  sent. A typed prompt that only mentions the tag is sent whole.
- A route under a condition ("if it runs long, switch to opus", "otherwise
  use opus") or a tier naming something else ("use sonnet pricing") is not
  read as naming a tier.
- A snapshot with a held cost or agent type of the wrong kind is refused
  rather than making `/jev` throw; usage counts past any window are capped,
  so a cost cannot overflow and lose the snapshot.
- Long or malformed text no longer slows a turn: the streamed copy filter,
  the paste and notification strippers, tag reading and model-name suffixes
  are linear. Events missing their text, prompt or arguments pass through.
- A compaction that removed too little shows the needed share rounded up
  (`needs 26%` for a bar of 25.4%), so the two figures never read the same.
- A restored session model's check is dropped with the state it came from
  on a resume or `/clear`.
- **A session model restored from a snapshot is checked against the
  engine's** on the next turn: a resume that did not name the model, or a
  second process on another one, no longer holds to the old model's
  placeholder (sending a model the session left, a turned-off tier
  included).
- Text typed ahead of a task's notification is sent to Jev without the
  notification's result.
- A copy that lost a same-stamp tie does not release the winner's claim;
  a resume reporting a dated id of the running model keeps the routed
  tier; a backticked tier is read after every route verb.
- **Prices** are found for Bedrock (`us.anthropic.claude-…-v1:0`) and
  Vertex (`claude-…@date`) model ids, including Vertex's Opus 4.

### Chores

- `npm run check-gateway`, a duplicate of `check-jev`, is removed.
- `check-jev` and `try-prompts` fall back to the shell's environment when
  `~/.claude/settings.json` is missing, instead of crashing.
- `measure-switch-cost` takes its output size alone or after the cache
  length, and prints break-evens rounded down.
- `npm run setup` fetches the types and turns on the pre-commit hook in
  one step; `npm run types` fails on an HTTP error instead of writing the
  error page into the type file.

## 1.0.2 — 2026-09-25

### Features

- **`/jev tiers`.** Turns a tier on or off for the rest of the session,
  kept across reloads: `/jev tiers off fable` drops it from the question
  Jev is asked, `/jev tiers on fable` brings it back. Combined with
  `/jev ceiling`, this covers running one tier at a different effort than
  the rest, or dropping it entirely — `/jev ceiling high` then
  `/jev ceiling medium fable` runs everything at high except Fable, held to
  medium. At least one tier always stays on.

## 1.0.1 — 2026-09-24

### Features

- **Compaction batch concurrency.** A large compaction now limits itself to
  at most 2 Jev calls in flight at once, instead of firing every batch in
  parallel.

### Fixes

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
  from the streaming filter's wait check and leak the tail of the rule into
  the real reply.
- **Turn-claim collision.** Two different, unrelated warm sessions that
  happened to report the same context-token count for the same short
  prompt within the 60-second claim window would cede to each other,
  leaving one of them unrouted. The session id is now always part of the
  claim key.
- **Decision confidence.** Clamped to 0–1 at the source, so an out-of-range
  value from the provider can no longer route live and then be silently
  dropped on the next reload.
- **Compaction prune cache.** Cleared on `/clear`, so a stale score from the
  previous conversation is never reused for the new one.
- Removed `docs/HANDOFF-CLAUDE-TESTING.md`, internal testing notes that had
  leaked into the public release.

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
