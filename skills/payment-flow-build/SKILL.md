---
name: payment-flow-build
description: Use when building, fixing, or debugging the full subscription checkout flow: initiation → Flutterwave hosted checkout → redirect → success page polling → webhook → fulfilment. Covers signature verification, idempotency, rate limiting, and the non-entitling success page. Trigger keywords: checkout, subscribe, webhook, fulfilment, success page, flutterwave, signature verify, payment flow.
---

# Payment Flow Build Skill

## The complete flow (initiation → fulfilment)

```
User clicks Choose
  → POST /api/checkout { interval }
      → rate limit check (5/min/user) → 429 if exceeded
      → validate interval ∈ {monthly, yearly}
      → initiateSubscription():
          - 409 if already subscribed to same interval
          - downgrade (yearly→monthly): return {deferred: true}, no charge
          - upgrade: compute proration, charge only the difference
          - fresh: upsert subscription → payment_pending
          - log `initiation` row {txRef, flutterwavePaymentId, amountChargedMinorUnits}
          - call Flutterwave POST /v3/payments → redirect URL
  → client: window.location.href = flutterwaveRedirectUrl

User completes payment on Flutterwave hosted checkout
  → Flutterwave sends POST /api/webhooks/flutterwave (may be delayed/absent)
  → User redirects to /checkout/success?status=successful&tx_ref=...&transaction_id=...

Success page (client component):
  → polls GET /api/subscriptions (applies due transitions) + POST /api/verify
    every 2.5s, up to 90s total
  → renders based on latestStage from the server:
      initiation/pending → "Confirming your payment…"
      fulfilment → "You are all set"
      failure → "Payment not confirmed"
      timeout → support message

Webhook arrives (POST /api/webhooks/flutterwave):
  1. Verify signature FIRST (HMAC-SHA256, raw body, timingSafeEqual)
     - Invalid/missing → 401, no processing
  2. Parse payload → 400 if malformed
  3. Idempotency check on flutterwaveEventId (@unique)
     - Duplicate → {duplicate: true, status: "already_processed"}
  4. Server-side verify: GET /v3/transactions/{id}
     - Transient error → return "unconfirmed", leave event unconsumed
     - Failed/unmatched → append `failure` row, grant nothing
     - Successful → proceed to fulfilment
  5. Fulfil:
     - append `verification` row
     - flip subscription → active (set periodStart, periodEnd, flutterwaveSubId, flutterwaveCustomerId)
     - append `fulfilment` row
```

## Key implementation details

### Signature verification (before parsing)
```ts
// lib/payment/flutterwave.ts — verifyWebhookSignature
expected = HMAC_SHA256(rawBody, secretKey)
valid    = crypto.timingSafeEqual(expected, receivedSignature)
if (!valid) → reject immediately
```
Supports both `flutterwave-signature` (current) and `verif-hash` (legacy) headers.

### Idempotency
- `PaymentLog.flutterwaveEventId @unique` — the provider event/event ID.
- Webhook handler checks for existing row with that ID first. If found → return
  `already_processed`, do nothing.
- The `/api/verify` accelerator also logs with the same idempotency key, so
  both paths (webhook and redirect-poll) safely converge on the same event.

### Rate limiting
- `lib/rate-limit.ts` — in-memory sliding window, keyed by user ID.
- Limit: 5 requests per 60 seconds per user.
- Returns 429 Too Many Requests when exceeded.
- Client button disabled after first submission (double-submit protection).

### Success page (non-entitling)
- Client component reads `searchParams`: `status`, `tx_ref`, `transaction_id`.
- `status !== "successful"` → "No payment made" (money was not taken).
- Polls every 2.5s (max 90s); renders `latestStage` from the server.
- **Never** renders "payment received" — the redirect alone does not confirm payment.
- Subscription updated only after server-side verification (Rule 2).

### Conflict handling
- `409 Conflict` (same interval already subscribed) → "You're already on this plan."
- `409` (downgrade already scheduled) → "A downgrade is already scheduled."

## Error states in the flow

| State               | Page render                            | Action                    |
| ------------------- | -------------------------------------- | ------------------------- |
| Missing/bad params  | "No payment made"                      | Return to billing         |
| Polling timeout     | "Payment not confirmed"                | Support + return          |
| Server-side failure | "Payment not confirmed"                | Retry / Support / Return  |
| Webhook invalid sig | 401 (no UI)                            | —                         |
| Malformed webhook   | 400 (no UI)                            | —                         |
| Rate limit exceeded | 429 "Too many requests"                | Wait and retry            |
| Already subscribed  | 409 "You're already on this plan"      | Return to billing         |

## Test coverage checklist

- [ ] Happy path: subscribe monthly → webhook fulfilment → success page polls to "You are all set".
- [ ] Upgrade: proration charged correctly, yearly period opens.
- [ ] Downgrade: `pending_downgrade` set, no charge, no checkout.
- [ ] Cancel: `pending_cancellation` set, `periodEnd` untouched, access retained.
- [ ] Duplicate webhook: same `flutterwaveEventId` → `already_processed`, one fulfilment.
- [ ] Invalid signature: webhook rejected with 401, no side effects.
- [ ] Malformed payload: 400, no side effects.
- [ ] Transient verify error: `unconfirmed`, event left unconsumed, subscription stays `payment_pending`.
- [ ] Redirect verify accelerator: idempotent, works alongside webhook.
- [ ] Rate limit: 6th request in 60s → 429.
- [ ] Double-click: second checkout for same interval → 409.
- [ ] Success page: non-successful status → "No payment made".
- [ ] Success page: timeout after 90s → support message.