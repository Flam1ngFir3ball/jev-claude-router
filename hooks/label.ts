/**
 * The footer label. `SessionMode` draws the strings it is handed, so this
 * file's only job is to turn a decision into one of them.
 */

import type { Decision } from "./policy.ts";

/** Below this, the pick is marked so a bad route is visible rather than silent. */
export const LOW_CONFIDENCE = 0.5;

/** A previous router label left in SessionMode's modes list, old style or new. */
const JEV_MODE = /^jev( →|:| off)/;

/**
 * The label for the footer, or null to add nothing.
 *
 * Null rather than a placeholder before the first turn: a footer that says
 * nothing reads better than one that says the router has not run yet.
 */
export function labelOf(
  decision: Decision | null,
  enabled: boolean,
): string | null {
  if (!enabled) return "jev off";
  if (!decision) return null;

  const doubt =
    decision.confidence < LOW_CONFIDENCE
      ? `, only ${Math.round(decision.confidence * 100)}% sure`
      : "";
  return `jev: ${decision.tier}, ${decision.effort} effort${doubt}`;
}

/**
 * The modes array `SessionMode` should draw, with our label on the end.
 * Prior `jev → …` / `jev off` entries are stripped so crumbs do not
 * accumulate across tier changes.
 */
export function withLabel(
  modes: readonly string[],
  label: string | null,
): readonly string[] {
  const cleared = modes.filter((m) => !JEV_MODE.test(m));
  if (label === null) return cleared;
  if (cleared.includes(label)) return cleared;
  return [...cleared, label];
}
