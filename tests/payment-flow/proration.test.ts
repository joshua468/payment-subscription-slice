import { describe, expect, it } from "vitest";

import {
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  calculateProration,
  daysBetween,
  daysInInterval,
} from "@/lib/proration/calculate";

describe("interval lengths", () => {
  it("locks monthly at 30 days and yearly at 365 days", () => {
    expect(DAYS_PER_MONTH).toBe(30);
    expect(DAYS_PER_YEAR).toBe(365);
  });

  it("maps intervals to their locked day count", () => {
    expect(daysInInterval("monthly")).toBe(30);
    expect(daysInInterval("yearly")).toBe(365);
  });
});

describe("calculateProration", () => {
  it("credits the unused portion of the current month and charges the difference", () => {
    const result = calculateProration({
      currentAmountMinorUnits: 1050,
      newAmountMinorUnits: 10500,
      currentInterval: "monthly",
      newInterval: "yearly",
      daysRemaining: 15,
    });

    // Credit: 1050 / 30 * 15 = 525. Charge: 10500 - 525 = 9975.
    expect(result.fullPrecisionCredit).toBe(525);
    expect(result.creditMinorUnits).toBe(525);
    expect(result.proratedChargeMinorUnits).toBe(9975);
  });

  it("charges the full credit when upgrading with a full period remaining", () => {
    const result = calculateProration({
      currentAmountMinorUnits: 1050,
      newAmountMinorUnits: 10500,
      currentInterval: "monthly",
      newInterval: "yearly",
      daysRemaining: 30,
    });

    expect(result.proratedChargeMinorUnits).toBe(9450);
  });

  it("charges the full new price on the last day of the period", () => {
    const result = calculateProration({
      currentAmountMinorUnits: 1050,
      newAmountMinorUnits: 10500,
      currentInterval: "monthly",
      newInterval: "yearly",
      daysRemaining: 0,
    });

    expect(result.proratedChargeMinorUnits).toBe(10500);
  });

  it("keeps full precision and rounds only the final charge", () => {
    const result = calculateProration({
      currentAmountMinorUnits: 1000,
      newAmountMinorUnits: 10000,
      currentInterval: "monthly",
      newInterval: "yearly",
      daysRemaining: 7,
    });

    // Credit: 1000 / 30 * 7 = 233.333333... (full precision preserved)
    expect(result.fullPrecisionCredit).toBeCloseTo(233.33333, 5);
    // Charge: 10000 - 233.3333 = 9766.6666 -> rounded to 9767
    expect(result.proratedChargeMinorUnits).toBe(9767);
  });

  it("rejects out-of-range daysRemaining", () => {
    expect(() =>
      calculateProration({
        currentAmountMinorUnits: 1050,
        newAmountMinorUnits: 10500,
        currentInterval: "monthly",
        newInterval: "yearly",
        daysRemaining: 31,
      })
    ).toThrow(RangeError);
  });
});

describe("daysBetween", () => {
  it("counts whole days between dates", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-16T12:00:00.000Z");
    expect(daysBetween(start, end)).toBe(15);
  });
});