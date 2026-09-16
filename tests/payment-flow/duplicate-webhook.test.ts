import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FlutterwaveWebhookData } from "@/types/payment";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-dup-user",
  EVENT_ID: "dup-event-0001",
  verifyTransaction: vi.fn(),
}));

vi.mock("@/lib/payment/flutterwave", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payment/flutterwave")
  >();
  return {
    ...actual,
    verifyTransaction: mocks.verifyTransaction,
  };
});

import { prisma } from "@/lib/db";
import { fulfilFromWebhook } from "@/lib/subscription/service";

describe("duplicate webhook idempotency", () => {
  let subscriptionId: string;

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "dup@example.com", name: "Dup" },
    });

    const sub = await prisma.subscription.upsert({
      where: { userId: mocks.USER_ID },
      update: {},
      create: {
        userId: mocks.USER_ID,
        plan: "Pro",
        interval: "yearly",
        currency: "USD",
        amountMinorUnits: 10500,
        status: "payment_pending",
      },
    });
    subscriptionId = sub.id;

    await prisma.paymentLog.create({
      data: {
        subscriptionId,
        userId: mocks.USER_ID,
        stage: "initiation",
        rawWebhookPayload: {
          txRef: `ps-${mocks.USER_ID}-yearly-abc123`,
          amountChargedMinorUnits: 10500,
          interval: "yearly",
        },
      },
    });

    mocks.verifyTransaction.mockResolvedValue({
      status: "successful",
      amount: 10500,
      currency: "USD",
      txRef: `ps-${mocks.USER_ID}-yearly-abc123`,
    });
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("fulfils the first webhook and records verification separately", async () => {
    const data: FlutterwaveWebhookData = {
      id: "pay-100",
      tx_ref: `ps-${mocks.USER_ID}-yearly-abc123`,
      status: "successful",
      customer: { id: "cust-1" },
    };

    const result = await fulfilFromWebhook(data, mocks.EVENT_ID, "{}");
    expect(result.status).toBe("fulfilled");

    const subscription = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(subscription?.status).toBe("active");
    expect(subscription?.periodEnd).not.toBeNull();

    const stages = await prisma.paymentLog.findMany({
      where: { subscriptionId },
      select: { stage: true, flutterwaveEventId: true },
      orderBy: { createdAt: "asc" },
    });

    // initiation -> verification -> fulfilment, verification keyed on event id
    expect(stages.map((s) => s.stage)).toEqual([
      "initiation",
      "verification",
      "fulfilment",
    ]);
    const verification = stages.find((s) => s.stage === "verification");
    expect(verification?.flutterwaveEventId).toBe(mocks.EVENT_ID);
  });

  it("ignores the same webhook a second time without re-fulfilling", async () => {
    const data: FlutterwaveWebhookData = {
      id: "pay-100",
      tx_ref: `ps-${mocks.USER_ID}-yearly-abc123`,
      status: "successful",
    };

    const result = await fulfilFromWebhook(data, mocks.EVENT_ID, "{}");
    expect(result).toEqual({ duplicate: true, status: "already_processed" });

    // Recorded once: still exactly one verification row for this event.
    const verificationCount = await prisma.paymentLog.count({
      where: { flutterwaveEventId: mocks.EVENT_ID },
    });
    expect(verificationCount).toBe(1);
  });
});