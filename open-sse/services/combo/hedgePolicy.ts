/**
 * Hedge-sibling eligibility for a combo target.
 *
 * A pinned fallback (one spare account, a slower third provider) exists for
 * "everything else failed". Starting it early as a hedge sibling cancels it as
 * soon as a faster target answers — that is recorded as a 499, burns the
 * account's quota and makes a healthy target look broken. `noHedge: true` keeps
 * it in the fallback chain while excluding it from the race.
 *
 * Both hedge implementations (the extracted attempt loop and the legacy inline
 * path in combo.ts) must consult this single helper — they drifted once already.
 */
export function canHedgeInto(nextTarget: { noHedge?: boolean } | null | undefined): boolean {
  return nextTarget?.noHedge !== true;
}
