/**
 * Part C3 — run both implementations against the same ten inputs and compare.
 *
 *   mine   -> task-5/part-b/discount.ts
 *   theirs -> task-5/part-c/discount-ai.ts
 *
 * Both are driven through identical in-memory stores so that any difference in the
 * result is a difference in the LOGIC, not an artifact of different fixtures.
 *
 * Run:
 *   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
 *
 * Read task-5/part-c/01-compare.md first — in particular the provenance note. These
 * two files came from the same model, so a clean result here is weak evidence about
 * model quality and reasonable evidence about specification clarity.
 */

import {
  describe, expect, it } from "vitest";

import {
  redeemDiscountCode as mine,
  type DiscountCodeRecord,
  type DiscountRedemptionRecord,
  type DiscountRepositories,
} from "../part-b/discount";
import {
  redeemDiscountCode as theirs,
  type DiscountCode,
  type Redemption,
  type Store,
} from "../part-c/discount-ai";

// ---------------------------------------------------------------------------
// One store, two views. Shape differs; content is identical.
//
// The two implementations disagree on record shape — that is one of the documented
// differences — so the fake store holds a NORMALISED row and converts on the way in
// and out. `orderReference` (Part B) and `paymentRef` (Part C) become one field here.
// ---------------------------------------------------------------------------

/**
 * One stored row, projected back into whichever shape the caller asked for. The two
 * implementations disagree on four field names, which is one of the documented
 * differences — so the store normalises and each interface projects on the way out.
 *
 * Every field present in both real shapes is required here, so nothing is defaulted:
 * a missing field is a bug in the fixture, not something to paper over.
 */
type StoredRedemption = {
  discountCodeId: string;
  code: string;
  userId: string;
  orderReference: string;
  chargeMinorUnits: number;
  discountMinorUnits: number;
  finalChargeMinorUnits: number;
};

const FIXED_REDEEMED_AT = new Date("2026-01-01T00:00:00.000Z");

function toPartB(row: StoredRedemption): DiscountRedemptionRecord {
  return { ...row, redeemedAt: FIXED_REDEEMED_AT };
}

function toPartC(row: StoredRedemption): Redemption {
  return {
    discountCodeId: row.discountCodeId,
    code: row.code,
    userId: row.userId,
    paymentRef: row.orderReference,
    chargeMinorUnits: row.chargeMinorUnits,
    discountMinorUnits: row.discountMinorUnits,
    payableMinorUnits: row.finalChargeMinorUnits,
    createdAt: FIXED_REDEEMED_AT,
  };
}

/** Read a field that exists on only one of the two shapes. */
function normalise(
  record: DiscountRedemptionRecord | Redemption
): StoredRedemption {
  const partB = record as Partial<DiscountRedemptionRecord>;
  const partC = record as Partial<Redemption>;

  const orderReference = partB.orderReference ?? partC.paymentRef;
  const finalChargeMinorUnits =
    partB.finalChargeMinorUnits ?? partC.payableMinorUnits;

  if (
    partB.discountCodeId === undefined ||
    partB.code === undefined ||
    partB.userId === undefined ||
    orderReference === undefined ||
    partB.chargeMinorUnits === undefined ||
    partB.discountMinorUnits === undefined ||
    finalChargeMinorUnits === undefined
  ) {
    throw new Error(
      `normalise: record is missing a field required by both shapes: ${JSON.stringify(record)}`
    );
  }

  return {
    discountCodeId: partB.discountCodeId,
    code: partB.code,
    userId: partB.userId,
    orderReference,
    chargeMinorUnits: partB.chargeMinorUnits,
    discountMinorUnits: partB.discountMinorUnits,
    finalChargeMinorUnits,
  };
}

type Scenario = {
  name: string;
  code: {
    basisPointsOff: number;
    minSpendMinorUnits: number | null;
    startsAt: Date | null;
    expiresAt: Date | null;
    maxRedemptions: number;
  };
  request: {
    code: string;
    orderReference: string;
    userId: string;
    chargeMinorUnits: number;
  };
  now: string;
  /** A redemption that already exists for this orderReference before the call. */
  preExisting?: { orderReference: string; userId: string };
  /** A redemption that already exists for this user on a different intent. */
  priorUserUse?: { orderReference: string; userId: string };
  /** Simulates the insert losing a race on this unique constraint. */
  race?: "discountCodeId_userId" | "discountCodeId_orderReference";
  /** Charge is not whole/finite/negative-safe. */
  badCharge?: number;
};

const BASE: Scenario["code"] = {
  basisPointsOff: 2500,
  minSpendMinorUnits: null,
  startsAt: null,
  expiresAt: null,
  maxRedemptions: 100,
};

// ---------------------------------------------------------------------------

function makeStore(scenario: Scenario) {
  const canonical = scenario.request.code.trim().toUpperCase();

  const discountCode: DiscountCodeRecord & DiscountCode = {
    id: "dc_1",
    code: canonical,
    basisPointsOff: scenario.code.basisPointsOff,
    percentBps: scenario.code.basisPointsOff,
    minSpendMinorUnits: scenario.code.minSpendMinorUnits,
    minimumChargeMinorUnits: scenario.code.minSpendMinorUnits,
    startsAt: scenario.code.startsAt,
    activeFrom: scenario.code.startsAt,
    expiresAt: scenario.code.expiresAt,
    activeUntil: scenario.code.expiresAt,
    maxRedemptions: scenario.code.maxRedemptions,
    redemptionLimit: scenario.code.maxRedemptions,
  };

  const redemptions: StoredRedemption[] = [];

  if (scenario.priorUserUse) {
    redemptions.push(
      makeRedemption(discountCode, {
        orderReference: scenario.priorUserUse.orderReference,
        userId: scenario.priorUserUse.userId,
        discountMinorUnits: 117_500,
        finalChargeMinorUnits: 352_500,
      })
    );
  }
  if (scenario.preExisting) {
    redemptions.push(
      makeRedemption(discountCode, {
        orderReference: scenario.preExisting.orderReference,
        userId: scenario.preExisting.userId,
        discountMinorUnits: 60_000,
        finalChargeMinorUnits: 410_000,
      })
    );
  }

  const repos: DiscountRepositories & Store = {
    // --- Part B interface ---
    async findCodeByCode() {
      return discountCode;
    },
    async findRedemptionByCodeAndOrderReference(code, orderReference) {
      const row = redemptions.find(
        (r) => r.code === code && r.orderReference === orderReference
      );
      return row ? toPartB(row) : null;
    },
    async findRedemptionByUser(discountCodeId, userId) {
      const row = redemptions.find(
        (r) => r.discountCodeId === discountCodeId && r.userId === userId
      );
      return row ? toPartB(row) : null;
    },
    async countRedemptions(discountCodeId) {
      return redemptions.filter((r) => r.discountCodeId === discountCodeId).length;
    },
    async totalDiscountedMinorUnits(discountCodeId) {
      return redemptions
        .filter((r) => r.discountCodeId === discountCodeId)
        .reduce((sum, r) => sum + r.discountMinorUnits, 0);
    },
    async insertRedemption(record) {
      return toPartB(await attemptInsert(scenario, redemptions, normalise(record)));
    },

    // --- Part C interface ---
    async codeByName() {
      return discountCode;
    },
    async redemptionByPaymentRef(code, orderReference) {
      const row = redemptions.find(
        (r) => r.code === code && r.orderReference === orderReference
      );
      return row ? toPartC(row) : null;
    },
    async redemptionByUser(discountCodeId, userId) {
      const row = redemptions.find(
        (r) => r.discountCodeId === discountCodeId && r.userId === userId
      );
      return row ? toPartC(row) : null;
    },
    async redemptionCount(discountCodeId) {
      return redemptions.filter((r) => r.discountCodeId === discountCodeId).length;
    },
    async sumDiscountedMinorUnits(discountCodeId) {
      return redemptions
        .filter((r) => r.discountCodeId === discountCodeId)
        .reduce((sum, r) => sum + r.discountMinorUnits, 0);
    },
    async save(record) {
      return toPartC(await attemptInsert(scenario, redemptions, normalise(record)));
    },
  };

  return { repos, redemptions, discountCode };
}

function makeRedemption(
  discountCode: { id: string; code: string },
  overrides: {
    orderReference: string;
    userId: string;
    discountMinorUnits: number;
    finalChargeMinorUnits: number;
  }
): StoredRedemption {
  return {
    discountCodeId: discountCode.id,
    code: discountCode.code,
    userId: overrides.userId,
    orderReference: overrides.orderReference,
    chargeMinorUnits: 470_000,
    discountMinorUnits: overrides.discountMinorUnits,
    finalChargeMinorUnits: overrides.finalChargeMinorUnits,
  };
}

/** Insert, enforcing both unique constraints as the database would. */
async function attemptInsert(
  scenario: Scenario,
  redemptions: StoredRedemption[],
  record: StoredRedemption
) {
  if (scenario.race === "discountCodeId_userId") {
    throw { constraint: "discountCodeId_userId" };
  }
  if (scenario.race === "discountCodeId_orderReference") {
    throw { constraint: "discountCodeId_orderReference" };
  }
  const clash = redemptions.find(
    (r) => r.discountCodeId === record.discountCodeId && r.userId === record.userId
  );
  if (clash) throw { constraint: "discountCodeId_userId" };

  const clashIntent = redemptions.find(
    (r) =>
      r.discountCodeId === record.discountCodeId &&
      r.orderReference === record.orderReference
  );
  if (clashIntent) throw { constraint: "discountCodeId_orderReference" };

  redemptions.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// Normalising both shapes down to one comparable record
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "success"; discount: number; payable: number; replayed: boolean }
  | { kind: "error"; code: string };

async function run(
  scenario: Scenario,
  which: "mine" | "theirs"
): Promise<{ outcome: Outcome; writes: number }> {
  const { repos, redemptions } = makeStore(scenario);
  const now = new Date(scenario.now);

  const chargeMinorUnits =
    scenario.badCharge !== undefined ? scenario.badCharge : scenario.request.chargeMinorUnits;

  try {
    if (which === "mine") {
      const result = await mine(
        {
          code: scenario.request.code,
          orderReference: scenario.request.orderReference,
          userId: scenario.request.userId,
          chargeMinorUnits,
        },
        { discounts: repos, now }
      );
      return {
        outcome: {
          kind: "success",
          discount: result.discountMinorUnits,
          payable: result.finalChargeMinorUnits,
          replayed: result.alreadyRedeemed,
        },
        writes: redemptions.length,
      };
    }

    const result = await theirs(
      {
        code: scenario.request.code,
        paymentRef: scenario.request.orderReference,
        userId: scenario.request.userId,
        chargeMinorUnits,
      },
      { store: repos, clock: now }
    );
    return {
      outcome: {
        kind: "success",
        discount: result.discountMinorUnits,
        payable: result.payableMinorUnits,
        replayed: result.replayed,
      },
      writes: redemptions.length,
    };
  } catch (error) {
    return {
      outcome: {
        kind: "error",
        code: (error as { code?: string }).code ?? "UNKNOWN",
      },
      writes: redemptions.length,
    };
  }
}

// ---------------------------------------------------------------------------
// The ten inputs
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    name: "1. Normal — 25% off an exact multiple, no rounding needed",
    code: { ...BASE },
    request: { code: "SAVE25", orderReference: "ps-1", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "2. Normal — non-exact discount, rounding applied once",
    code: { ...BASE },
    request: { code: "SAVE25", orderReference: "ps-2", userId: "u1", chargeMinorUnits: 499_999 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "3. Edge — lowercase and padded code normalises to the same code",
    code: { ...BASE },
    request: { code: "  save25  ", orderReference: "ps-3", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "4. Edge — charge exactly equal to the minimum spend (must pass)",
    code: { ...BASE, minSpendMinorUnits: 200_000 },
    request: { code: "SAVE25", orderReference: "ps-4", userId: "u1", chargeMinorUnits: 200_000 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "5. Edge — clock exactly at expiresAt (inclusive, must pass)",
    code: { ...BASE, expiresAt: new Date("2026-06-15T12:00:00.000Z") },
    request: { code: "SAVE25", orderReference: "ps-5", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "6. Edge — retry of a paid intent after the code expired",
    code: { ...BASE, expiresAt: new Date("2026-01-01T00:00:00.000Z") },
    request: { code: "SAVE25", orderReference: "ps-6", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-07-01T00:00:00.000Z",
    preExisting: { orderReference: "ps-6", userId: "u1" },
  },
  {
    name: "7. Edge — same user, different intent (second use must be refused)",
    code: { ...BASE },
    request: { code: "SAVE25", orderReference: "ps-7", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
    priorUserUse: { orderReference: "ps-earlier", userId: "u1" },
  },
  {
    name: "8. Invalid — charge one kobo below the minimum spend",
    code: { ...BASE, minSpendMinorUnits: 200_000 },
    request: { code: "SAVE25", orderReference: "ps-8", userId: "u1", chargeMinorUnits: 199_999 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "9. Invalid — stored percentage out of range, inside an active window",
    code: { ...BASE, basisPointsOff: 15_000, startsAt: new Date("2026-01-01T00:00:00.000Z"), expiresAt: new Date("2026-12-31T23:59:59.000Z") },
    request: { code: "SAVE25", orderReference: "ps-9", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
  },
  {
    name: "10. Invalid — NaN charge from an upstream proration bug",
    code: { ...BASE },
    request: { code: "SAVE25", orderReference: "ps-10", userId: "u1", chargeMinorUnits: 470_000 },
    now: "2026-06-15T12:00:00.000Z",
    badCharge: Number.NaN,
  },
];

// ---------------------------------------------------------------------------

describe("Part C3 — both implementations on the same ten inputs", () => {
  SCENARIOS.forEach((scenario) => {
    it(`${scenario.name} — identical behaviour`, async () => {
      const mine = await run(scenario, "mine");
      const theirs = await run(scenario, "theirs");

      expect(theirs.outcome).toEqual(mine.outcome);
      expect(theirs.writes).toBe(mine.writes);
    });
  });

  it("produced the expected outcome for all ten, not merely the same outcome", async () => {
    // Equality between two implementations is only meaningful if at least some of the
    // results are non-trivial. This pins the ten results so a pair that agreed
    // because both returned nothing could not pass.
    const results: Outcome[] = [];
    for (const scenario of SCENARIOS) {
      results.push((await run(scenario, "theirs")).outcome);
    }

    expect(results).toEqual([
      { kind: "success", discount: 117_500, payable: 352_500, replayed: false },
      { kind: "success", discount: 125_000, payable: 374_999, replayed: false },
      { kind: "success", discount: 117_500, payable: 352_500, replayed: false },
      { kind: "success", discount: 50_000, payable: 150_000, replayed: false },
      { kind: "success", discount: 117_500, payable: 352_500, replayed: false },
      { kind: "success", discount: 60_000, payable: 410_000, replayed: true },
      { kind: "error", code: "CODE_ALREADY_USED" },
      { kind: "error", code: "MINIMUM_SPEND_NOT_MET" },
      { kind: "error", code: "INVALID_DISCOUNT_VALUE" },
      { kind: "error", code: "INVALID_AMOUNT" },
    ]);

    // Six distinct outcomes across ten inputs: three successes with different money,
    // one replay, and four distinct rejections.
    expect(new Set(results.map((r) => (r.kind === "error" ? r.code : "ok"))).size).toBe(5);
  });

  it("writes exactly one row when it succeeds and none when it rejects", async () => {
    // Pinned per scenario: 1-5 succeed and write once; 6 and 7 already had a row
    // seeded and must not add another; 8, 9 and 10 are rejections and write nothing.
    const expectedWrites = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0];

    for (const [index, scenario] of SCENARIOS.entries()) {
      const mine = await run(scenario, "mine");
      const theirs = await run(scenario, "theirs");

      expect(mine.writes).toBe(expectedWrites[index]);
      expect(theirs.writes).toBe(expectedWrites[index]);
    }
  });

  it("agrees on the two raced-constraint paths", async () => {
    // Not part of the ten, but the paths where the two implementations could most
    // plausibly diverge: one must reject, the other must replay.
    const racedUser: Scenario = {
      name: "race on the per-user constraint",
      code: { ...BASE },
      request: { code: "SAVE25", orderReference: "ps-r1", userId: "u1", chargeMinorUnits: 470_000 },
      now: "2026-06-15T12:00:00.000Z",
      race: "discountCodeId_userId",
    };
    const racedIntent: Scenario = {
      name: "race on the payment-intent constraint",
      code: { ...BASE },
      request: { code: "SAVE25", orderReference: "ps-r2", userId: "u1", chargeMinorUnits: 470_000 },
      now: "2026-06-15T12:00:00.000Z",
      preExisting: { orderReference: "ps-r2", userId: "u1" },
      race: "discountCodeId_orderReference",
    };

    for (const scenario of [racedUser, racedIntent]) {
      const mine = await run(scenario, "mine");
      const theirs = await run(scenario, "theirs");
      expect(theirs.outcome).toEqual(mine.outcome);
    }
  });
});