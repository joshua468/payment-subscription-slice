import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FlutterwaveWebhookData } from "@/types/payment";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-sub-monthly-user",
  REDIRECT_URL: "http://localhost:3000/checkout/success",
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

describe("subscribe monthly happy path", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "monthly@example.com", name: "Monthly" },
    });

    mocks.initiateCheckout.mockImplementation(async (params: { txRef: string }) => ({
      flutterwaveRedirectUrl: "https://checkout.example/flw/xyz",
      flutterwavePaymentId: "12345",
      txRef: params.txRef,
    }));
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("initiates checkout, records initiation, then grants entitlement only after verification", async () => {
    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "monthly" },
      "monthly@example.com",
      "Monthly",
      mocks.REDIRECT_URL
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;
    expect(outcome.result.flutterwaveRedirectUrl).toBe(
      "https://checkout.example/flw/xyz"
    );

    const pending = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(pending?.status).toBe("payment_pending");
    expect(pending?.interval).toBe("monthly");
    expect(pending?.amountMinorUnits).toBe(1050);

    const initiation = await prisma.paymentLog.findFirst({
      where: { userId: mocks.USER_ID, stage: "initiation" },
    });
    expect(initiation).not.toBeNull();
    const payload = (initiation?.rawWebhookPayload ?? {}) as { txRef?: string };
    expect(payload.txRef).toMatch(
      new RegExp(`^ps-${mocks.USER_ID}-monthly-[0-9a-f]{12}$`)
    );

    const txRef = payload.txRef!;
    expect(mocks.initiateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ txRef, amountMajorUnits: "10.50" })
    );

    // The user has NOT been granted entitlement yet — only the webhook can.
    mocks.verifyTransaction.mockResolvedValue({
      status: "successful",
      amount: 1050,
      currency: "USD",
      txRef,
    });

    const webhook: FlutterwaveWebhookData = {
      id: "pay-sub-1",
      tx_ref: txRef,
      status: "successful",
      customer: { id: "cust-sub-1" },
    };
    const result = await fulfilFromWebhook(webhook, "event-sub-1", JSON.stringify(webhook));
    expect(result.status).toBe("fulfilled");

    const active = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(active?.status).toBe("active");
    expect(active?.interval).toBe("monthly");
    expect(active?.periodEnd).not.toBeNull();

    const stages = await prisma.paymentLog.findMany({
      where: { subscriptionId: active!.id },
      select: { stage: true },
      orderBy: { createdAt: "asc" },
    });
    expect(stages.map((s) => s.stage)).toEqual([
      "initiation",
      "verification",
      "fulfilment",
    ]);
  });
});