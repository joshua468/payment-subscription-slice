/**
 * Part A1 harness — checks the hand traces in
 *   task-5/part-a/a1-own/01-fulfil-from-webhook.md
 *   task-5/part-a/a1-own/02-calculate-proration.md
 *   task-5/part-a/a1-own/03-verify-webhook-signature.md
 *
 * Run:
 *   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
 *
 * The three pseudocode documents were written by tracing the real source before any
 * code ran. This is where those predictions are checked. Where a test disagrees with a
 * number in a document, THE DOCUMENT IS WRONG.
 *
 * The three functions under test are the real ones in the application — nothing is
 * reimplemented here. fulfilFromWebhook needs Prisma, so the test writes to the same
 * database the project's own suite uses, under a namespaced user id, and cleans up
 * after itself.
 */

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  USER_ID: "task5-a1-trace-user",
  verifyTransaction: vi.fn(),
}));

vi.mock("@/lib/payment/flutterwave", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payment/flutterwave")
  >();
  return { ...actual, verifyTransaction: mocks.verifyTransaction };
});

import { calculateProration, daysBetween } from "@/lib/proration/calculate";
import { verifyWebhookSignature } from "@/lib/payment/flutterwave";
import { prisma } from "@/lib/db";
import { fulfilFromWebhook } from "@/lib/subscription/service";
import type { FlutterwaveWebhookData } from "@/types/payment";

// ---------------------------------------------------------------------------
// A1.2 — calculateProration. Pure, no database needed.
// ---------------------------------------------------------------------------

describe("A1 trace — calculateProration", () => {
  const YEARLY = 5_000_000;
  const MONTHLY = 500_000;

  it("1 (normal) — 18 days of a monthly plan: the PRD's first worked example", () => {
    const result = calculateProration({
      currentAmountMinorUnits: MONTHLY,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 18,
    });

    expect(result.fullPrecisionCredit).toBe(300_000);
    expect(result.creditMinorUnits).toBe(300_000);
    expect(result.proratedChargeMinorUnits).toBe(4_700_000);
  });

  it("2 (edge) — 7 days: the PRD's second worked example, and the credit stays unrounded", () => {
    const result = calculateProration({
      currentAmountMinorUnits: MONTHLY,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 7,
    });

    // The credit is NOT 116,667. It is the unrounded 116,666.666...
    expect(result.fullPrecisionCredit).toBeCloseTo(116_666.666_666_666_67, 6);
    expect(result.fullPrecisionCredit).not.toBe(116_667);
    expect(result.creditMinorUnits).toBe(116_667);
    expect(result.proratedChargeMinorUnits).toBe(4_883_333);
  });

  it("3a (invalid) — 31 days on a 30-day period throws, rather than clamping", () => {
    const outOfRange = () =>
      calculateProration({
        currentAmountMinorUnits: MONTHLY,
        newAmountMinorUnits: YEARLY,
        newInterval: "yearly",
        currentInterval: "monthly",
        daysRemaining: 31,
      });

    expect(outOfRange).toThrow(RangeError);
    expect(outOfRange).toThrow("daysRemaining must be between 0 and 30; got 31");
  });

  it("3b (edge probe) — Input 3b's shape: 100000 minor units, 1 day", () => {
    const result = calculateProration({
      currentAmountMinorUnits: 100_000,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 1,
    });

    expect(result.fullPrecisionCredit).toBeCloseTo(3_333.333_333_333_333, 6);
    expect(result.creditMinorUnits).toBe(3_333);
    expect(result.proratedChargeMinorUnits).toBe(4_996_667);
  });

  it("3c (probe) — 2 days on the monthly plan, the case the summary table mixed up", () => {
    // Input 3b uses 100000 minor units; every other row of the document's summary
    // table uses the 500000 monthly plan. These are different answers.
    const twoDaysMonthly = calculateProration({
      currentAmountMinorUnits: MONTHLY,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 2,
    });
    expect(twoDaysMonthly.creditMinorUnits).toBe(33_333);
    expect(twoDaysMonthly.proratedChargeMinorUnits).toBe(4_966_667);

    const twoDaysSmall = calculateProration({
      currentAmountMinorUnits: 100_000,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 2,
    });
    expect(twoDaysSmall.creditMinorUnits).toBe(6_667);
    expect(twoDaysSmall.proratedChargeMinorUnits).toBe(4_993_333);
  });

  it("4 (edge probe) — 0 days remaining means no credit and the full new price", () => {
    const result = calculateProration({
      currentAmountMinorUnits: MONTHLY,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 0,
    });

    expect(result.creditMinorUnits).toBe(0);
    expect(result.proratedChargeMinorUnits).toBe(YEARLY);
  });

  it("4b (zero-floor probe) — a downgrade whose credit exceeds the new price floors at 0", () => {
    const result = calculateProration({
      currentAmountMinorUnits: YEARLY,
      newAmountMinorUnits: MONTHLY,
      newInterval: "monthly",
      currentInterval: "yearly",
      daysRemaining: 365,
    });

    // Credit would be the whole 5,000,000, far more than the 500,000 target.
    expect(result.proratedChargeMinorUnits).toBe(0);
    expect(result.proratedChargeMinorUnits).toBeGreaterThanOrEqual(0);
  });

  it("uses 30 and 365 days, never calendar months", () => {
    const thirty = calculateProration({
      currentAmountMinorUnits: MONTHLY,
      newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "monthly",
      daysRemaining: 30,
    });
    expect(thirty.creditMinorUnits).toBe(MONTHLY);

    // 365 days is accepted for yearly; 366 is not. A leap year does not change it.
    expect(() =>
      calculateProration({
        currentAmountMinorUnits: YEARLY,
newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "yearly",
        daysRemaining: 365,
      })
    ).not.toThrow();
    expect(() =>
      calculateProration({
        currentAmountMinorUnits: YEARLY,
newAmountMinorUnits: YEARLY,
      newInterval: "yearly",
      currentInterval: "yearly",
        daysRemaining: 366,
      })
    ).toThrow(RangeError);
  });

  it("daysBetween floors to whole days and never returns a negative", () => {
    const day = 86_400_000;
    const base = new Date("2026-06-15T00:00:00.000Z");

    expect(daysBetween(base, new Date(base.getTime() + 18 * day))).toBe(18);
    expect(daysBetween(base, new Date(base.getTime() + 18.9 * day))).toBe(18);
    // Before the start gives 0, not a negative.
    expect(daysBetween(base, new Date(base.getTime() - 5 * day))).toBe(0);
  });

  it("reconciles against the full-precision credit, never the rounded one", () => {
    for (const days of [0, 1, 2, 7, 13, 18, 29, 30]) {
      const { fullPrecisionCredit, proratedChargeMinorUnits } =
        calculateProration({
          currentAmountMinorUnits: MONTHLY,
          newAmountMinorUnits: YEARLY,
        newInterval: "yearly",
        currentInterval: "monthly",
          daysRemaining: days,
        });

      expect(
        Math.abs(fullPrecisionCredit + proratedChargeMinorUnits - YEARLY)
      ).toBeLessThanOrEqual(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// A1.3 — verifyWebhookSignature
//
// The real signature is positional:
//   verifyWebhookSignature(rawBody, flutterwaveSignature, verifHash)
// NOT a headers object. Two details in the pseudocode that are easy to get wrong:
//   1. the current mechanism is a BASE64 digest, not hex;
//   2. the legacy verif-hash is compared against the SECRET ITSELF, not against an
//      HMAC of the body — so the legacy mechanism does not bind to the payload at all.
// ---------------------------------------------------------------------------

describe("A1 trace — verifyWebhookSignature", () => {
  // getPaymentConfig() validates the SHAPE of the credentials (the test-mode prefix),
  // not their validity, so a fake test-shaped pair is enough here.
  const SECRET = "FLWSECK_TEST-dummy-secret";
  const PUBLIC = "FLWPUBK_TEST-dummy-public";
  let savedSecret: string | undefined;
  let savedPublic: string | undefined;
  let savedMode: string | undefined;
  let savedWebhookSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.FLUTTERWAVE_SECRET_KEY;
    savedPublic = process.env.FLUTTERWAVE_PUBLIC_KEY;
    savedMode = process.env.PAYMENT_MODE;
    savedWebhookSecret = process.env.FLUTTERWAVE_WEBHOOK_SECRET;

    process.env.FLUTTERWAVE_SECRET_KEY = SECRET;
    process.env.FLUTTERWAVE_PUBLIC_KEY = PUBLIC;
    process.env.PAYMENT_MODE = "test";
    // Unset, so step 2 of the pseudocode falls back to the configured secret key.
    delete process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = savedSecret;
    if (savedPublic === undefined) delete process.env.FLUTTERWAVE_PUBLIC_KEY;
    else process.env.FLUTTERWAVE_PUBLIC_KEY = savedPublic;
    if (savedMode === undefined) delete process.env.PAYMENT_MODE;
    else process.env.PAYMENT_MODE = savedMode;
    if (savedWebhookSecret === undefined) delete process.env.FLUTTERWAVE_WEBHOOK_SECRET;
    else process.env.FLUTTERWAVE_WEBHOOK_SECRET = savedWebhookSecret;
  });

  const body = '{"event":"charge.completed","data":{"id":"tx-1"}}';
  // Base64, 44 characters for a SHA-256 digest — matching the document's traces.
  const digest = (raw: string) =>
    createHmac("sha256", SECRET).update(raw, "utf8").digest("base64");

  it("1 (normal) — accepts a correct current-mechanism signature", () => {
    expect(digest(body)).toHaveLength(44);
    expect(verifyWebhookSignature(body, digest(body), null)).toBe(true);
  });

  it("2 (edge) — accepts the legacy header, which is the secret itself", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(true);
  });

  it("3 (adversarial) — a forged current signature is accepted if a valid legacy hash rides along", () => {
    // This is the finding in 03-verify-webhook-signature.md: the two mechanisms are
    // OR-ed, so the legacy branch can rescue a request the HMAC branch rejected.
    const forged = "A".repeat(44);
    expect(verifyWebhookSignature(body, forged, null)).toBe(false);
    expect(verifyWebhookSignature(body, forged, SECRET)).toBe(true);
  });

  it("3b (adversarial) — the legacy mechanism does not bind to the body at all", () => {
    // Any body whatsoever authenticates if verif-hash carries the secret. This is
    // stronger evidence than Input 3: it is not about OR-ing two mechanisms, it is
    // that the legacy path never looks at rawBody.
    const attack = '{"event":"charge.completed","data":{"id":"attacker-999"}}';
    expect(verifyWebhookSignature(attack, null, SECRET)).toBe(true);
  });

  it("4 (invalid) — rejects when neither header is present", () => {
    expect(verifyWebhookSignature(body, null, null)).toBe(false);
    expect(verifyWebhookSignature(body, "", "")).toBe(false);
  });

  it("5 (edge) — rejects a body that was tampered with after signing", () => {
    const signature = digest(body);
    const tampered = '{"event":"charge.completed","data":{"id":"tx-999"}}';

    expect(verifyWebhookSignature(tampered, signature, null)).toBe(false);
  });

  it("6 (adversarial) — refuses to verify at all when the credential mode does not match", () => {
    // Prod mode with a test secret key is Rule 10's forbidden mix. The throw happens
    // in step 1, before any signature is examined.
    process.env.PAYMENT_MODE = "prod";
    expect(() => verifyWebhookSignature(body, digest(body), null)).toThrow(
      /CREDENTIAL_MODE_MISMATCH|test/i
    );
  });

  it("7 (edge) — FLUTTERWAVE_WEBHOOK_SECRET overrides the API secret key", () => {
    process.env.FLUTTERWAVE_WEBHOOK_SECRET = "a-different-webhook-secret";
    const withOverride = createHmac("sha256", "a-different-webhook-secret")
      .update(body, "utf8")
      .digest("base64");

    expect(verifyWebhookSignature(body, withOverride, null)).toBe(true);
    // The old secret no longer works once the override is set.
    expect(verifyWebhookSignature(body, digest(body), null)).toBe(false);
  });

  it("rejects a digest of the wrong length without throwing", () => {
    // The length guard exists so timingSafeEqual is never handed mismatched buffers.
    expect(verifyWebhookSignature(body, "abc", null)).toBe(false);
    expect(verifyWebhookSignature(body, "a".repeat(43), null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A1.1 — fulfilFromWebhook. Needs Prisma.
//
// The real signature is (data, flutterwaveEventId, rawBody) and the return is
// { duplicate, status } — not an `outcome` field. The subscription is found via
// findSubscriptionByTxRef, which matches data.tx_ref against rawWebhookPayload.txRef
// on a recent `initiation` row. So a seeded subscription alone is not enough: the
// fixture has to create the initiation row that checkout would have written.
// ---------------------------------------------------------------------------

const TX_REF = "task5-tx-ref";

function webhookData(
  overrides: Partial<FlutterwaveWebhookData> = {}
): FlutterwaveWebhookData {
  return {
    id: 900_001,
    tx_ref: TX_REF,
    status: "successful",
    amount: 50_000,
    currency: "NGN",
    // customer.id is a string in the schema (flutterwaveCustomerId is a String column).
    customer: { id: "500001" },
    ...overrides,
  } as FlutterwaveWebhookData;
}

describe("A1 trace — fulfilFromWebhook", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "task5-a1@example.com", name: "Task5" },
    });
  });

  afterAll(async () => {
    // Cascades from the user via Subscription -> PaymentLog.
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  beforeEach(async () => {
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    mocks.verifyTransaction.mockReset();
  });

  /** Mirrors what POST /api/checkout leaves behind: a payment_pending
   *  subscription plus the initiation row carrying the txRef. */
  async function seedCheckout(interval: "monthly" | "yearly", amountMinorUnits: number) {
    const subscription = await prisma.subscription.create({
      data: {
        userId: mocks.USER_ID,
        plan: "Pro",
        interval,
        currency: "NGN",
        amountMinorUnits,
        status: "payment_pending",
      },
    });
    await prisma.paymentLog.create({
      data: {
        subscriptionId: subscription.id,
        userId: mocks.USER_ID,
        stage: "initiation",
        rawWebhookPayload: { txRef: TX_REF, amountChargedMinorUnits: amountMinorUnits },
      },
    });
    return subscription;
  }

  it("1 (normal) — a verified successful payment appends three rows and opens a 365-day period", async () => {
    await seedCheckout("yearly", 5_000_000);
    mocks.verifyTransaction.mockResolvedValue({ status: "successful", amount: 50_000 });

    const result = await fulfilFromWebhook(webhookData(), "task5-evt-ok", "{}");

    expect(result).toEqual({ duplicate: false, status: "fulfilled" });

    const log = await prisma.paymentLog.findMany({
      where: { userId: mocks.USER_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(log.map((row) => row.stage)).toEqual([
      "initiation",
      "verification",
      "fulfilment",
    ]);

    // Only the verification row owns the event id. The column is @unique, so writing
    // it on the fulfilment row as well would make the second insert throw and turn a
    // successful payment into a 500. This is the claim the document asserts.
    const verification = log.find((row) => row.stage === "verification");
    const fulfilment = log.find((row) => row.stage === "fulfilment");
    expect(verification?.flutterwaveEventId).toBe("task5-evt-ok");
    expect(fulfilment?.flutterwaveEventId).toBeNull();

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: mocks.USER_ID },
    });
    expect(subscription.status).toBe("active");
    expect(subscription.interval).toBe("yearly");
    expect(subscription.flutterwaveCustomerId).toBe("500001");

    // periodStart/periodEnd are nullable columns (a payment_pending row has none), so
    // assert they are populated rather than asserting through `!`.
    expect(subscription.periodStart).not.toBeNull();
    expect(subscription.periodEnd).not.toBeNull();
    const periodStart = subscription.periodStart as Date;
    const periodEnd = subscription.periodEnd as Date;

    const spanDays = Math.round(
      (periodEnd.getTime() - periodStart.getTime()) / 86_400_000
    );
    expect(spanDays).toBe(365);
    expect(periodEnd.getTime()).toBeGreaterThan(Date.now());
  });

  it("2 (edge) — a duplicate event id is already_processed and changes nothing", async () => {
    await seedCheckout("yearly", 5_000_000);
    mocks.verifyTransaction.mockResolvedValue({ status: "successful", amount: 50_000 });

    const first = await fulfilFromWebhook(webhookData(), "task5-evt-dup", "{}");
    const afterFirst = await prisma.subscription.findUniqueOrThrow({
      where: { userId: mocks.USER_ID },
    });

    const second = await fulfilFromWebhook(webhookData(), "task5-evt-dup", "{}");

    expect(first.status).toBe("fulfilled");
    expect(second).toEqual({ duplicate: true, status: "already_processed" });

    // No second provider call, no new rows, and the period is not extended again.
    expect(mocks.verifyTransaction).toHaveBeenCalledTimes(1);
    // Still just the seeded initiation plus the two rows the first call wrote.
    expect(await prisma.paymentLog.count({ where: { userId: mocks.USER_ID } })).toBe(3);

    const afterSecond = await prisma.subscription.findUniqueOrThrow({
      where: { userId: mocks.USER_ID },
    });
    expect(afterFirst.periodEnd).not.toBeNull();
    expect((afterSecond.periodEnd as Date).getTime()).toBe(
      (afterFirst.periodEnd as Date).getTime()
    );
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
  });

  it("3 (adversarial) — a transient provider error is unconfirmed and consumes no event id", async () => {
    await seedCheckout("yearly", 5_000_000);
    mocks.verifyTransaction.mockRejectedValue(new Error("provider timeout"));

    const result = await fulfilFromWebhook(webhookData(), "task5-evt-flaky", "{}");

    expect(result).toEqual({ duplicate: false, status: "unconfirmed" });
    // Only the seeded initiation row — no verification, no failure row.
    expect(await prisma.paymentLog.count({ where: { userId: mocks.USER_ID } })).toBe(1);

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: mocks.USER_ID },
    });
    expect(subscription.status).toBe("payment_pending");

    // The event id was NOT consumed, so a later webhook can still fulfil it.
    mocks.verifyTransaction.mockResolvedValue({ status: "successful", amount: 50_000 });
    const retry = await fulfilFromWebhook(webhookData(), "task5-evt-flaky", "{}");
    expect(retry.status).toBe("fulfilled");
  });

  it("4 (adversarial) — a provider-verified failure writes a failure row and grants nothing", async () => {
    await seedCheckout("yearly", 5_000_000);
    mocks.verifyTransaction.mockResolvedValue({ status: "failed", amount: 0 });

    const result = await fulfilFromWebhook(webhookData(), "task5-evt-fail", "{}");

    expect(result).toEqual({ duplicate: false, status: "failed" });
    expect(
      await prisma.paymentLog.count({
        where: { userId: mocks.USER_ID, stage: "fulfilment" },
      })
    ).toBe(0);

    const failure = await prisma.paymentLog.findFirstOrThrow({
      where: { userId: mocks.USER_ID, stage: "failure" },
    });
    expect(failure.errorReason).toContain("failed");

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: mocks.USER_ID },
    });
    expect(subscription.status).not.toBe("active");
  });

  it("5 (adversarial) — a payload claiming success cannot outvote the provider", async () => {
    await seedCheckout("yearly", 5_000_000);
    // Payload says successful; the provider says otherwise. Both must agree.
    mocks.verifyTransaction.mockResolvedValue({ status: "failed", amount: 0 });

    const result = await fulfilFromWebhook(
      webhookData({ status: "successful" }),
      "task5-evt-mismatch",
      "{}"
    );

    expect(result.status).toBe("failed");
    expect(
      await prisma.paymentLog.count({
        where: { userId: mocks.USER_ID, stage: "fulfilment" },
      })
    ).toBe(0);
  });

  it("6 (adversarial) — an unmatched tx_ref grants nothing and writes no rows", async () => {
    await seedCheckout("yearly", 5_000_000);
    mocks.verifyTransaction.mockResolvedValue({ status: "successful", amount: 50_000 });

    const result = await fulfilFromWebhook(
      webhookData({ tx_ref: "a-tx-ref-nobody-issued" }),
      "task5-evt-orphan",
      "{}"
    );

    expect(result).toEqual({ duplicate: false, status: "failed_no_subscription" });
    expect(
      await prisma.paymentLog.count({
        where: { userId: mocks.USER_ID, stage: "fulfilment" },
      })
    ).toBe(0);
  });
});