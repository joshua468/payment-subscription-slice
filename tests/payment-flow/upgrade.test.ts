import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FlutterwaveWebhookData } from "@/types/payment";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-upgrade-user",
  initiateCheckout: vi.fn(),
  verifyTransaction: vi.fn(),
}));

vi.mock("@/lib/payment/flutterwave", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payment/flutterwave")
  >();
  return {
    ...actual,
    initiateCheckout: mocks.initiateCheckout,
    verifyTransaction: mocks.verifyTransaction,
  };
});

import { prisma } from "@/lib/db";
import {
  fulfilFromWebhook,
  initiateSubscription,
} from "@/lib/subscription/service";
import type { SubscriptionStatus } from "@/types/payment";

const MS_PER_DAY = 86_400_000;

// periodEnd is always set to half a day past the whole-day boundary so the
// floor() inside daysBetween is stable regardless of exact call time.
function futurePeriodEnd(daysFromNow: number): Date {
  return new Date(Date.now() + (daysFromNow + 0.5) * MS_PER_DAY);
}

async function seedMonthly(
  userId: string,
  status: SubscriptionStatus,
  periodEnd: Date
) {
  const sub = await prisma.subscription.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      plan: "Pro",
      interval: "monthly",
      currency: "USD",
      amountMinorUnits: 1050,
      status,
      periodStart: new Date(Date.now() - 14.5 * MS_PER_DAY),
      periodEnd,
    },
  });
  await prisma.paymentLog.create({
    data: { subscriptionId: sub.id, userId, stage: "fulfilment" },
  });
  return sub;
}

async function tearDown(userId: string) {
  await prisma.paymentLog.deleteMany({ where: { userId } });
  await prisma.subscription.deleteMany({ where: { userId } });
}

describe("prorated upgrade to yearly", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "upgrade@example.com", name: "Upgrade" },
    });

    mocks.initiateCheckout.mockImplementation(async (params: { txRef: string }) => ({
      flutterwaveRedirectUrl: "https://checkout.example/flw/yr",
      flutterwavePaymentId: "999",
      txRef: params.txRef,
    }));
  });

  afterAll(async () => {
    await tearDown(mocks.USER_ID);
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("charges only the prorated difference for an active monthly subscription", async () => {
    await tearDown(mocks.USER_ID);
    await seedMonthly(mocks.USER_ID, "active", futurePeriodEnd(15));

    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "yearly" },
      "upgrade@example.com",
      "Upgrade",
      "http://localhost:3000/checkout/success"
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;

    // 15 days remain → credit 1050/30×15 = 525 → charge 10500 − 525 = 9975.
    const proration = outcome.result.proration!;
    expect(proration.daysRemaining).toBe(15);
    expect(proration.creditMinorUnits).toBe(525);
    expect(proration.proratedChargeMinorUnits).toBe(9975);

    const initLog = await prisma.paymentLog.findFirst({
      where: { userId: mocks.USER_ID, stage: "initiation" },
      orderBy: { createdAt: "desc" },
    });
    const payload = (initLog?.rawWebhookPayload ?? {}) as {
      amountChargedMinorUnits?: number;
    };
    expect(payload.amountChargedMinorUnits).toBe(9975);
  });

  it("prorates the upgrade even when cancellation is already pending (bug fix)", async () => {
    await tearDown(mocks.USER_ID);
    await seedMonthly(mocks.USER_ID, "pending_cancellation", futurePeriodEnd(12));

    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "yearly" },
      "upgrade@example.com",
      "Upgrade",
      "http://localhost:3000/checkout/success"
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;

    // 12 days remain → credit 1050/30×12 = 420 → charge 10500 − 420 = 10080.
    expect(outcome.result.proration?.daysRemaining).toBe(12);
    expect(outcome.result.proration?.proratedChargeMinorUnits).toBe(10080);

    // The pending cancellation is superseded by the new payment intent.
    const current = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(current?.status).toBe("payment_pending");
    expect(current?.cancellationReason).toBeNull();
  });

  it("rejects choosing the same interval while a cancellation is pending", async () => {
    mocks.initiateCheckout.mockClear();
    await tearDown(mocks.USER_ID);
    await seedMonthly(mocks.USER_ID, "pending_cancellation", futurePeriodEnd(10));

    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "monthly" },
      "upgrade@example.com",
      "Upgrade",
      "http://localhost:3000/checkout/success"
    );

    expect(outcome.kind).toBe("conflict");
    expect(mocks.initiateCheckout).not.toHaveBeenCalled();
  });

  it("records a new fulfilment row when the upgraded purchase settles (bug fix)", async () => {
    mocks.initiateCheckout.mockClear();
    mocks.verifyTransaction.mockClear();
    await tearDown(mocks.USER_ID);
    await seedMonthly(mocks.USER_ID, "active", futurePeriodEnd(15));

    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "yearly" },
      "upgrade@example.com",
      "Upgrade",
      "http://localhost:3000/checkout/success"
    );
    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;

    const initLog = await prisma.paymentLog.findFirst({
      where: { userId: mocks.USER_ID, stage: "initiation" },
      orderBy: { createdAt: "desc" },
    });
    const payload = (initLog?.rawWebhookPayload ?? {}) as { txRef?: string };
    const txRef = payload.txRef!;

    mocks.verifyTransaction.mockResolvedValue({
      status: "successful",
      amount: 9975,
      currency: "USD",
      txRef,
    });

    const webhook: FlutterwaveWebhookData = {
      id: "pay-upgrade-1",
      tx_ref: txRef,
      status: "successful",
    };
    const result = await fulfilFromWebhook(
      webhook,
      "event-upgrade-1",
      JSON.stringify(webhook)
    );
    expect(result.status).toBe("fulfilled");

    const sub = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(sub?.status).toBe("active");
    expect(sub?.interval).toBe("yearly");

    // The yearly purchase gets its own grant row even though a monthly
    // fulfilment already exists from the original subscription.
    const fulfilments = await prisma.paymentLog.findMany({
      where: { userId: mocks.USER_ID, stage: "fulfilment" },
      orderBy: { createdAt: "asc" },
    });
    expect(fulfilments).toHaveLength(2);
    const yearlyFulfilment = (fulfilments[1]?.rawWebhookPayload ?? {}) as {
      interval?: string;
      eventId?: string;
    };
    expect(yearlyFulfilment.interval).toBe("yearly");
    expect(yearlyFulfilment.eventId).toBe("event-upgrade-1");

    // The full log for this purchase reads initiation → verification →
    // fulfilment with no events dropped. Use the flutterwaveEventId DB
    // column (not rawWebhookPayload) to find rows keyed by provider event id.
    const upgradeLogs = await prisma.paymentLog.findMany({
      where: { flutterwaveEventId: "event-upgrade-1" },
      select: { stage: true },
      orderBy: { createdAt: "asc" },
    });
    // The verification row is keyed by flutterwaveEventId; the fulfilment
    // row stores the id inside rawWebhookPayload.eventId instead, so query
    // both separately.
    const fulfilmentRow = await prisma.paymentLog.findFirst({
      where: {
        userId: mocks.USER_ID,
        stage: "fulfilment",
        rawWebhookPayload: { path: ["eventId"], equals: "event-upgrade-1" },
      },
    });
    expect(upgradeLogs.map((s) => s.stage)).toEqual(["verification"]);
    expect(fulfilmentRow).not.toBeNull();
  });
});