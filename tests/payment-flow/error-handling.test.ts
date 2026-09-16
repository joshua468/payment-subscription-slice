import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FlutterwaveWebhookData } from "@/types/payment";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-error-user",
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

const TX_REF = `ps-${mocks.USER_ID}-monthly-abc123`;

describe("failed and unmatched payments never grant entitlement", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "errors@example.com", name: "Errors" },
    });

    await prisma.subscription.create({
      data: {
        userId: mocks.USER_ID,
        plan: "Pro",
        interval: "monthly",
        currency: "USD",
        amountMinorUnits: 1050,
        status: "payment_pending",
      },
    });
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("records a failure row and leaves the subscription unfulfilled", async () => {
    mocks.verifyTransaction.mockResolvedValue({
      status: "failed",
      amount: 1050,
      currency: "USD",
      txRef: TX_REF,
    });

    const webhook: FlutterwaveWebhookData = {
      id: "pay-fail-1",
      tx_ref: TX_REF,
      status: "failed",
    };
    const result = await fulfilFromWebhook(webhook, "event-fail-1", JSON.stringify(webhook));

    expect(result.status).toBe("failed");

    const failure = await prisma.paymentLog.findFirst({
      where: { userId: mocks.USER_ID, stage: "failure" },
    });
    expect(failure).not.toBeNull();
    expect(failure?.flutterwaveEventId).toBe("event-fail-1");
    expect(failure?.errorReason).toContain("failed");

    const current = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(current?.status).toBe("payment_pending");
    expect(current?.periodEnd).toBeNull();
  });

  it("logs a verification failure and never grants for a redirect-only claim", async () => {
    mocks.verifyTransaction.mockResolvedValue({
      status: "attempt",
      amount: 1050,
      currency: "USD",
      txRef: TX_REF,
    });

    const webhook: FlutterwaveWebhookData = {
      id: "pay-attempt-2",
      tx_ref: TX_REF,
      status: "attempt",
    };
    const result = await fulfilFromWebhook(webhook, "event-attempt-2", JSON.stringify(webhook));

    expect(result.status).toBe("failed");

    const verificationRows = await prisma.paymentLog.count({
      where: { userId: mocks.USER_ID, stage: "verification" },
    });
    expect(verificationRows).toBe(0);

    const current = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(current?.status).toBe("payment_pending");
  });

  it("still links an unparseable tx_ref to its initiation row (bug fix)", async () => {
    const sub = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    if (!sub) throw new Error("missing subscription");

    // This checkout was opened with a tx_ref whose format cannot be parsed
    // back into a user id — the only trace is the initiation log's payload.
    await prisma.paymentLog.create({
      data: {
        subscriptionId: sub.id,
        userId: mocks.USER_ID,
        stage: "initiation",
        rawWebhookPayload: { txRef: "odd-format-ref" },
      },
    });

    mocks.verifyTransaction.mockResolvedValue({
      status: "successful",
      amount: 1050,
      currency: "USD",
      txRef: "odd-format-ref",
    });

    const webhook: FlutterwaveWebhookData = {
      id: "pay-odd-3",
      tx_ref: "odd-format-ref",
      status: "successful",
    };
    const result = await fulfilFromWebhook(webhook, "event-odd-3", JSON.stringify(webhook));

    expect(result.status).toBe("fulfilled");

    const stages = await prisma.paymentLog.findMany({
      where: { userId: mocks.USER_ID },
      select: { stage: true },
      orderBy: { createdAt: "asc" },
    });
    const lastTwo = stages.slice(-2).map((s) => s.stage);
    expect(lastTwo).toEqual(["verification", "fulfilment"]);
  });
});