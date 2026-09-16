import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { PaymentError } from "@/lib/payment/flutterwave";
import { cancelSubscription } from "@/lib/subscription/service";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    let reason: string | undefined;
    try {
      const body = (await request.json()) as { reason?: string };
      reason = typeof body.reason === "string" ? body.reason : undefined;
    } catch {
      // Reason is optional; a malformed body still allows cancellation.
    }

    const result = await cancelSubscription(user.id, { reason });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PaymentError && err.code === "NO_ACTIVE_SUBSCRIPTION") {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[cancel]", err);
    return NextResponse.json(
      { error: "Something went wrong cancelling your subscription." },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";