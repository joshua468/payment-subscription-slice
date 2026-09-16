import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getPlanPricing } from "@/lib/plans";
import {
  PaymentError,
  initiateCheckout,
  isSuccessfulWebhook,
  verifyTransaction,
} from "@/lib/payment/flutterwave";
import { calculateProration, daysBetween, daysInInterval } from "@/lib/proration/calculate";
import type {
  CancelRequest,
  CancelResponse,
  CheckoutRequest,
  CheckoutResponse,
  FlutterwaveWebhookData,
  Interval,
  ProrationBreakdown,
} from "@/types/payment";
import { randomBytes } from "crypto";

const MS_PER_DAY = 86_400_000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function buildTxRef(userId: string, interval: Interval): string {
  return `ps-${userId}-${interval}-${randomBytes(6).toString("hex")}`;
}

// A paid period that is still running has bought days the user would not use
// if they switched now — that is what a proration credit must rest on,
// regardless of interim flags like pending_cancellation or
// pending_downgrade, which only describe what happens *after* the period.
function hasOngoingPaidPeriod(sub: {
  status: string;
  periodEnd: Date | null;
}): boolean {
  return (
    (sub.status === "active" ||
      sub.status === "pending_cancellation" ||
      sub.status === "pending_downgrade") &&
    sub.periodEnd !== null &&
    sub.periodEnd.getTime() > Date.now()
  );
}

export type CheckoutOutcome =
  | { kind: "redirect"; result: CheckoutResponse }
  | { kind: "deferral"; message: string }
  | { kind: "conflict"; message: string };

export async function initiateSubscription(
  userId: string,
  request: CheckoutRequest,
  customerEmail: string,
  customerName: string,
  redirectUrl: string
): Promise<CheckoutOutcome> {
  const { interval } = request;
  const pricing = getPlanPricing(interval);

  const existing = await prisma.subscription.findUnique({ where: { userId } });

  let chargeMinorUnits = pricing.amountMinorUnits;
  let proration: ProrationBreakdown | undefined;

  if (existing && existing.status !== "cancelled") {
    if (
      (existing.status === "active" || existing.status === "pending_cancellation") &&
      existing.interval === interval
    ) {
      return { kind: "conflict", message: `You are already subscribed to ${interval} billing.` };
    }
    if (existing.status === "pending_downgrade" && existing.interval === interval) {
      return { kind: "conflict", message: "Your downgrade is already scheduled." };
    }
    if (existing.status === "payment_pending") {
      // A checkout is already open; a new one simply replaces the intent.
    }
  }

  if (existing && hasOngoingPaidPeriod(existing) && existing.interval === "yearly") {
    if (interval === "monthly") {
      // Downgrades (and a change of mind that keeps monthly instead of
      // lapses) take effect at the end of the paid period — no charge now.
      await prisma.subscription.update({
        where: { userId },
        data: { status: "pending_downgrade" },
      });
      return {
        kind: "deferral",
        message: "Your downgrade to monthly will apply at the end of your current period.",
      };
    }
  }

  if (existing && hasOngoingPaidPeriod(existing) && existing.interval === "monthly") {
    if (interval === "yearly") {
      // Upgrade is charged immediately with a prorated credit for the unused
      // portion of the current monthly period (Rule 7: round only final
      // charge). Applies to active, pending_cancellation, and
      // pending_downgrade users alike: they all still hold paid days.
      const periodEnd = existing.periodEnd ?? new Date();
      const daysRemaining = Math.min(
        daysBetween(new Date(), periodEnd),
        daysInInterval("monthly")
      );
      const calc = calculateProration({
        currentAmountMinorUnits: getPlanPricing("monthly").amountMinorUnits,
        newAmountMinorUnits: pricing.amountMinorUnits,
        currentInterval: "monthly",
        newInterval: "yearly",
        daysRemaining,
      });
      chargeMinorUnits = calc.proratedChargeMinorUnits;
      proration = {
        daysRemaining,
        creditMinorUnits: calc.creditMinorUnits,
        fullPrecisionCredit: calc.fullPrecisionCredit,
        proratedChargeMinorUnits: calc.proratedChargeMinorUnits,
      };
    }
  }

  const txRef = buildTxRef(userId, interval);
  const amountMajorUnits = (chargeMinorUnits / 100).toFixed(2);

  const result = await initiateCheckout({
    txRef,
    amountMajorUnits,
    currency: pricing.currency,
    customerEmail,
    customerName,
    redirectUrl,
    interval,
    userId,
  });

  const subscription = await prisma.subscription.upsert({
    where: { userId },
    update: {
      plan: pricing.plan,
      interval,
      currency: pricing.currency,
      amountMinorUnits: pricing.amountMinorUnits,
      status: "payment_pending",
      periodStart: null,
      periodEnd: null,
      flutterwaveSubId: null,
      flutterwaveCustomerId: null,
      cancellationReason: null,
    },
    create: {
      userId,
      plan: pricing.plan,
      interval,
      currency: pricing.currency,
      amountMinorUnits: pricing.amountMinorUnits,
      status: "payment_pending",
    },
  });

  const initiationPayload: Record<string, unknown> = {
    txRef,
    flutterwavePaymentId: result.flutterwavePaymentId,
    amountChargedMinorUnits: chargeMinorUnits,
    interval,
  };
  if (proration) {
    initiationPayload.proration = proration;
  }

  await prisma.paymentLog.create({
    data: {
      subscriptionId: subscription.id,
      userId,
      stage: "initiation",
      rawWebhookPayload: initiationPayload as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    kind: "redirect",
    result: proration ? { ...result, proration } : result,
  };
}

export async function cancelSubscription(
  userId: string,
  request: CancelRequest
): Promise<CancelResponse> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (!existing || existing.status === "cancelled" || !existing.periodEnd) {
    throw new PaymentError("NO_ACTIVE_SUBSCRIPTION", "You do not have an active subscription.");
  }

  // Cancellation keeps access until the end of the paid period (Rule 6).
  const updated = await prisma.subscription.update({
    where: { userId },
    data: {
      status: "pending_cancellation",
      cancellationReason: request.reason ?? null,
    },
  });

  return { cancelled: true, periodEnd: updated.periodEnd };
}

async function findSubscriptionByTxRef(txRef?: string) {
  if (!txRef) {
    return prisma.subscription.findFirst({
      where: { status: "payment_pending" },
      orderBy: { updatedAt: "desc" },
    });
  }
  // tx_ref format: ps-{userId}-{interval}-{random} — the user id itself may
  // contain hyphens, so derive it from the segments after "ps" and before the
  // last two (interval, random).
  const parts = txRef.split("-");
  const userId = parts.slice(1, -2).join("-");
  const byUserId = await prisma.subscription.findUnique({ where: { userId } });
  if (byUserId) return byUserId;

  // A tx_ref we cannot parse may still have been issued by this system: the
  // checkout stores `txRef` in the initiation log's raw payload. Link the
  // event to that subscription so the failure is recorded, never dropped.
  const initiations = await prisma.paymentLog.findMany({
    where: { stage: "initiation" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  for (const row of initiations) {
    const payload = row.rawWebhookPayload as { txRef?: string } | null;
    if (payload?.txRef === txRef) {
      return prisma.subscription.findUnique({ where: { id: row.subscriptionId } });
    }
  }

  return null;
}

export async function fulfilFromWebhook(
  data: FlutterwaveWebhookData,
  flutterwaveEventId: string,
  rawBody: string
): Promise<{ duplicate: boolean; status: string }> {
  // Idempotency (Rule 4): a verification/failure row keyed on the provider
  // event id exists only once, so a repeated webhook is recorded once and
  // acted on once. The unique constraint on flutterwave_event_id enforces it.
  const existing = await prisma.paymentLog.findUnique({
    where: { flutterwaveEventId },
  });
  if (existing) {
    return { duplicate: true, status: "already_processed" };
  }

  let verifiedText: string;
  let success: boolean;
  let verificationErrored = false;
  try {
    // Server-side verification of the payment with the provider (Rule 2): we
    // never grant entitlement from the redirect or the payload alone.
    const tx = await verifyTransaction(data.id);
    verifiedText = tx.status;
    success = tx.status === "successful" && isSuccessfulWebhook(data);
  } catch (err) {
    // A thrown error here is a transient or config-level failure talking to the
    // provider, NOT a conclusive payment failure. We must not record a failure
    // row for it: that would permanently consume flutterwaveEventId (blocking
    // the real webhook from fulfilling) and falsely flip the redirect success
    // page to "Payment not confirmed" for a payment that actually went through.
    verifiedText = err instanceof Error ? err.message : "verification error";
    success = false;
    verificationErrored = true;
  }

  // Look the subscription up regardless of outcome.
  const subscription = await findSubscriptionByTxRef(data.tx_ref);

  if (verificationErrored) {
    // Verification is genuinely inconclusive. Leave the subscription
    // payment_pending (never grant) and keep the event id free so a later
    // webhook can still fulfil. The success page keeps telling the user we are
    // still confirming their payment rather than showing a false failure.
    return {
      duplicate: false,
      status: subscription ? "unconfirmed" : "failed_no_subscription",
    };
  }

  if (!subscription || !success) {
    // A conclusive non-success (provider reported failed/attempt) still gets its
    // own failure row so every payment event is recorded, and no entitlement is
    // ever granted.
    if (subscription) {
      await prisma.paymentLog.create({
        data: {
          subscriptionId: subscription.id,
          userId: subscription.userId,
          stage: "failure",
          flutterwaveEventId,
          errorReason: `Transaction status: ${verifiedText}`,
          rawWebhookPayload: { rawBody, verifiedText },
        },
      });
    } else {
      console.error("[webhook] no matching subscription for event", flutterwaveEventId);
    }
    return { duplicate: false, status: success ? "failed_no_subscription" : "failed" };
  }

  // Verification is its own append-only payment-log row (stage = verification).
  await prisma.paymentLog.create({
    data: {
      subscriptionId: subscription.id,
      userId: subscription.userId,
      stage: "verification",
      flutterwaveEventId,
      rawWebhookPayload: { rawBody, verifiedText },
    },
  });

  const interval = (subscription.interval ?? "monthly") as Interval;
  const periodStart = new Date();
  const periodEnd = addDays(periodStart, daysInInterval(interval));

  const updated = await prisma.subscription.update({
    where: { userId: subscription.userId },
    data: {
      status: "active",
      periodStart,
      periodEnd,
      flutterwaveSubId: data.sub ?? null,
      flutterwaveCustomerId: data.customer?.id ?? null,
    },
  });

  // The grant is recorded as its own fulfilment row; entitlement now derives
  // from the log, not from any mutable status a frontend could claim.
  // One fulfilment per purchase is already guaranteed by the event-id
  // idempotency check at the top of this function: the webhook and the verify
  // accelerator settle the SAME transaction under the SAME flutterwaveEventId
  // (the transaction id), so the second settle returns already_processed before
  // reaching this point. A per-subscription "already fulfilled" guard would be
  // wrong here — it would silently suppress the grant row for an upgrade or a
  // re-subscription, breaking the append-only payment log.
  await prisma.paymentLog.create({
    data: {
      subscriptionId: updated.id,
      userId: updated.userId,
      stage: "fulfilment",
      rawWebhookPayload: {
        verifiedText,
        amountMinorUnits: updated.amountMinorUnits,
        interval,
        periodEnd: periodEnd.toISOString(),
        eventId: flutterwaveEventId,
      },
    },
  });

  return { duplicate: false, status: "fulfilled" };
}

async function applyDueTransitions(userId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub || !sub.periodEnd) return sub;

  if (sub.status === "pending_downgrade" && sub.periodEnd.getTime() <= Date.now()) {
    // Downgrade takes effect at period end: monthly starts fresh now.
    const monthly = getPlanPricing("monthly");
    return prisma.subscription.update({
      where: { userId },
      data: {
        status: "active",
        interval: "monthly",
        amountMinorUnits: monthly.amountMinorUnits,
        periodStart: sub.periodEnd,
        periodEnd: addDays(sub.periodEnd, daysInInterval("monthly")),
      },
    });
  }

  if (
    (sub.status === "active" || sub.status === "pending_cancellation") &&
    sub.periodEnd.getTime() <= Date.now()
  ) {
    // No auto-renewal in this slice: the paid period ended, so the user reverts
    // to free. Cancellation also lands here (access was retained to period end).
    return prisma.subscription.update({
      where: { userId },
      data: { status: "cancelled" },
    });
  }

  return sub;
}

export interface SubscriptionState {
  subscription: Awaited<ReturnType<typeof applyDueTransitions>>;
  latestStage: string | null;
}

export async function getSubscriptionState(userId: string): Promise<SubscriptionState> {
  const subscription = await applyDueTransitions(userId);

  const latestLog = await prisma.paymentLog.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return {
    subscription,
    latestStage: latestLog?.stage ?? null,
  };
}

export interface PaymentActivity {
  stage: string;
  createdAt: Date;
  errorReason: string | null;
  amountMinorUnits: number | null;
}

// The history half of the billing view: the immutable payment log, newest
// first. Billing shows what the log records; it never deduces it from the
// present subscription row alone.
export async function getPaymentActivity(
  userId: string,
  take = 6
): Promise<PaymentActivity[]> {
  const rows = await prisma.paymentLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });

  return rows.map((row) => {
    const payload = (row.rawWebhookPayload ?? {}) as Record<string, unknown>;
    const amountCandidate =
      payload.amountChargedMinorUnits ?? payload.amountMinorUnits;
    return {
      stage: row.stage,
      createdAt: row.createdAt,
      errorReason: row.errorReason,
      amountMinorUnits:
        typeof amountCandidate === "number" ? amountCandidate : null,
    };
  });
}