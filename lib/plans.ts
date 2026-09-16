import type { Currency, Interval, Plan, PlanPricing } from "@/types/payment";

// Money is always stored and priced in minor units (kobo) — never decimals.
// One paid plan (Pro) sold on two intervals. Adjust prices here only.
export const PLAN: Plan = "Pro";
export const PLAN_CURRENCY: Currency = "NGN";
export const PRO_MONTHLY_MINOR_UNITS = 500000; // ₦5,000.00 / month
export const PRO_YEARLY_MINOR_UNITS = 5000000; // ₦50,000.00 / year

export const INTERVALS: { interval: Interval; amountMinorUnits: number }[] = [
  { interval: "monthly", amountMinorUnits: PRO_MONTHLY_MINOR_UNITS },
  { interval: "yearly", amountMinorUnits: PRO_YEARLY_MINOR_UNITS },
];

export function getPlanPricing(interval: Interval): PlanPricing {
  const amountMinorUnits =
    interval === "monthly" ? PRO_MONTHLY_MINOR_UNITS : PRO_YEARLY_MINOR_UNITS;
  return {
    plan: PLAN,
    interval,
    amountMinorUnits,
    currency: PLAN_CURRENCY,
  };
}

export function formatMinorUnits(
  amountMinorUnits: number,
  currency: Currency = PLAN_CURRENCY
): string {
  const majorUnits = amountMinorUnits / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(majorUnits);
}