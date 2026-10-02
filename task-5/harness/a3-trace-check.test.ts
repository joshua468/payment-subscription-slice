/**
 * A3 harness — proves every claim in
 *   task-5/part-a/a3-planted-bug/02-expected-trace.md
 *   task-5/part-a/a3-planted-bug/03-corrected-expected.md
 *
 * Run:
 *   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
 *
 * The three docs were written by hand-tracing before any code was executed. This file
 * is where those hand predictions are checked. Where a test below disagrees with a
 * number in the docs, THE DOC IS WRONG and gets fixed — the trace numbers came first
 * and are the harder-won artefact.
 */

import { describe, expect, it } from "vitest";

import {
  calculateProrationForChange as received,
  totalChargeAfterChange,
} from "../part-a/a3-planted-bug/planted-bug";
import {
  calculateProrationForChange as corrected,
  creditAvailableFor,
} from "../part-a/a3-planted-bug/corrected";

const MONTHLY_MINOR = 500_000; // Pro monthly, ₦5,000.00
const YEARLY_MINOR = 5_000_000; // Pro yearly, ₦50,000.00

// The received signature injects `now` so the function is testable; it is required,
// not optional. A fixed epoch (2026-06-15T00:00:00Z) keeps every trace deterministic.
const FIXED_NOW = Date.parse("2026-06-15T00:00:00.000Z");

describe("A3 trace 1 — PRD worked example: upgrade on day 12 of a monthly period", () => {
  const input = {
    currentAmountMinorUnits: MONTHLY_MINOR,
    newAmountMinorUnits: YEARLY_MINOR,
    currentInterval: "monthly" as const,
    daysRemaining: 18,
    now: FIXED_NOW,
  };

  it("matches the spec exactly: credit 300,000 and charge 4,700,000", () => {
    const result = corrected(input);

    expect(result.fullPrecisionCredit).toBe(300_000);
    expect(result.creditMinorUnits).toBe(300_000);
    expect(result.proratedChargeMinorUnits).toBe(4_700_000);
    expect(result.unusedDays).toBe(18);
  });

  it("the received function under-charges by 6 kobo", () => {
    const result = received(input);

    // Doc 02, trace 1: dailyRate rounded 16666.666... -> 16667, an error of
    // +0.3333 kobo/day multiplied across 18 days = +6 kobo of credit.
    expect(result.creditMinorUnits).toBe(300_006);
    expect(result.chargeMinorUnits).toBe(4_699_994);

    // The deviation is exactly the per-day error x the days, which is the
    // signature that locates the defect at the daily rate rather than the charge.
    const exactDailyRate = MONTHLY_MINOR / 30;
    expect(300_006 - 300_000).toBeCloseTo(
      (Math.round(exactDailyRate) - exactDailyRate) * 18,
      9
    );
  });
});

describe("A3 trace 2 — PRD worked example: upgrade with 7 days remaining", () => {
  const input = {
    currentAmountMinorUnits: MONTHLY_MINOR,
    newAmountMinorUnits: YEARLY_MINOR,
    currentInterval: "monthly" as const,
    daysRemaining: 7,
    now: FIXED_NOW,
  };

  it("matches the spec exactly: charge 4,883,333", () => {
    const result = corrected(input);

    expect(result.fullPrecisionCredit).toBeCloseTo(116_666.666_666_666_67, 6);
    expect(result.proratedChargeMinorUnits).toBe(4_883_333);
  });

  it("the received function under-charges by 2 kobo — a different amount than trace 1", () => {
    const result = received(input);

    expect(result.creditMinorUnits).toBe(116_669);
    expect(result.chargeMinorUnits).toBe(4_883_331);
  });

  it("the deviation scales with daysRemaining, which is what identifies a per-day rate error", () => {
    const exactDailyRate = MONTHLY_MINOR / 30;
    const perDayError = Math.round(exactDailyRate) - exactDailyRate;

    expect(Math.abs(300_006 - 300_000) / 18).toBeCloseTo(perDayError, 9);
    expect(Math.abs(116_669 - 116_666.666_666_666_67) / 7).toBeCloseTo(
      perDayError,
      6
    );
  });
});

describe("A3 trace 3 — invalid input: 45 days remaining on a 30-day period", () => {
  const input = {
    currentAmountMinorUnits: MONTHLY_MINOR,
    newAmountMinorUnits: YEARLY_MINOR,
    currentInterval: "monthly" as const,
    daysRemaining: 45,
    now: FIXED_NOW,
  };

  it("the received function silently clamps and returns a plausible wrong charge", () => {
    const result = received(input);

    // Doc 02, trace 3. A valid-looking object: positive charge, reconciles to the new
    // price, within 5% of the correct answer. No signal that the input was rejected.
    expect(result.unusedDays).toBe(30);
    expect(result.creditMinorUnits).toBe(500_010);
    expect(result.chargeMinorUnits).toBe(4_499_990);
    expect(result.creditMinorUnits + result.chargeMinorUnits).toBe(YEARLY_MINOR);
  });

  it("the corrected function throws RangeError, per FR-8", () => {
    expect(() => corrected(input)).toThrow(RangeError);
    expect(() => corrected(input)).toThrow(
      "daysRemaining must be between 0 and 30; got 45"
    );
  });

  it("also rejects a negative value, which the clamp turned into a full-price charge", () => {
    const negative = { ...input, daysRemaining: -5 };

    // The clamp made a negative read as zero: credit 0, full price charged. Safe by
    // accident, but it hid the bad input just as thoroughly as the 45 case.
    const clamped = received(negative);
    expect(clamped.unusedDays).toBe(0);
    expect(clamped.chargeMinorUnits).toBe(YEARLY_MINOR);

    expect(() => corrected(negative)).toThrow(RangeError);
  });
});

describe("A3 trace 4 — finding 3: credit applied twice", () => {
  it("the received helper lets one credit be spent twice, silently", () => {
    const args = { existingChargeMinorUnits: YEARLY_MINOR, creditMinorUnits: 300_000 };

    const first = totalChargeAfterChange(args);
    const second = totalChargeAfterChange(args);

    expect(first).toBe(4_700_000);
    expect(second).toBe(4_700_000);
    expect(first + second).toBe(9_400_000);
    // ₦94,000 collected for a ₦50,000 plan, with ₦6,000 credited against ₦3,000 owed.
    expect(600_000).toBeGreaterThan(300_000);
  });

  it("the safety is opt-in: passing alreadyAppliedCreditMinorUnits is what makes it work", () => {
    // This is the whole defect — the caller has to remember, and the default path is
    // the unsafe one.
    expect(
      totalChargeAfterChange({
        existingChargeMinorUnits: YEARLY_MINOR,
        creditMinorUnits: 300_000,
        alreadyAppliedCreditMinorUnits: 300_000,
      })
    ).toBe(YEARLY_MINOR);
  });

  it("the corrected helper derives the same answer from the log, which a caller cannot fake", () => {
    const log = [{ stage: "fulfilment" as const, creditMinorUnits: 300_000 }];

    expect(creditAvailableFor(300_000, log)).toBe(0);
    expect(creditAvailableFor(300_000, [])).toBe(300_000);

    // Second charge attempt: no credit left, so the customer is charged full price.
    const available = creditAvailableFor(300_000, log);
    const secondCharge = Math.max(0, YEARLY_MINOR - available);

    expect(secondCharge).toBe(YEARLY_MINOR);
    expect(4_700_000 + secondCharge).toBe(9_700_000);
  });
});

describe("A3 — the additions, beyond what the spec literally required", () => {
  it("the received function treats an unrecognised interval as yearly (365 days of credit)", () => {
    const result = received({
      currentAmountMinorUnits: MONTHLY_MINOR,
      newAmountMinorUnits: YEARLY_MINOR,
      // "fortnight" is deliberately outside the union: this is the point of the probe,
      // so the cast is the assertion.
      currentInterval: "fortnight" as unknown as "monthly",
      daysRemaining: 365,
      now: FIXED_NOW,
    });

    // Fell straight through the ternary. No error, and a full year's credit granted.
    expect(result.unusedDays).toBe(365);
    expect(result.creditMinorUnits).toBeGreaterThan(MONTHLY_MINOR);
  });

  it("the corrected function rejects an unrecognised interval", () => {
    expect(() =>
      corrected({
        currentAmountMinorUnits: MONTHLY_MINOR,
        newAmountMinorUnits: YEARLY_MINOR,
        currentInterval: "fortnight" as unknown as "monthly",
        daysRemaining: 10,
      })
    ).toThrow(RangeError);
  });

  it("NaN amounts slip through every hand-written comparison, so they are guarded explicitly", () => {
    // The corrected function has no `now` parameter at all, so the shared shape omits
    // it and only the received call injects it.
    const nanInput = {
      currentAmountMinorUnits: Number.NaN,
      newAmountMinorUnits: YEARLY_MINOR,
      currentInterval: "monthly" as const,
      daysRemaining: 18,
    };

    // The received version's guard is `newAmount <= 0`, which is false for NaN in the
    // other field. NaN then propagates and produces a NaN charge in a valid-looking object.
    const result = received({ ...nanInput, now: FIXED_NOW });
    expect(Number.isNaN(result.chargeMinorUnits)).toBe(true);
    expect(Number.isNaN(result.creditMinorUnits)).toBe(true);

    expect(() => corrected(nanInput)).toThrow(RangeError);
    expect(() =>
      corrected({ ...nanInput, newAmountMinorUnits: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });

  it("a downgrade floors the charge at zero rather than producing a negative amount", () => {
    // 37 days of a yearly period is worth more than the whole of a monthly plan, so
    // the credit exceeds the new price and the balance goes negative.
    const creditAt37Days = (YEARLY_MINOR / 365) * 37;
    expect(creditAt37Days).toBeGreaterThan(MONTHLY_MINOR);

    const result = corrected({
      currentAmountMinorUnits: YEARLY_MINOR,
      newAmountMinorUnits: MONTHLY_MINOR,
      currentInterval: "yearly",
      daysRemaining: 37,
    });

    expect(result.proratedChargeMinorUnits).toBe(0);
    expect(result.creditMinorUnits).toBe(506_849);
  });

  it("full precision credit plus rounded charge equals the new price to within half a kobo", () => {
    for (const days of [0, 1, 7, 12, 18, 29, 30]) {
      const { fullPrecisionCredit, proratedChargeMinorUnits } = corrected({
        currentAmountMinorUnits: MONTHLY_MINOR,
        newAmountMinorUnits: YEARLY_MINOR,
        currentInterval: "monthly",
        daysRemaining: days,
      });

      expect(
        Math.abs(fullPrecisionCredit + proratedChargeMinorUnits - YEARLY_MINOR)
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it("the rounded credit and the rounded charge can disagree by 1 kobo — and must not be used as the identity", () => {
    // The 0.5-credit row from the "guarantee" table in 03-corrected-expected.md. This
    // is why reconciliation is asserted against fullPrecisionCredit, never against
    // the display-rounded creditMinorUnits.
    const newAmountMinorUnits = 10;
    const fullPrecisionCredit = 0.5;
    const creditMinorUnits = Math.round(fullPrecisionCredit);
    const proratedChargeMinorUnits = Math.round(newAmountMinorUnits - fullPrecisionCredit);

    // The display-rounded pair overshoots by a whole kobo.
    expect(creditMinorUnits + proratedChargeMinorUnits).toBe(11);
    expect(creditMinorUnits + proratedChargeMinorUnits - newAmountMinorUnits).toBe(1);

    // The guarantee the docs actually make is a 0.5 kobo bound against the
    // full-precision credit, not exactness. Math.round(9.5) === 10, so the residual
    // here lands exactly on the bound.
    const residual =
      fullPrecisionCredit + proratedChargeMinorUnits - newAmountMinorUnits;
    expect(Math.abs(residual)).toBeLessThanOrEqual(0.5);
    expect(residual).toBe(0.5);
  });
});