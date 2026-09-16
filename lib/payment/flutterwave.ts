import {
  createHmac,
  timingSafeEqual,
} from "crypto";

import type {
  CheckoutResponse,
  FlutterwaveWebhookData,
  FlutterwaveWebhookPayload,
  Interval,
  PaymentMode,
} from "@/types/payment";

export const FLUTTERWAVE_BASE_URL = "https://api.flutterwave.com/v3";

export class PaymentError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
  }
}

export interface PaymentConfig {
  mode: PaymentMode;
  secretKey: string;
  publicKey: string;
  redirectUrl: string;
}

export function getPaymentConfig(): PaymentConfig {
  const mode = process.env.PAYMENT_MODE;

  if (mode !== "test" && mode !== "prod") {
    throw new PaymentError(
      "INVALID_PAYMENT_MODE",
      "PAYMENT_MODE must be set to 'test' or 'prod'."
    );
  }

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
  const publicKey = process.env.FLUTTERWAVE_PUBLIC_KEY ?? "";
  const redirectUrl =
    process.env.FLUTTERWAVE_REDIRECT_URL ??
    "http://localhost:3000/checkout/success";

  if (mode === "test") {
    if (!secretKey.startsWith("FLWSECK_TEST-")) {
      throw new PaymentError(
        "CREDENTIAL_MODE_MISMATCH",
        "Test mode requires a Flutterwave test secret key."
      );
    }
    if (!publicKey.startsWith("FLWPUBK_TEST-")) {
      throw new PaymentError(
        "CREDENTIAL_MODE_MISMATCH",
        "Test mode requires a Flutterwave test public key."
      );
    }
  }

  if (mode === "prod") {
    if (
      secretKey.startsWith("FLWSECK_TEST-") ||
      publicKey.startsWith("FLWPUBK_TEST-")
    ) {
      throw new PaymentError(
        "CREDENTIAL_MODE_MISMATCH",
        "Production mode must not use test credentials."
      );
    }
  }

  if (!secretKey || !publicKey) {
    throw new PaymentError(
      "MISSING_CREDENTIALS",
      "Flutterwave credentials are not configured."
    );
  }

  return { mode, secretKey, publicKey, redirectUrl };
}

export function verifyWebhookSignature(
  rawBody: string,
  flutterwaveSignature: string | null,
  verifHash: string | null
): boolean {
  const config = getPaymentConfig();
  const webhookSecret = process.env.FLUTTERWAVE_WEBHOOK_SECRET || config.secretKey;

  // Flutterwave current mechanism: HMAC-SHA256(rawBody, secretHash) → base64,
  // sent in the `flutterwave-signature` header.
  if (flutterwaveSignature) {
    const expected = createHmac("sha256", webhookSecret)
      .update(rawBody, "utf8")
      .digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(flutterwaveSignature);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }

  // Flutterwave legacy mechanism: the `verif-hash` header contains the secret
  // hash itself, compared directly (constant-time).
  if (verifHash) {
    const a = Buffer.from(webhookSecret);
    const b = Buffer.from(verifHash);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}

export interface InitiateParams {
  txRef: string;
  amountMajorUnits: string;
  currency: string;
  customerEmail: string;
  customerName: string;
  redirectUrl: string;
  interval: Interval;
  userId: string;
}

export async function initiateCheckout(
  params: InitiateParams
): Promise<CheckoutResponse> {
  const config = getPaymentConfig();

  const res = await fetch(`${FLUTTERWAVE_BASE_URL}/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tx_ref: params.txRef,
      amount: params.amountMajorUnits,
      currency: params.currency,
      redirect_url: params.redirectUrl,
      customer: {
        email: params.customerEmail,
        name: params.customerName,
      },
      meta: {
        userId: params.userId,
        interval: params.interval,
      },
    }),
  });

  const body = (await res.json().catch(() => null)) as {
    data?: { link?: string; id?: number | string };
    message?: string;
  } | null;

  if (!res.ok || !body?.data?.link) {
    throw new PaymentError(
      "CHECKOUT_FAILED",
      `Flutterwave checkout failed: ${body?.message ?? res.statusText}`
    );
  }

  return {
    flutterwaveRedirectUrl: body.data.link,
    flutterwavePaymentId: String(body.data.id ?? ""),
    txRef: params.txRef,
  };
}

export async function verifyTransaction(transactionId: string): Promise<{
  status: string;
  amount: number;
  currency: string;
  txRef?: string;
  customerId?: string | null;
  sub?: string | number | null;
}> {
  const config = getPaymentConfig();

  const res = await fetch(
    `${FLUTTERWAVE_BASE_URL}/transactions/${transactionId}/verify`,
    {
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const body = (await res.json().catch(() => null)) as {
    data?: {
      status?: string;
      amount?: number;
      currency?: string;
      tx_ref?: string;
      customer?: { id?: string | number };
      sub?: string;
    };
    message?: string;
  } | null;

  if (!res.ok || !body?.data) {
    throw new PaymentError(
      "VERIFICATION_FAILED",
      `Flutterwave verification failed: ${body?.message ?? res.statusText}`
    );
  }

  return {
    status: body.data.status ?? "unknown",
    amount: body.data.amount ?? 0,
    currency: body.data.currency ?? "",
    txRef: body.data.tx_ref,
    customerId: body.data.customer?.id ?? null,
    sub: body.data.sub != null ? String(body.data.sub) : null,
  };
}

export function parseWebhookPayload(rawBody: string): FlutterwaveWebhookPayload {
  const parsed = JSON.parse(rawBody) as FlutterwaveWebhookPayload;
  if (!parsed || typeof parsed.event !== "string" || !parsed.data) {
    throw new PaymentError("MALFORMED_WEBHOOK", "Webhook payload is malformed.");
  }
  return parsed;
}

export function isSuccessfulWebhook(data: FlutterwaveWebhookData): boolean {
  return data.status === "successful";
}