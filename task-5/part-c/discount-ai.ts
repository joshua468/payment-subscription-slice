/**
 * Part C — AI implementation of the discount redemption spec.
 *
 * WHAT THIS IS: the output of step C1, which is to give the requirements in
 * task-5/part-b/01-specification.md to an AI and take what comes back. This file is
 * that output.
 *
 * A LIMITATION YOU SHOULD KNOW BEFORE READING THE COMPARISON IN 02-compare.md:
 * the same model that wrote part-b/discount.ts produced this file. So this is a
 * comparison of one approach against itself, from two different framings — not a
 * comparison against independent work. A genuinely independent implementation would
 * surface different differences, especially different *wrong* ones. Read
 * 02-compare.md with that in mind.
 *
 * Constraints I gave the model when producing this file:
 *   - implement only what 01-specification.md states; do not add features
 *   - money as integer minor units, no floats in storage
 *   - typed error codes, one DiscountError class
 *   - repositories injected, no database
 *   - keep it independent of the structure used in part-b/discount.ts, so that any
 *     structural difference is visible in the comparison
 *
 * Style note: this is deliberately organised as a chain of small named predicates
 * rather than as one long body of inline checks. That is a different architectural
 * choice from part-b, and it is the source of the largest single difference in the
 * comparison — not a behavioural one.
 */

export class DiscountError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown>;

  constructor(code: string, message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = "DiscountError";
    this.code = code;
    this.meta = meta;
  }
}

export interface DiscountCode {
  id: string;
  code: string;
  /** Basis points. 10000 = 100%. */
  percentBps: number;
  /** Kobo. null = no floor. */
  minimumChargeMinorUnits: number | null;
  activeFrom: Date | null;
  activeUntil: Date | null;
  redemptionLimit: number;
}

export interface Redemption {
  discountCodeId: string;
  code: string;
  userId: string;
  paymentRef: string;
  chargeMinorUnits: number;
  discountMinorUnits: number;
  payableMinorUnits: number;
  createdAt: Date;
}

export interface RedeemRequest {
  code: string;
  paymentRef: string;
  userId: string;
  chargeMinorUnits: number;
}

export interface RedeemOutcome {
  code: string;
  discountMinorUnits: number;
  payableMinorUnits: number;
  replayed: boolean;
  totalRedeemedMinorUnits: number | null;
}

export interface Store {
  codeByName(name: string): Promise<DiscountCode | null>;
  redemptionByPaymentRef(
    name: string,
    paymentRef: string
  ): Promise<Redemption | null>;
  redemptionByUser(
    discountCodeId: string,
    userId: string
  ): Promise<Redemption | null>;
  redemptionCount(discountCodeId: string): Promise<number>;
  sumDiscountedMinorUnits(discountCodeId: string): Promise<number>;
  save(redemption: Redemption): Promise<Redemption>;
}

export interface Context {
  store: Store;
  clock: Date;
}

const MAX_BPS = 10_000;

function canonical(name: string): string {
  if (typeof name !== "string") {
    throw new DiscountError("INVALID_CODE_FORMAT", "code must be text");
  }
  const squeezed = name.trim();
  if (squeezed === "") {
    throw new DiscountError("INVALID_CODE_FORMAT", "code must not be blank");
  }
  return squeezed.toUpperCase();
}

function filled(value: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Kobo amounts must be whole, finite, non-negative and inside the safe range. */
function validKobo(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function withinWindow(code: DiscountCode, clock: Date): boolean {
  const afterOpen = code.activeFrom === null || clock >= code.activeFrom;
  const beforeClose = code.activeUntil === null || clock <= code.activeUntil;
  return afterOpen && beforeClose;
}

function withinCapLimit(code: DiscountCode, used: number): boolean {
  return used < code.redemptionLimit;
}

/**
 * True when this customer has never redeemed this code.
 *
 * Note the field this guards against: the error below reports `redeemedAt`, but the
 * `Redemption` shape it reads from calls the timestamp `createdAt`. That mismatch is
 * in the AI's original code — it does not type-check as written. See 01-compare.md.
 */
function untouchedByUser(existing: Redemption | null): existing is null {
  return existing === null;
}

/**
 * Percentage discount in kobo.
 *
 * The multiplication happens first and the division second, so the intermediate
 * product is not rounded. One rounding, at the point the value becomes money, then
 * clamped so it can never exceed what is being charged.
 */
function computeDiscount(
  chargeMinorUnits: number,
  percentBps: number
): number {
  const exact = (chargeMinorUnits * percentBps) / MAX_BPS;
  return Math.min(chargeMinorUnits, Math.round(exact));
}

function outcomeFrom(
  redemption: Redemption,
  replayed: boolean,
  total: number | null
): RedeemOutcome {
  return {
    code: redemption.code,
    discountMinorUnits: redemption.discountMinorUnits,
    payableMinorUnits: redemption.payableMinorUnits,
    replayed,
    totalRedeemedMinorUnits: total,
  };
}

async function readTotal(
  ctx: Context,
  discountCodeId: string
): Promise<number | null> {
  try {
    return await ctx.store.sumDiscountedMinorUnits(discountCodeId);
  } catch {
    return null;
  }
}

/** A save can lose a race. This names the constraint so the caller can act on it. */
function losingConstraint(error: unknown): "user" | "paymentRef" | null {
  if (
    error &&
    typeof error === "object" &&
    "constraint" in error &&
    typeof (error as { constraint: unknown }).constraint === "string"
  ) {
    const name = (error as { constraint: string }).constraint;
    if (name === "discountCodeId_userId") return "user";
    if (name === "discountCodeId_orderReference") return "paymentRef";
  }
  return null;
}

export async function redeemDiscountCode(
  request: RedeemRequest,
  ctx: Context
): Promise<RedeemOutcome> {
  const name = canonical(request.code);

  if (!filled(request.paymentRef)) {
    throw new DiscountError(
      "INVALID_ORDER_REFERENCE",
      "paymentRef is required"
    );
  }
  if (!filled(request.userId)) {
    throw new DiscountError("INVALID_USER", "sign-in required");
  }
  if (!validKobo(request.chargeMinorUnits)) {
    throw new DiscountError(
      "INVALID_AMOUNT",
      "charge must be whole, non-negative kobo",
      { chargeMinorUnits: request.chargeMinorUnits }
    );
  }

  // Replay wins over every eligibility rule. A customer who already paid must never
  // be told their code became invalid afterwards.
  const replay = await ctx.store.redemptionByPaymentRef(
    name,
    request.paymentRef
  );
  if (replay !== null) {
    return outcomeFrom(replay, true, await readTotal(ctx, replay.discountCodeId));
  }

  const discount = await ctx.store.codeByName(name);
  if (discount === null) {
    throw new DiscountError("CODE_NOT_FOUND", "unknown code", { code: name });
  }

  if (
    !Number.isSafeInteger(discount.percentBps) ||
    discount.percentBps < 0 ||
    discount.percentBps > MAX_BPS
  ) {
    throw new DiscountError(
      "INVALID_DISCOUNT_VALUE",
      "stored percentage is out of range",
      { code: name, percentBps: discount.percentBps }
    );
  }

  if (!withinWindow(discount, ctx.clock)) {
    const tooEarly =
      discount.activeFrom !== null && ctx.clock < discount.activeFrom;
    throw new DiscountError("CODE_NOT_ACTIVE", "code is not active", {
      code: name,
      reason: tooEarly ? "not_yet_active" : "expired",
    });
  }

  if (
    discount.minimumChargeMinorUnits !== null &&
    request.chargeMinorUnits < discount.minimumChargeMinorUnits
  ) {
    throw new DiscountError(
      "MINIMUM_SPEND_NOT_MET",
      "below minimum charge",
      {
        code: name,
        chargeMinorUnits: request.chargeMinorUnits,
        minimumChargeMinorUnits: discount.minimumChargeMinorUnits,
        shortByMinorUnits:
          discount.minimumChargeMinorUnits - request.chargeMinorUnits,
      }
    );
  }

  const used = await ctx.store.redemptionCount(discount.id);
  if (!withinCapLimit(discount, used)) {
    throw new DiscountError("CODE_EXHAUSTED", "redemption limit reached", {
      code: name,
      redemptionLimit: discount.redemptionLimit,
    });
  }

  const priorUse = await ctx.store.redemptionByUser(discount.id, request.userId);
  if (!untouchedByUser(priorUse)) {
    throw new DiscountError("CODE_ALREADY_USED", "code already used", {
      code: name,
      redeemedAt: priorUse.createdAt.toISOString(),
    });
  }

  const discountMinorUnits = computeDiscount(
    request.chargeMinorUnits,
    discount.percentBps
  );
  const payableMinorUnits = request.chargeMinorUnits - discountMinorUnits;

  const draft: Redemption = {
    discountCodeId: discount.id,
    code: discount.code,
    userId: request.userId,
    paymentRef: request.paymentRef,
    chargeMinorUnits: request.chargeMinorUnits,
    discountMinorUnits,
    payableMinorUnits,
    createdAt: ctx.clock,
  };

  try {
    const saved = await ctx.store.save(draft);
    return outcomeFrom(saved, false, await readTotal(ctx, saved.discountCodeId));
  } catch (error) {
    const constraint = losingConstraint(error);

    if (constraint === "user") {
      throw new DiscountError(
        "CODE_ALREADY_USED",
        "code already used by this account"
      );
    }

    if (constraint === "paymentRef") {
      const concurrent = await ctx.store.redemptionByPaymentRef(
        discount.code,
        request.paymentRef
      );
      if (concurrent !== null) {
        return outcomeFrom(
          concurrent,
          true,
          await readTotal(ctx, concurrent.discountCodeId)
        );
      }
    }

    throw error;
  }
}