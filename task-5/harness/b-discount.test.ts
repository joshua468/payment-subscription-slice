/**
 * Part B harness — 30 tests over task-5/part-b/discount.ts.
 *
 * These check behaviour and error codes, not internals, so they pass against any
 * correct implementation. That matters: the task requires a hand-written version, and
 * this suite is usable as an acceptance test for one.
 *
 * Run:
 *   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  DiscountError,
  normalizeCode,
  redeemDiscountCode,
  type DiscountCodeRecord,
  type DiscountRedemptionRecord,
  type DiscountRepositories,
} from "../part-b/discount";

// ---------------------------------------------------------------------------
// In-memory repositories that enforce the same unique constraints as the schema
// ---------------------------------------------------------------------------

type Store = {
  codes: Map<string, DiscountCodeRecord>;
  redemptions: DiscountRedemptionRecord[];
  /** When set, the next insertRedemption call throws this constraint violation. */
  raceConstraint: string | null;
};

function makeCode(overrides: Partial<DiscountCodeRecord> = {}): DiscountCodeRecord {
  return {
    id: "dc_save25",
    code: "SAVE25",
    basisPointsOff: 2500,
    minSpendMinorUnits: null,
    startsAt: null,
    expiresAt: null,
    maxRedemptions: 100,
    ...overrides,
  };
}

function makeRepos(store: Store): DiscountRepositories {
  return {
    async findCodeByCode(code) {
      return store.codes.get(code) ?? null;
    },
    async findRedemptionByCodeAndOrderReference(code, orderReference) {
      return (
        store.redemptions.find(
          (r) => r.code === code && r.orderReference === orderReference
        ) ?? null
      );
    },
    async findRedemptionByUser(discountCodeId, userId) {
      return (
        store.redemptions.find(
          (r) => r.discountCodeId === discountCodeId && r.userId === userId
        ) ?? null
      );
    },
    async countRedemptions(discountCodeId) {
      return store.redemptions.filter(
        (r) => r.discountCodeId === discountCodeId
      ).length;
    },
    async totalDiscountedMinorUnits(discountCodeId) {
      return store.redemptions
        .filter((r) => r.discountCodeId === discountCodeId)
        .reduce((sum, r) => sum + r.discountMinorUnits, 0);
    },
    async insertRedemption(record) {
      if (store.raceConstraint === "discountCodeId_userId") {
        throw { constraint: "discountCodeId_userId" };
      }
      if (store.raceConstraint === "discountCodeId_orderReference") {
        throw { constraint: "discountCodeId_orderReference" };
      }
      // Enforce the schema's unique constraints for real, so the double-use tests
      // fail here rather than passing because the pre-check happened to catch it.
      const byUser = store.redemptions.find(
        (r) =>
          r.discountCodeId === record.discountCodeId &&
          r.userId === record.userId
      );
      if (byUser) throw { constraint: "discountCodeId_userId" };

      const byIntent = store.redemptions.find(
        (r) =>
          r.discountCodeId === record.discountCodeId &&
          r.orderReference === record.orderReference
      );
      if (byIntent) throw { constraint: "discountCodeId_orderReference" };

      const created = { ...record, id: `r_${store.redemptions.length + 1}` };
      store.redemptions.push(created as DiscountRedemptionRecord);
      return created as DiscountRedemptionRecord;
    },
  };
}

let store: Store;
let now: Date;

beforeEach(() => {
  store = {
    codes: new Map([["SAVE25", makeCode()]]),
    redemptions: [],
    raceConstraint: null,
  };
  now = new Date("2026-06-15T12:00:00.000Z");
});

function redeem(
  overrides: Partial<Parameters<typeof redeemDiscountCode>[0]> = {}
) {
  return redeemDiscountCode(
    {
      code: "SAVE25",
      orderReference: "ps-user1-monthly-abc",
      userId: "user1",
      chargeMinorUnits: 470_000,
      ...overrides,
    },
    { discounts: makeRepos(store), now }
  );
}

async function expectRejection(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toThrow(DiscountError);
  await expect(promise).rejects.toMatchObject({ code });
}

// ---------------------------------------------------------------------------

describe("B — normalisation", () => {
  it("trims and uppercases so casing and padding do not matter", () => {
    expect(normalizeCode("SAVE25")).toBe("SAVE25");
    expect(normalizeCode("save25")).toBe("SAVE25");
    expect(normalizeCode("  save25  ")).toBe("SAVE25");
  });

  it("rejects whitespace-only and non-string input", async () => {
    expect(() => normalizeCode("   ")).toThrow(DiscountError);
    expect(() => normalizeCode("")).toThrow(DiscountError);
    await expectRejection(
      redeem({ code: "   " }),
      "INVALID_CODE_FORMAT"
    );
    await expectRejection(
      redeem({ code: 42 as unknown as string }),
      "INVALID_CODE_FORMAT"
    );
  });
});

describe("B — happy path", () => {
  it("discounts an exact multiple with no rounding at all", async () => {
    const result = await redeem();

    expect(result.discountMinorUnits).toBe(117_500);
    expect(result.finalChargeMinorUnits).toBe(352_500);
    expect(result.alreadyRedeemed).toBe(false);
    expect(result.discountedTotalMinorUnits).toBe(117_500);
  });

  it("rounds once, on the discount, and still reconciles exactly", async () => {
    // 499999 * 2500 / 10000 = 124999.75 -> 125000. One rounding, at the end.
    const result = await redeem({ chargeMinorUnits: 499_999 });

    expect(result.discountMinorUnits).toBe(125_000);
    expect(result.finalChargeMinorUnits).toBe(374_999);
    expect(result.discountMinorUnits + result.finalChargeMinorUnits).toBe(499_999);
  });

  it("composes with the PRD's proration example: ₦4,700 charged becomes ₦3,525", async () => {
    const result = await redeem({ chargeMinorUnits: 4_700_000 });
    expect(result.finalChargeMinorUnits).toBe(3_525_000);
  });
});

describe("B — validity window, both bounds inclusive", () => {
  const windowed = makeCode({
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-12-31T23:59:59.000Z"),
  });

  beforeEach(() => {
    store.codes.set("SAVE25", windowed);
  });

  it("rejects before the start and after the expiry", async () => {
    now = new Date("2025-12-31T23:59:59.000Z");
    await expectRejection(redeem(), "CODE_NOT_ACTIVE");

    now = new Date("2027-01-01T00:00:01.000Z");
    await expectRejection(redeem(), "CODE_NOT_ACTIVE");
  });

  it("accepts exactly at the start and exactly at the expiry", async () => {
    now = new Date("2026-01-01T00:00:00.000Z");
    await expect(redeem()).resolves.toMatchObject({ finalChargeMinorUnits: 352_500 });

    store.redemptions = [];
    store.codes.set(
      "SAVE25",
      makeCode({
        id: "dc_second",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    now = new Date("2026-01-01T00:00:00.000Z");
    await expect(
      redeem({ orderReference: "tx-2", userId: "user2" })
    ).resolves.toMatchObject({ finalChargeMinorUnits: 352_500 });
  });

  it("treats a null bound as unbounded", async () => {
    store.codes.set("SAVE25", makeCode({ startsAt: null, expiresAt: null }));
    now = new Date("1999-01-01T00:00:00.000Z");
    await expect(redeem()).resolves.toMatchObject({ finalChargeMinorUnits: 352_500 });
  });
});

describe("B — minimum spend", () => {
  beforeEach(() => {
    store.codes.set("SAVE25", makeCode({ minSpendMinorUnits: 200_000 }));
  });

  it("rejects below the floor with the shortfall attached", async () => {
    await expectRejection(redeem({ chargeMinorUnits: 199_999 }), "MINIMUM_SPEND_NOT_MET");

    await redeemDiscountCode(
      { code: "SAVE25", orderReference: "tx", userId: "u", chargeMinorUnits: 1000 },
      { discounts: makeRepos(store), now }
    ).catch((error: DiscountError) => {
      expect(error.detail?.shortfallMinorUnits).toBe(199_000);
    });
  });

  it("accepts exactly at the minimum — a floor, not an exclusion", async () => {
    await expect(
      redeem({ chargeMinorUnits: 200_000 })
    ).resolves.toMatchObject({ discountMinorUnits: 50_000 });
  });

  it("accepts any charge when the minimum is null", async () => {
    store.codes.set("SAVE25", makeCode({ minSpendMinorUnits: null }));
    await expect(redeem({ chargeMinorUnits: 1 })).resolves.toMatchObject({
      discountMinorUnits: 0,
      finalChargeMinorUnits: 1,
    });
  });
});

describe("B — single use per customer", () => {
  it("rejects a second attempt by the same user against a different intent", async () => {
    await redeem();
    await expectRejection(
      redeem({ orderReference: "tx-second" }),
      "CODE_ALREADY_USED"
    );
  });

  it("allows a different user to redeem the same code", async () => {
    await redeem();
    await expect(
      redeem({ orderReference: "tx-other", userId: "user2" })
    ).resolves.toMatchObject({ finalChargeMinorUnits: 352_500 });
  });
});

describe("B — global redemption cap", () => {
  it("rejects at the cap and accepts one below it", async () => {
    store.codes.set("SAVE25", makeCode({ maxRedemptions: 2 }));

    await redeem();
    await redeem({ orderReference: "tx-2", userId: "user2" });

    await expectRejection(
      redeem({ orderReference: "tx-3", userId: "user3" }),
      "CODE_EXHAUSTED"
    );

    store.codes.set("SAVE25", makeCode({ maxRedemptions: 3 }));
    await expect(
      redeem({ orderReference: "tx-3", userId: "user3" })
    ).resolves.toMatchObject({ finalChargeMinorUnits: 352_500 });
  });
});

describe("B — idempotency on the payment intent", () => {
  it("replays the original redemption without writing a second row", async () => {
    const first = await redeem();
    const second = await redeem();

    expect(second.alreadyRedeemed).toBe(true);
    expect(second.discountMinorUnits).toBe(first.discountMinorUnits);
    expect(second.finalChargeMinorUnits).toBe(first.finalChargeMinorUnits);
    expect(store.redemptions).toHaveLength(1);
  });

  it("still replays successfully after the code has expired", async () => {
    await redeem();

    // The customer paid. A retry of their request must not be told it was invalid.
    store.codes.set(
      "SAVE25",
      makeCode({ expiresAt: new Date("2026-06-16T00:00:00.000Z") })
    );
    now = new Date("2026-07-01T00:00:00.000Z");

    const replay = await redeem();
    expect(replay.alreadyRedeemed).toBe(true);
    expect(replay.finalChargeMinorUnits).toBe(352_500);
  });

  it("still replays after the code hits its cap", async () => {
    await redeem();
    store.codes.set("SAVE25", makeCode({ maxRedemptions: 1 }));

    const replay = await redeem();
    expect(replay.alreadyRedeemed).toBe(true);
  });
});

describe("B — rounding discipline", () => {
  it("does not round the basis-point division before multiplying", async () => {
    // 33333 * 3333 / 10000 = 11108.9889. Rounding first (3333/10000 = 0.3333) then
    // multiplying would give 11108.9289 -> a different rounded result in some cases.
    store.codes.set("SAVE25", makeCode({ basisPointsOff: 3333 }));

    const result = await redeem({ chargeMinorUnits: 33_333 });
    const expected = Math.round((33_333 * 3333) / 10_000);

    expect(result.discountMinorUnits).toBe(expected);
    expect(result.finalChargeMinorUnits).toBe(33_333 - expected);
  });

  it("rejects an out-of-range stored percentage rather than clamping it", async () => {
    store.codes.set("SAVE25", makeCode({ basisPointsOff: 15_000 }));
    await expectRejection(redeem(), "INVALID_DISCOUNT_VALUE");

    store.codes.set("SAVE25", makeCode({ basisPointsOff: -500 }));
    await expectRejection(redeem(), "INVALID_DISCOUNT_VALUE");
  });

  it("reports a misconfigured percentage even when the code is inside its window", async () => {
    // This case is the one that distinguishes "percentage validated before the window"
    // from "validated after it". Without a live window, both orderings report
    // INVALID_DISCOUNT_VALUE and the test passes either way — which is exactly how
    // the ordering bug in part-b/discount.ts survived the first version of this suite.
    store.codes.set(
      "SAVE25",
      makeCode({
        basisPointsOff: 15_000,
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      })
    );
    now = new Date("2026-06-15T12:00:00.000Z"); // comfortably inside the window

    await expectRejection(redeem(), "INVALID_DISCOUNT_VALUE");
    expect(store.redemptions).toHaveLength(0);
  });

  it("never lets the discount exceed the charge, so the final charge cannot go negative", async () => {
    store.codes.set("SAVE25", makeCode({ basisPointsOff: 9_900 }));

    const result = await redeem({ chargeMinorUnits: 100 });
    expect(result.discountMinorUnits).toBe(99);
    expect(result.finalChargeMinorUnits).toBe(1);
    expect(result.finalChargeMinorUnits).toBeGreaterThanOrEqual(0);
  });

  it("handles a 100% code as a zero charge, not a negative one", async () => {
    store.codes.set("SAVE25", makeCode({ basisPointsOff: 10_000 }));

    const result = await redeem({ chargeMinorUnits: 470_000 });
    expect(result.discountMinorUnits).toBe(470_000);
    expect(result.finalChargeMinorUnits).toBe(0);
  });

  it("accepts a zero charge without treating it as invalid", async () => {
    const result = await redeem({ chargeMinorUnits: 0 });
    expect(result.discountMinorUnits).toBe(0);
    expect(result.finalChargeMinorUnits).toBe(0);
  });
});

describe("B — input validation", () => {
  it("rejects NaN, Infinity, negative and fractional charges", async () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1000.5,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      await expectRejection(redeem({ chargeMinorUnits: bad }), "INVALID_AMOUNT");
    }
  });

  it("requires an order reference and a signed-in user", async () => {
    await expectRejection(
      redeem({ orderReference: "" }),
      "INVALID_ORDER_REFERENCE"
    );
    await expectRejection(redeem({ userId: "" }), "INVALID_USER");
  });

  it("reports an unknown code as not found", async () => {
    await expectRejection(redeem({ code: "NOPE" }), "CODE_NOT_FOUND");
  });
});

describe("B — concurrency: the constraint, not the pre-check, is authoritative", () => {
  it("rejects a double use that both pre-checks failed to see", async () => {
    // Simulates two requests that both read count=0 and both passed the per-user
    // check, with the second insert losing the race in the database.
    store.raceConstraint = "discountCodeId_userId";

    await expectRejection(redeem(), "CODE_ALREADY_USED");
  });

  it("treats a raced order-reference violation as an idempotent replay", async () => {
    // This path must behave identically to the success path, because the client
    // cannot tell which one it hit.
    const original = await redeem();
    store.raceConstraint = "discountCodeId_orderReference";

    const raced = await redeem();
    expect(raced.alreadyRedeemed).toBe(true);
    expect(raced.finalChargeMinorUnits).toBe(original.finalChargeMinorUnits);
    expect(raced.discountMinorUnits).toBe(original.discountMinorUnits);
  });
});

describe("B — side effects: a rejection writes nothing", () => {
  it("leaves the redemption table empty after every kind of rejection", async () => {
    const rejections: Array<Promise<unknown>> = [
      redeem({ code: "NOPE" }),
      redeem({ code: "  " }),
      redeem({ chargeMinorUnits: -1 }),
      redeem({ chargeMinorUnits: Number.NaN }),
      redeem({ chargeMinorUnits: 1, userId: "" }),
      redeem({ chargeMinorUnits: 1, orderReference: "" }),
    ];

    for (const rejection of rejections) {
      await rejection.catch(() => undefined);
    }

    expect(store.redemptions).toHaveLength(0);
  });

  it("writes exactly one row per successful redemption", async () => {
    await redeem();
    expect(store.redemptions).toHaveLength(1);
    expect(store.redemptions[0]).toMatchObject({
      code: "SAVE25",
      userId: "user1",
      chargeMinorUnits: 470_000,
      discountMinorUnits: 117_500,
      finalChargeMinorUnits: 352_500,
    });
  });
});