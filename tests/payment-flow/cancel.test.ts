import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { PaymentError } from "@/lib/payment/flutterwave";
import {
  cancelSubscription,
  getSubscriptionState,
} from "@/lib/subscription/service";

const USER_ID = "test-cancel-user";
const MS_PER_DAY = 86_400_000;

describe("cancellation retains period-end access", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: "cancel@example.com", name: "Cancel" },
    });
  });

  afterAll(async () => {
    await prisma.paymentLog.deleteMany({ where: { userId: USER_ID } });
    await prisma.subscription.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
  });

  it("marks pending_cancellation, keeps periodEnd untouched, and stores the reason", async () => {
    const periodEnd = new Date(Date.now() + 20 * MS_PER_DAY);
    await prisma.subscription.create({
      data: {
        userId: USER_ID,
        plan: "Pro",
        interval: "monthly",
        currency: "USD",
        amountMinorUnits: 1050,
        status: "active",
        periodStart: new Date(Date.now() - 10 * MS_PER_DAY),
        periodEnd,
      },
    });

    const result = await cancelSubscription(USER_ID, { reason: "Too expensive" });

    expect(result.cancelled).toBe(true);
    expect(result.periodEnd?.getTime()).toBe(periodEnd.getTime());

    const current = await prisma.subscription.findUnique({ where: { userId: USER_ID } });
    expect(current?.status).toBe("pending_cancellation");
    expect(current?.periodEnd?.getTime()).toBe(periodEnd.getTime());
    expect(current?.cancellationReason).toBe("Too expensive");
  });

  it("reverts to cancelled only once the paid period has ended", async () => {
    // Simulate time passing: move periodEnd into the past, then read state.
    await prisma.subscription.update({
      where: { userId: USER_ID },
      data: { periodEnd: new Date(Date.now() - 1 * MS_PER_DAY) },
    });

    const { subscription } = await getSubscriptionState(USER_ID);
    expect(subscription?.status).toBe("cancelled");
  });

  it("refuses to cancel without an active subscription", async () => {
    await prisma.subscription.deleteMany({ where: { userId: USER_ID } });
    await expect(cancelSubscription(USER_ID, {})).rejects.toThrow(PaymentError);
  });
});