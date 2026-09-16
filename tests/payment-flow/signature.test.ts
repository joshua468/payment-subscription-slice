import { createHmac } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyWebhookSignature } from "@/lib/payment/flutterwave";

const SECRET = "FLWSECK_TEST-abcdef123456";
const WEBHOOK_SECRET = "whsec-some-random-hash-123456";

beforeAll(() => {
  process.env.PAYMENT_MODE = "test";
  process.env.FLUTTERWAVE_SECRET_KEY = SECRET;
  process.env.FLUTTERWAVE_PUBLIC_KEY = "FLWPUBK_TEST-1234";
  process.env.FLUTTERWAVE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe("verifyWebhookSignature", () => {
  const rawBody = JSON.stringify({ event: "charge.completed", data: { id: "1" } });

  it("accepts a current-format HMAC-SHA256 signature (base64 in flutterwave-signature)", () => {
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("base64");
    expect(verifyWebhookSignature(rawBody, signature, null)).toBe(true);
  });

  it("rejects an HMAC signed with a different secret", () => {
    const signature = createHmac("sha256", "wrong-secret")
      .update(rawBody)
      .digest("base64");
    expect(verifyWebhookSignature(rawBody, signature, null)).toBe(false);
  });

  it("accepts a legacy verif-hash header containing the webhook secret", () => {
    expect(verifyWebhookSignature(rawBody, null, WEBHOOK_SECRET)).toBe(true);
  });

  it("rejects a mismatched legacy verif-hash header", () => {
    expect(verifyWebhookSignature(rawBody, null, "not-the-secret")).toBe(false);
  });

  it("rejects a webhook with no signature header", () => {
    expect(verifyWebhookSignature(rawBody, null, null)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(verifyWebhookSignature(rawBody, "short", null)).toBe(false);
  });
});