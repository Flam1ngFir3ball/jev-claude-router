# Live test checklist

The PR #5 handoff that stood here described effort toggles (`ultra`,
`JEV_ROUTER_*_OFF`, `/jev max on`) that were replaced by the ceiling on
2026-09-23. What to check in a real session now:

```
npm run check            # typecheck, 320+ tests, plugin validate
npm run check-jev        # provider + one live call
npm run measure-switch-cost
```

In a session:

- `/jev` — routing on, provider set, `ceiling medium for all`, the `session` line.
- A trivial prompt on a fresh session → routed (often haiku), one summary block.
- `use opus for this: …` → `as you asked`, no Jev wait.
- `yes` after a routed turn → `continuing without asking Jev`, same tier.
- `/jev xhigh fable` then a planning prompt → xhigh on fable only.
- `/jev xhigh on` → names the old toggle and points at `/jev ceiling`.
- A prompt that spawns a background agent → one summary, after the agent ends,
  with an `Agents` row.
- Past 100k context, a trivial prompt → `stayed on <tier>: haiku would cost …`
  or, past 184k, `haiku takes 200k and this turn carries …`.
- Pull an update mid-session → `/jev` still shows the history and `spent`.

Record anything that fails with the prompt, the route line, the summary and
the `/jev` output.
