import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  USER_ID: "test-downgrade-user",
  initiateCheckout: vi.fn(),
}));

vi.mock("@/lib/payment/flutterwave", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/payment/flutterwave")
  >();
  return {
    ...actual,
    initiateCheckout: mocks.initiateCheckout,
  };
});

import { prisma } from "@/lib/db";
import { initiateSubscription } from "@/lib/subscription/service";

const MS_PER_DAY = 86_400_000;

describe("downgrade yearly → monthly", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: mocks.USER_ID },
      update: {},
      create: { id: mocks.USER_ID, email: "downgrade@example.com", name: "Downgrade" },
    });

    mocks.initiateCheckout.mockResolvedValue({
      flutterwaveRedirectUrl: "https://checkout.example/flw/x",
      flutterwavePaymentId: "1",
      txRef: "unused",
    });
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: mocks.USER_ID } });
    await prisma.user.deleteMany({ where: { id: mocks.USER_ID } });
  });

  it("defers the downgrade to period end without starting a checkout or charge", async () => {
    const periodEnd = new Date(Date.now() + 100 * MS_PER_DAY);
    await prisma.subscription.create({
      data: {
        userId: mocks.USER_ID,
        plan: "Pro",
        interval: "yearly",
        currency: "USD",
        amountMinorUnits: 10500,
        status: "active",
        periodStart: new Date(Date.now() - 200 * MS_PER_DAY),
        periodEnd,
      },
    });

    const outcome = await initiateSubscription(
      mocks.USER_ID,
      { interval: "monthly" },
      "downgrade@example.com",
      "Downgrade",
      "http://localhost:3000/checkout/success"
    );

    expect(outcome.kind).toBe("deferral");
    expect(mocks.initiateCheckout).not.toHaveBeenCalled();

    const current = await prisma.subscription.findUnique({
      where: { userId: mocks.USER_ID },
    });
    expect(current?.status).toBe("pending_downgrade");
    expect(current?.interval).toBe("yearly");
    expect(current?.amountMinorUnits).toBe(10500);
    expect(current?.periodEnd?.getTime()).toBe(periodEnd.getTime());
  });
});