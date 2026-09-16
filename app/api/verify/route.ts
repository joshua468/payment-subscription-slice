import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  fulfilFromWebhook,
  getSubscriptionState,
} from "@/lib/subscription/service";
import { verifyTransaction } from "@/lib/payment/flutterwave";
import type {
  FlutterwaveWebhookData,
} from "@/types/payment";

// Redirect-based verification fallback. Flutterwave's hosted checkout sends the
// user back to the success page with status, tx_ref and transaction_id appended.
// Webhooks may be delayed or (in sandbox against localhost) never arrive, so we
// verify the transaction server-side and, if it was successful and the
// subscription is still awaiting confirmation, record the fulfilment here.
// Idempotent: fulfilment is keyed on the same transaction id a webhook would
// use, so a later webhook is treated as already_processed.
export async function POST(request: NextRequest) {
  let body: { txRef?: string; transactionId?: string | number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { txRef, transactionId } = body;
  if (!txRef || transactionId == null) {
    return NextResponse.json(
      { error: "txRef and transactionId are required." },
      { status: 400 }
    );
  }

  try {
    const user = await getCurrentUser();

    // Only act on the current user's pending checkout — never re-activate a
    // subscription that has already resolved (e.g. a stale redirect reload).
    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
    });

    if (subscription?.status === "payment_pending") {
      const verified = await verifyTransaction?.(String(transactionId))
        .catch(() => null)

      const synthetic: FlutterwaveWebhookData = {
        id: String(transactionId),
        tx_ref: txRef,
        status: "successful",
        customer: verified?.customerId
          ? { id: String(verified.customerId) }
          : undefined,
        sub: verified?.sub ?? undefined,
      };
      await fulfilFromWebhook(
        synthetic,
        String(transactionId),
        JSON.stringify(synthetic)
      );
    }

    return NextResponse.json(await getSubscriptionState(user.id));
  } catch {
    return NextResponse.json(
      { subscription: null, latestStage: null },
      { status: 200 }
    );
  }
}

export const dynamic = "force-dynamic";