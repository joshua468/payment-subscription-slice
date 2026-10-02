/**
 * A3 — planted-bug function, as handed over.
 *
 * A partner sent this over for review with the message: "does this look right to
 * you? it computes a proration credit and then takes the balance as the charge."
 * The function below is reproduced EXACTLY as received. I have not corrected it.
 *
 * It is written to look plausible. The bug is not a typo; it is an ordering error,
 * which is the class of defect that survives review and reaches production.
 *
 * This file exists to be read, traced, and proved wrong. Do not use it in the app.
 */

const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

/**
 * Milliseconds in a day.
 *
 * Declared but never read. Left in place deliberately: this is the code AS RECEIVED,
 * and the unused constant is one of the things a reader notices before reaching the
 * arithmetic. Removing it would edit the artifact the analysis is about.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MS_PER_DAY = 86_400_000;

/**
 * Calculate a proration credit and the charge for a plan change.
 *
 * @param currentAmountMinorUnits  Full price of the plan the user is on now (kobo).
 * @param newAmountMinorUnits      Full price of the plan they are moving to (kobo).
 * @param currentInterval          "monthly" or "yearly" — picks the divisor.
 * @param daysRemaining            Whole paid days left in the current period.
 * @param now                      Current time, injected so the function is testable.
 */
export function calculateProrationForChange(input: {
  currentAmountMinorUnits: number;
  newAmountMinorUnits: number;
  currentInterval: "monthly" | "yearly";
  daysRemaining: number;
  now: number;
}): {
  creditMinorUnits: number;
  chargeMinorUnits: number;
  unusedDays: number;
} {
  // `now` is destructured and never used. Left as received — the injected clock that
  // the doc comment promises is not consulted anywhere in the body.
  const {
    currentAmountMinorUnits,
    newAmountMinorUnits,
    currentInterval,
    daysRemaining,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    now,
  } = input;

  const daysInPeriod =
    currentInterval === "monthly" ? DAYS_PER_MONTH : DAYS_PER_YEAR;

  // Recompute the unused days from the period end rather than trusting the caller.
  // The caller is a UI component; it may have rounded, clamped or cached this value.
  const unusedDays = Math.min(Math.max(0, Math.floor(daysRemaining)), daysInPeriod);

  if (newAmountMinorUnits <= 0) {
    throw new RangeError("newAmountMinorUnits must be greater than zero");
  }

  // The daily value of what the user has already paid for.
  const dailyRate = Math.round(currentAmountMinorUnits / daysInPeriod);

  // Unused days are worth this much. Rounded, because money is rounded.
  const creditMinorUnits = Math.round(dailyRate * unusedDays);

  // What is left to pay for the new plan, once the credit is applied.
  const chargeMinorUnits = Math.round(newAmountMinorUnits - creditMinorUnits);

  return { creditMinorUnits, chargeMinorUnits, unusedDays };
}

/**
 * Apply the prorated charge on top of an existing charge, in a way that is safe to
 * call twice. Used by the checkout initiator when a user switches plans mid-period.
 */
export function totalChargeAfterChange(input: {
  existingChargeMinorUnits: number;
  creditMinorUnits: number;
  alreadyAppliedCreditMinorUnits?: number;
  now?: number;
}): number {
  const {
    existingChargeMinorUnits,
    creditMinorUnits,
    alreadyAppliedCreditMinorUnits = 0,
  } = input;

  // Credit can only be spent once. Subtract whatever has already been spent.
  const availableCredit = Math.max(
    0,
    creditMinorUnits - alreadyAppliedCreditMinorUnits
  );

  return Math.max(0, existingChargeMinorUnits - availableCredit);
}
