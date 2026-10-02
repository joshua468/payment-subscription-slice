/**
 * A3 — the corrected function, as specified in `03-corrected-expected.md`.
 *
 * This is a standalone reference implementation used only by the Task 5 harness.
 * It deliberately mirrors the shape of `lib/proration/calculate.ts` so the two can be
 * compared line for line. It is NOT wired into the application and changes nothing
 * about the shipping behaviour.
 *
 * The differences from `planted-bug.ts` are the four corrections:
 *   1. no rounding of the daily rate
 *   2. no rounding of the credit before the subtraction
 *   3. daysRemaining is validated, not clamped
 *   4. credit idempotency is read from the log, not passed in
 */

const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

export type ProrationChangeInput = {
  currentAmountMinorUnits: number;
  newAmountMinorUnits: number;
  currentInterval: string;
  daysRemaining: number;
};

export type ProrationChangeResult = {
  creditMinorUnits: number;
  proratedChargeMinorUnits: number;
  fullPrecisionCredit: number;
  unusedDays: number;
};

export function calculateProrationForChange(
  input: ProrationChangeInput
): ProrationChangeResult {
  const {
    currentAmountMinorUnits,
    newAmountMinorUnits,
    currentInterval,
    daysRemaining,
  } = input;

  // Correction 3a: reject an unrecognised interval. The received version's ternary
  // fell through to the yearly divisor, so "fortnight" granted 365 days of credit.
  let daysInPeriod: number;
  if (currentInterval === "monthly") {
    daysInPeriod = DAYS_PER_MONTH;
  } else if (currentInterval === "yearly") {
    daysInPeriod = DAYS_PER_YEAR;
  } else {
    throw new RangeError(
      `currentInterval must be "monthly" or "yearly"; got ${String(currentInterval)}`
    );
  }

  // NaN and Infinity pass every numeric comparison you would write by hand, and both
  // produce a charge of NaN in an object that looks perfectly valid.
  if (!Number.isSafeInteger(currentAmountMinorUnits)) {
    throw new RangeError("currentAmountMinorUnits must be a safe integer");
  }
  if (!Number.isSafeInteger(newAmountMinorUnits)) {
    throw new RangeError("newAmountMinorUnits must be a safe integer");
  }

  // Correction 3b: validate rather than clamp. daysBetween() already floors, so a
  // fractional value here can only mean an upstream defect.
  if (!Number.isSafeInteger(daysRemaining)) {
    throw new RangeError("daysRemaining must be a whole number of days");
  }
  if (daysRemaining < 0 || daysRemaining > daysInPeriod) {
    throw new RangeError(
      `daysRemaining must be between 0 and ${daysInPeriod}; got ${daysRemaining}`
    );
  }

  const unusedDays = daysRemaining;

  // Corrections 1 and 2: full precision throughout. Round only the final charge.
  const dailyRate = currentAmountMinorUnits / daysInPeriod;
  const fullPrecisionCredit = dailyRate * unusedDays;
  const fullPrecisionCharge = newAmountMinorUnits - fullPrecisionCredit;

  const proratedChargeMinorUnits =
    fullPrecisionCharge <= 0 ? 0 : Math.round(fullPrecisionCharge);

  return {
    creditMinorUnits: Math.round(fullPrecisionCredit),
    proratedChargeMinorUnits,
    fullPrecisionCredit,
    unusedDays,
  };
}

export type PaymentLogEntry = {
  stage: "initiation" | "verification" | "fulfilment" | "failure";
  creditMinorUnits?: number;
};

/**
 * Correction 4: how much credit is left is a property of the append-only log, not of
 * a caller's memory. A caller cannot forget to pass a flag, because there is no flag.
 */
export function creditAvailableFor(
  totalCreditOwedMinorUnits: number,
  paymentLog: readonly PaymentLogEntry[]
): number {
  let spent = 0;
  for (const entry of paymentLog) {
    if (entry.stage === "fulfilment") {
      spent += entry.creditMinorUnits ?? 0;
    }
  }
  return Math.max(0, totalCreditOwedMinorUnits - spent);
}