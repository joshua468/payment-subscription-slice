import type {
  Interval,
  ProrationInput,
  ProrationResult,
} from "@/types/payment";

// Interval lengths are locked (AGENTS.md Rule 7): monthly is always 30 days and
// yearly always 365 days for proration math, regardless of calendar specifics.
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = 365;

export function daysInInterval(interval: Interval): number {
  return interval === "monthly" ? DAYS_PER_MONTH : DAYS_PER_YEAR;
}

// Proration keeps full floating-point precision throughout and rounds only the
// final charge (Rule 7). Rounding an intermediate value would corrupt the credit.
export function calculateProration(input: ProrationInput): ProrationResult {
  const {
    currentAmountMinorUnits,
    newAmountMinorUnits,
    currentInterval,
    daysRemaining,
  } = input;

  const daysInPeriod = daysInInterval(currentInterval);

  if (daysRemaining < 0 || daysRemaining > daysInPeriod) {
    throw new RangeError(
      `daysRemaining must be between 0 and ${daysInPeriod}; got ${daysRemaining}`
    );
  }

  // Unused days of the current period become a credit against the new price.
  const dailyRate = currentAmountMinorUnits / daysInPeriod;
  const fullPrecisionCredit = dailyRate * daysRemaining;

  const fullPrecisionCharge =
    newAmountMinorUnits - fullPrecisionCredit;

  const proratedChargeMinorUnits =
    fullPrecisionCharge <= 0 ? 0 : Math.round(fullPrecisionCharge);

  return {
    creditMinorUnits: Math.round(fullPrecisionCredit),
    proratedChargeMinorUnits,
    fullPrecisionCredit,
  };
}

export function daysBetween(from: Date, to: Date): number {
  const msPerDay = 86_400_000;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / msPerDay));
}