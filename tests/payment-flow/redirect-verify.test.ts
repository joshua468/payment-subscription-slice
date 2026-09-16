import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-redirect-verify-user",
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
import { fulfilFromWebhook, initiateSubscription } from "@/lib/subscription/service";

// When the sandbox webhook never reaches the app (localhost), the redirect back
// to /checkout/success?status=successful&tx_ref=...&transaction_id=... alone has
// to trigger server-side verification (POST /api/verify builds exactly the
// synthetic payload below). It must fulfil the pending subscription, idempotently.
describe("redirect verification fallback", () => {
  let txRef = "";

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "verify@example.com", name: "Verify" },
    });

    mocks.initiateCheckout.mockImplementation(async (params: { txRef: string }) => ({
      flutterwaveRedirectUrl: "https://checkout.example/flw/xyz",
      flutterwavePaymentId: "100001",
      txRef: params.txRef,
    }));
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("fulfils the pending subscription from the redirect transaction id without a webhook", async () => {
    await initiateSubscription(
      mocks.USER_ID,
      { interval: "monthly" },
      "verify@example.com",
      "Verify",
      "http://localhost:3000/checkout/success"
    );

    const pending = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(pending?.status).toBe("payment_pending");

    const initiation = await prisma.paymentLog.findFirst({
      where: { userId: mocks.USER_ID, stage: "initiation" },
    });
    txRef = ((initiation?.rawWebhookPayload ?? {}) as { txRef?: string }).txRef ?? "";

    const transactionId = "400001";
    mocks.verifyTransaction.mockResolvedValue({
      status: "successful",
      amount: 1050,
      currency: "USD",
      txRef,
    });

    const result = await fulfilFromWebhook(
      { id: transactionId, tx_ref: txRef, status: "successful" },
      transactionId,
      JSON.stringify({ id: transactionId, tx_ref: txRef, status: "successful" })
    );
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

  it("treats the later webhook for the same transaction as already processed", async () => {
    // The real webhook arrives after the redirect already fulfilled it. It is
    // keyed on the same transaction id, so idempotency must short-circuit it.
    const duplicate = await fulfilFromWebhook(
      { id: "400001", tx_ref: txRef, status: "successful", customer: { id: "c1" } },
      "400001",
      JSON.stringify({ event: "charge.completed" })
    );
    expect(duplicate.status).toBe("already_processed");

    const verificationRows = await prisma.paymentLog.count({
      where: { userId: mocks.USER_ID, stage: "verification" },
    });
    expect(verificationRows).toBe(1);
  });
});