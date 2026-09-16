import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getPaymentConfig, PaymentError } from "@/lib/payment/flutterwave";
import { isRateLimited } from "@/lib/rate-limit";
import { initiateSubscription } from "@/lib/subscription/service";
import type { Interval } from "@/types/payment";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    if (isRateLimited(`checkout:${user.id}`, 5, 60_000)) {
      return NextResponse.json(
        { error: "Too many checkout attempts. Please try again in a minute." },
        { status: 429 }
      );
    }

    let interval: Interval;
    try {
      const body = (await request.json()) as { interval?: string };
      if (body.interval !== "monthly" && body.interval !== "yearly") {
        return NextResponse.json(
          { error: "interval must be 'monthly' or 'yearly'." },
          { status: 400 }
        );
      }
      interval = body.interval;
    } catch {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 }
      );
    }

    // Validates that PAYMENT_MODE matches the configured credentials (Rule 10).
    getPaymentConfig();
    const origin = request.headers.get("origin") ?? "http://localhost:3000";
    const redirectUrl = `${origin}/checkout/success`;

    const outcome = await initiateSubscription(
      user.id,
      { interval },
      user.email ?? "dev@example.com",
      user.name ?? "Dev User",
      redirectUrl
    );

    if (outcome.kind === "deferral") {
      return NextResponse.json({
        deferred: true,
        message: outcome.message,
      });
    }

    if (outcome.kind === "conflict") {
      return NextResponse.json({ error: outcome.message }, { status: 409 });
    }

    return NextResponse.json(outcome.result);
  } catch (err) {
    const code = err instanceof PaymentError ? err.code : "INTERNAL_ERROR";
    const message =
      err instanceof PaymentError
        ? err.message
        : "Something went wrong starting checkout.";
    console.error("[checkout]", code, message, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";