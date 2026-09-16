# Section 5: Payment & Subscription Slice — Architecture & Money Concepts

This document explains the design decisions behind the subscription slice. It is
written to be read alongside `Doc/Agents.md` (project rules) and the code in
`lib/`, `app/api/`, and `prisma/schema.prisma`.

Prices used throughout this document:

| Item             | Minor units (cents) | Displayed |
| ---------------- | ------------------- | --------- |
| Pro · monthly    | 1050                | $10.50    |
| Pro · yearly     | 10500               | $105.00   |

---

## 1. Minor units: money is never stored as a decimal

Every amount is stored as a whole number in its smallest unit — cents — with
the currency stored alongside it. There is no `price: 10.50` field anywhere in
the schema; there is `amountMinorUnits: Integer` and `currency: String`.

**Why.** Floating-point decimals cannot represent most money values exactly.
`0.1 + 0.2 !== 0.3`. Once you multiply a float by a transaction volume, round it
to two places, and persist it, you have introduced rounding errors that make
ledgers disagree with the provider and with the customer’s card statement. In a
system that is the source of truth for a dispute, one wrong cent is the
difference between "the ledger matches" and "the ledger is untrustworthy".
Integers in minor units are exact for every calculation that ends in a round
amount, and rounding happens exactly once — at the final charge.

**Where it lives.** `amountMinorUnits Int` on `Subscription`, the full-price
catalog in `lib/plans.ts`, and `amountChargedMinorUnits` inside the payment log.

---

## 2. The payment lifecycle: initiation, verification, fulfilment

A payment is never a single event. It is three separate things, deliberately
recorded as three separate log rows:

1. **Initiation** — the user asked to pay and the provider returned a checkout
   link. Recorded in `POST /api/checkout`. It proves *intent* but nothing else:
   the user may close the tab.
2. **Verification** — the server independently asked the provider
   (`GET /v3/transactions/{id}`) whether the payment actually succeeded, and
   got `status: successful`. This happens **after a signed webhook arrives** and
   is idempotent. It proves the money moved.
3. **Fulfilment** — the subscription record is updated (status → `active`,
   `periodStart`/`periodEnd` set), and a final log row records the grant.

**Why they are separate things.** Each step can fail independently: a checkout
can be abandoned (initiation, no verification); a webhook can be delayed or
repeated (verification occurs, fulfilment must not); a charge can be declined
(failure). Keeping them as separate append-only rows means the sequence is
auditable end to end rather than collapsed into a single mutable status field.
The subscription record shows the *present*; the log shows the *history* — and
the history is what you produce in a dispute.

---

## 3. The payment log and what it proves in a dispute

`PaymentLog` is **append-only**: once created, an entry is never updated or
deleted. New facts are recorded as new rows. Its columns:

- `stage` — `initiation`, `verification`, `fulfilment`, or `failure`
- `flutterwaveEventId` — unique, nullable; the provider reference (idempotency key)
- `rawWebhookPayload` — the raw provider payload and verification result
- `errorReason` — set on failures
- `timestamp` / `createdAt` — immutable event time

**What it proves.** A customer disputes a charge from three months ago. The
cancelled-agreement defence requires evidence of: (1) the user being asked to
pay and how much (initiation row + stored `amountChargedMinorUnits`), (2) the
money actually being taken and confirmed with the provider (verification row +
verification status), and (3) what the customer received for it (fulfilment row
+ period dates). Because the log is append-only and keyed to the provider event,
no one can retroactively rewrite it to claim a payment never happened or was
larger than it was.

Entitlement is **derived from** the log: the success page polls the server and
the server reads the log; nothing is granted from a URL redirect or a client
claim (rule 2 of `Agents.md`).

---

## 4. Idempotency in payments

The same payment event is delivered more than once in practice — providers
retry webhooks on network timeouts, and humans double-click. Both must be safe.

Idempotency is keyed on the **provider reference** (`flutterwave_event_id`,
Flutterwave’s payment/event id), enforced by a `@unique` constraint. The webhook
handler first checks whether the event id already exists in the log. If it does,
it returns `already_processed` and does nothing: the event is recorded once and
acted on once. A second webhook for the same payment cannot create a second
fulfilment, cannot charge the user twice (this system never initiates a charge
from a webhook anyway), and cannot extend a period twice.

**Double-pay defence.** If the same user tries to buy yearly twice in one
minute, the checkout endpoint returns `409 Conflict` — a subscription for that
interval is already active and the money is **rejected**, not absorbed. There is
no silent "we took a second $105 and did nothing."

---

## 5. Webhook signature verification

Flutterwave signs webhooks by computing `HMAC-SHA256(payloadBody, secretKey)`
and sending the digest in the `verif-hash` header. Before the payload is parsed
or any state is touched, the handler recomputes that digest from the **raw
body** using a constant-time compare (`crypto.timingSafeEqual`):

```
expected = HMAC_SHA256(rawBody, secretKey)
valid    = timingSafeEqual(expected, verif-hash)
if (!valid) return 401
```

Signature verification happens before parsing so that a malformed or forged
payload can never reach business logic. An attacker who cannot mint the HMAC
cannot inject a "successful payment" event. (Rule 3 of `Agents.md`.)

---

## 6. Proration — the actual calculation

Interval lengths are locked for proration math: **monthly = 30 days, yearly =
365 days** (Rule 7). Proration runs at full floating-point precision at every
step; **the final charge amount is the only value that is rounded** (to the
nearest cent). Rounding an intermediate credit would corrupt every downstream
charge.

**Worked example — upgrade on day 12 of a 30-day monthly cycle.**

- Current plan: Pro monthly, 1050 cents. New plan: Pro yearly, 10500 cents.
- Last renewal was 12 days ago, so the user has already purchased 12 days of the
  month that they will not use.
- Days remaining in the current period: `30 − 12 = 18`.
- Daily rate for the current plan: `1050 / 30 = 35.0` cents/day.
- Credit for unused days: `35.0 × 18 = 630` cents ($6.30).
- Prorated charge: `10500 − 630 = 9870` cents ($98.70), already a whole number so
  no rounding is needed.

Ledger result (each an append-only `PaymentLog` row plus the initiation row):

| Stage       | Amount recorded      | Where |
| ----------- | -------------------- | ----- |
| initiation  | charge 9870          | raw payload |
| verification| provider: successful | raw payload |
| fulfilment  | period end = now + 365 days | row + subscription |

If instead the upgrade happens with only 7 days left of a 30-day monthly at
$10.00 (1000): credit `= 1000/30 × 7 = 233.333333...` cents; charge `= 10000 −
233.333333 = 9766.666666` cents; **rounded to 9767** cents ($97.67). The credit
is never rounded before subtraction.

Downgrade (yearly → monthly) is the mirror case and is deliberately **not**
charged: the brief requires the change to apply at the **end** of the current
period. The subscription is marked `pending_downgrade`; when `periodEnd` passes,
the service flips it to monthly at the monthly rate. No money moves, so no
charge is created.

---

## 7. Cancellation and period-end access

The user paid for a period — monthly (30 days) or yearly (365 days). On
cancellation, they keep access **until that period ends**, then revert to Free.
This is not generosity; it is contract law. A period the user paid for is
property they bought. Cutting access early would be taking payment for a service
not delivered — the exact claim that loses subscription disputes. Allowing
access to the paid period end also means pro-rata refunds are never owed,
because access is never withdrawn mid-period.

Cancellation is two-step: the UI asks for confirmation and shows the exact
period-end date, with an **optional reason** prompt (`cancellation_reason`
column on `Subscription`) populated from it. The record is set to
`pending_cancellation`; `periodEnd` is untouched; the billing view shows the
retained date. Access is derived from `status` + `periodEnd`, so a cancelled
user cannot read the success URL to get entitlement.

---

## 8. Why we do not store cards — PCI scope

No card number, card token, CVV, or expiration date exists anywhere in this
system (Rule 5). The only provider identifiers kept are Flutterwave’s
subscription/customer ids. Any system that stores, transmits, or processes card
data enters PCI DSS scope — with the quarterly scans, network segmentation, and
certification liability that follow. By never touching card data, this system
stays out of PCI scope entirely; the provider’s hosted checkout collects the
card and the provider holds the card-on-file. If a stored-charge retry is ever
needed, it is done by the provider, not by this codebase.

---

## 9. Rate limiting on payment endpoints

The checkout endpoint is the one endpoint that can create a real (test) charge
against a provider. It is limited to **5 requests per minute per signed-in
user** (`lib/rate-limit.ts`, a sliding-window counter keyed by user id) and
returns `429 Too Many Requests` when exceeded. The client button is disabled
after the first submission, so accidental double-clicks never fire a second
request. Combined with idempotency and the 409-on-duplicate-plan rejection,
this closes the "spam the button → many pending charges" path.

---

## 10. Defence questions — quick answers

- **Exact line where entitlement is granted.** `app/` never grants anything. In
  `lib/subscription/service.ts`, `fulfilFromWebhook` sets `status: "active"`
  after (a) a valid webhook signature and (b) an independent provider
  verification of `successful`. Reaching that code path in a browser is
  impossible — it only runs server-side on a signed webhook; the success page
  only *polls* and reflects the log.
- **A dispute from three months ago.** Show the `PaymentLog` rows for that
  transaction: initiation (amount charged), verification (confirmed with
  provider), fulfilment (what they got and until when). All append-only,
  keyed by provider event id.
- **Upgrade on day 12.** 18 days remain → credit `1050/30 × 18 = 630` cents →
  charge `10500 − 630 = 9870` cents. Full precision, single rounding at the end.
- **Yearly paid twice in a minute.** Checkout rejects the second purchase with
  `409 Conflict` (`initiateSubscription`); the log shows one initiation, one
  verification, one fulfilment, and no duplicate charge.

---

*Prices, interval lengths, and provider integration are configurable in
`lib/plans.ts` and `.env`; the money-handling rules themselves are not.
`PAYMENT_MODE=test` is enforced on every checkout (Rule 10 of `Agents.md`).*