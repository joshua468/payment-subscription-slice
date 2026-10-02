/**
 * Part B — discount code redemption.
 *
 * NOTE ON PROVENANCE: this file is AI-written. Part B of the assignment requires the
 * implementation to be written WITHOUT AI. That requirement is not met by this file,
 * and it cannot be met by anything I produce. See the authorship note at the end of
 * task-5/part-b/01-specification.md, which states what to do instead.
 *
 * The specification in 01-specification.md is self-sufficient: it contains the
 * requirements, the validation order and its justification, the error codes, and five
 * worked examples. A hand-written implementation can be derived from it without
 * reading this file. That is the point of writing the spec out in that much detail.
 *
 * Dependencies are injected (repositories + clock) so the logic is testable without a
 * database and without a real timer. In production these are Prisma-backed
 * implementations; see task-5/part-b/01-specification.md section 2.1 for why the
 * uniqueness constraints live on the database rather than in this file.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscountCodeRecord = {
  id: string;
  code: string;
  /** 10000 = 100%. An integer, never a float and never a percentage string. */
  basisPointsOff: number;
  /** In kobo. Null means no minimum. */
  minSpendMinorUnits: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxRedemptions: number;
};

export type DiscountRedemptionRecord = {
  discountCodeId: string;
  code: string;
  userId: string;
  orderReference: string;
  chargeMinorUnits: number;
  discountMinorUnits: number;
  finalChargeMinorUnits: number;
  redeemedAt: Date;
};

export type RedeemResult = {
  code: string;
  discountMinorUnits: number;
  finalChargeMinorUnits: number;
  /** True when this was an idempotent replay of an existing redemption. */
  alreadyRedeemed: boolean;
  /** The code's running redeemed total, when the repository can supply it. */
  discountedTotalMinorUnits: number | null;
};

export type RedeemInput = {
  code: string;
  orderReference: string;
  userId: string;
  /** The charge BEFORE any discount, in kobo. */
  chargeMinorUnits: number;
};

/**
 * Thrown for every rejection. The code is the contract with the client; the message
 * is for logs. Never throw a bare Error or a string from this module.
 */
export class DiscountError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "DiscountError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Repositories the service needs. The write methods must report a unique-constraint
 * violation distinctly from any other failure, because a constraint violation on
 * (code, userId) is a legitimate rejection rather than an exception.
 */
export type DiscountRepositories = {
  findCodeByCode(code: string): Promise<DiscountCodeRecord | null>;
  /**
   * Look up by normalised code string rather than by id, so the idempotency check can
   * run before we know whether the code still exists — which is the point, since a
   * replay must succeed even for a deleted or long-expired code.
   */
  findRedemptionByCodeAndOrderReference(
    code: string,
    orderReference: string
  ): Promise<DiscountRedemptionRecord | null>;
  findRedemptionByUser(
    discountCodeId: string,
    userId: string
  ): Promise<DiscountRedemptionRecord | null>;
  countRedemptions(discountCodeId: string): Promise<number>;
  /** Sum of discountMinorUnits across all redemptions of this code. */
  totalDiscountedMinorUnits(discountCodeId: string): Promise<number>;
  /**
   * Insert, or reject on a unique-constraint violation.
   * Throws an object with a `constraint` property naming which constraint was hit.
   */
  insertRedemption(
    record: DiscountRedemptionRecord
  ): Promise<DiscountRedemptionRecord>;
};

export type RedeemDependencies = {
  discounts: DiscountRepositories;
  now: Date;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BASIS_POINTS = 10_000;
const BASIS_POINTS_DIVISOR = 10_000;

/**
 * Trim and uppercase, so `SAVE10`, `save10` and ` save10 ` are the same code.
 * Without this a typo in case turns a valid code into "not found".
 */
export function normalizeCode(rawCode: string): string {
  if (typeof rawCode !== "string") {
    throw new DiscountError(
      "INVALID_CODE_FORMAT",
      "Discount code must be a string",
      { received: typeof rawCode }
    );
  }

  const trimmed = rawCode.trim();
  if (trimmed.length === 0) {
    throw new DiscountError(
      "INVALID_CODE_FORMAT",
      "Discount code is empty after trimming"
    );
  }

  return trimmed.toUpperCase();
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** NaN and Infinity both pass naive numeric checks, so guard explicitly. */
function isValidCharge(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function toResult(
  record: DiscountRedemptionRecord,
  alreadyRedeemed: boolean,
  discountedTotalMinorUnits: number | null
): RedeemResult {
  return {
    code: record.code,
    discountMinorUnits: record.discountMinorUnits,
    finalChargeMinorUnits: record.finalChargeMinorUnits,
    alreadyRedeemed,
    discountedTotalMinorUnits,
  };
}

/**
 * True when an insert failure was a unique-constraint violation, and names which one.
 * Checks defensively because the exact shape of a driver error varies by adapter.
 */
function constraintName(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    typeof (error as { constraint: unknown }).constraint === "string"
  ) {
    return (error as { constraint: string }).constraint;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export async function redeemDiscountCode(
  input: RedeemInput,
  deps: RedeemDependencies
): Promise<RedeemResult> {
  const { discounts, now } = deps;

  // --- 1. Shape validation, before any database access -------------------
  const code = normalizeCode(input.code);

  if (!isNonEmptyText(input.orderReference)) {
    throw new DiscountError(
      "INVALID_ORDER_REFERENCE",
      "orderReference is required to attach a discount to a payment intent"
    );
  }
  if (!isNonEmptyText(input.userId)) {
    throw new DiscountError("INVALID_USER", "A signed-in user is required");
  }
  if (!isValidCharge(input.chargeMinorUnits)) {
    throw new DiscountError(
      "INVALID_AMOUNT",
      "chargeMinorUnits must be a non-negative safe integer in kobo",
      { received: input.chargeMinorUnits }
    );
  }

  // --- 2. Idempotency first (spec Rule A) --------------------------------
  // Before eligibility, so that a retry of a successful request still succeeds even
  // if the code has since expired or hit its cap.
  const existingForIntent = await discounts.findRedemptionByCodeAndOrderReference(
    code,
    input.orderReference
  );
  if (existingForIntent) {
    return toResult(
      existingForIntent,
      true,
      await safeTotal(discounts, existingForIntent.discountCodeId)
    );
  }

  // --- 3. Existence -------------------------------------------------------
  const discount = await discounts.findCodeByCode(code);
  if (!discount) {
    throw new DiscountError("CODE_NOT_FOUND", "No such discount code", { code });
  }

  // --- 4. Validate the stored value itself, BEFORE the window -------------
  // Deliberately ordered ahead of the window check (spec section 4.4): a
  // misconfigured percentage is a data defect that maps to a 500 and should page
  // someone. Buried under a 410, it sits unnoticed until someone uses the code
  // during its active window -- which may never happen.
  if (
    !Number.isSafeInteger(discount.basisPointsOff) ||
    discount.basisPointsOff < 0 ||
    discount.basisPointsOff > MAX_BASIS_POINTS
  ) {
    throw new DiscountError(
      "INVALID_DISCOUNT_VALUE",
      "Discount code has an out-of-range percentage",
      { code, basisPointsOff: discount.basisPointsOff }
    );
  }

  // --- 5. Window (both bounds inclusive) ----------------------------------
  if (discount.startsAt !== null && now < discount.startsAt) {
    throw new DiscountError("CODE_NOT_ACTIVE", "This code is not yet active", {
      reason: "not_yet_active",
      startsAt: discount.startsAt.toISOString(),
    });
  }
  if (discount.expiresAt !== null && now > discount.expiresAt) {
    throw new DiscountError("CODE_NOT_ACTIVE", "This code has expired", {
      reason: "expired",
      expiresAt: discount.expiresAt.toISOString(),
    });
  }

  // --- 6. Minimum spend ---------------------------------------------------
  if (
    discount.minSpendMinorUnits !== null &&
    input.chargeMinorUnits < discount.minSpendMinorUnits
  ) {
    throw new DiscountError(
      "MINIMUM_SPEND_NOT_MET",
      "Charge is below this code's minimum spend",
      {
        code,
        chargeMinorUnits: input.chargeMinorUnits,
        minSpendMinorUnits: discount.minSpendMinorUnits,
        shortfallMinorUnits:
          discount.minSpendMinorUnits - input.chargeMinorUnits,
      }
    );
  }

  // --- 7. Global cap (racy by nature; the constraint is authoritative) ----
  const redemptionCount = await discounts.countRedemptions(discount.id);
  if (redemptionCount >= discount.maxRedemptions) {
    throw new DiscountError("CODE_EXHAUSTED", "This code has been fully claimed", {
      code,
      maxRedemptions: discount.maxRedemptions,
    });
  }

  // --- 8. One use per customer (also racy; constraint is authoritative) ---
  const existingForUser = await discounts.findRedemptionByUser(
    discount.id,
    input.userId
  );
  if (existingForUser) {
    throw new DiscountError(
      "CODE_ALREADY_USED",
      "This code has already been used by this account",
      { code, redeemedAt: existingForUser.redeemedAt.toISOString() }
    );
  }

  // --- 9. Compute: exactly one rounding, on the discount ------------------
  const rawDiscount =
    (input.chargeMinorUnits * discount.basisPointsOff) / BASIS_POINTS_DIVISOR;

  // Round once, then cap at the charge. Order matters: rounding first then capping
  // gives a discount that is always <= charge, hence a final charge >= 0.
  const discountMinorUnits = Math.min(
    input.chargeMinorUnits,
    Math.round(rawDiscount)
  );

  const finalChargeMinorUnits = input.chargeMinorUnits - discountMinorUnits;

  // --- 10. The single write ------------------------------------------------
  const record: DiscountRedemptionRecord = {
    discountCodeId: discount.id,
    code: discount.code,
    userId: input.userId,
    orderReference: input.orderReference,
    chargeMinorUnits: input.chargeMinorUnits,
    discountMinorUnits,
    finalChargeMinorUnits,
    redeemedAt: now,
  };

  try {
    const created = await discounts.insertRedemption(record);
    return toResult(
      created,
      false,
      await safeTotal(discounts, created.discountCodeId)
    );
  } catch (error) {
    const constraint = constraintName(error);

    // A concurrent request took the last redemption for this user.
    if (constraint === "discountCodeId_userId") {
      throw new DiscountError(
        "CODE_ALREADY_USED",
        "This code has already been used by this account"
      );
    }

    // A concurrent request created the redemption for this same intent. Both the
    // success path and this path must behave identically, because the client cannot
    // tell which one it hit.
    if (constraint === "discountCodeId_orderReference") {
      const raced = await discounts.findRedemptionByCodeAndOrderReference(
        discount.code,
        input.orderReference
      );
      if (raced) {
        return toResult(raced, true, await safeTotal(discounts, raced.discountCodeId));
      }
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function safeTotal(
  discounts: DiscountRepositories,
  discountCodeId: string
): Promise<number | null> {
  try {
    return await discounts.totalDiscountedMinorUnits(discountCodeId);
  } catch {
    // A reporting total must never turn a successful redemption into an error.
    return null;
  }
}