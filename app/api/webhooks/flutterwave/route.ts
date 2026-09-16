import { NextResponse } from "next/server";

import {
  parseWebhookPayload,
  verifyWebhookSignature,
} from "@/lib/payment/flutterwave";
import { fulfilFromWebhook } from "@/lib/subscription/service";

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Rule 3: reject before reading the payload if the signature is invalid.
  // Supports both current (`flutterwave-signature`, HMAC-SHA256) and legacy
  // (`verif-hash`, plain secret) Flutterwave webhook mechanisms.
  const flutterwaveSignature = request.headers.get("flutterwave-signature");
  const verifHash = request.headers.get("verif-hash");
  if (!verifyWebhookSignature(rawBody, flutterwaveSignature, verifHash)) {
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 401 }
    );
  }

  let data;
  try {
    const payload = parseWebhookPayload(rawBody);
    data = payload.data;
  } catch {
    return NextResponse.json(
      { error: "Malformed webhook payload." },
      { status: 400 }
    );
  }

  const result = await fulfilFromWebhook(data, String(data.id), rawBody);
  return NextResponse.json(result);
}