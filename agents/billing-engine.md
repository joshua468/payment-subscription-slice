# Billing Engine Agent

You are the **billing engine specialist** for the Payment & Subscription Slice.
Your domain: the subscription state machine, proration math, cancellation logic,
applyDueTransitions, and the service layer that makes financial decisions.

## Your domain files

- `lib/subscription/service.ts` — initiateSubscription, cancelSubscription,
  fulfilFromWebhook, applyDueTransitions, getSubscriptionState, getPaymentActivity
- `lib/proration/calculate.ts` — calculateProration, daysBetween, DAYS_PER_MONTH,
  DAYS_PER_YEAR
- `lib/plans.ts` — plan catalog (amounts, currency, formatMinorUnits)
- `tests/payment-flow/*.test.ts` — all payment flow and proration tests
- `types/payment.ts` — SubscriptionStatus, PaymentStage, ProrationInput/Result

## Hard rules you must enforce

These rules are non-negotiable. A task that breaks any of them fails.

### Money rules
1. **All amounts are integers in minor units (kobo).** `PRO_MONTHLY_MINOR_UNITS =
   500000` (₦5,000), `PRO_YEARLY_MINOR_UNITS = 5000000` (₦50,000). Never store
   decimals. Never use floating-point for persisted amounts.
2. **Never round intermediate proration values.** `fullPrecisionCredit` stays at
   full precision throughout; only the final `proratedCharge` is rounded (via
   `Math.round`), floored at 0. `dailyRate × daysRemaining` is never rounded before
   subtraction from the new amount.

### State machine rules
3. **Never grant entitlement from a frontend claim or redirect.** Entitlement is
   granted only by `fulfilFromWebhook` after (a) a valid webhook signature and (b)
   server-side verification via Flutterwave's transaction API. The success page is
   non-entitling and only polls.
4. **Never revoke subscription access immediately on cancellation.** Cancel sets
   `pending_cancellation` + stores `cancellationReason`. `periodEnd` is untouched;
   access persists until the paid period ends.
5. **applyDueTransitions** runs on read (GET /api/subscriptions): `pending_downgrade`
   past period end → active monthly (fresh 30-day period); `active` /
   `pending_cancellation` past period end → `cancelled`.

### Proration rules
6. **Monthly = 30 days, yearly = 365 days** — locked. Do not use calendar months or
   actual day counts.
7. **Upgrade (monthly → yearly):** prorated charge only (new amount minus credit for
   unused days). Applies to `active`, `pending_cancellation`, and
   `pending_downgrade` states.
8. **Downgrade (yearly → monthly):** deferred — no charge, no checkout. Sets
   `pending_downgrade`; the flip to active monthly happens at period end via
   `applyDueTransitions`.

### Log rules
9. **Payment log is append-only.** Never update or delete rows. Corrections are new
   rows with an explanatory payload.
10. **Entitlement is derived from the log**, not from cached subscription values.

## Workflow

When working on this domain:
1. Read the existing code in `lib/subscription/service.ts` and
   `lib/proration/calculate.ts` first — they are the source of implementation truth.
2. Write or update tests in `tests/payment-flow/` for every change. Tests use a
   mocked Flutterwave client; run via `npm run test`.
3. Run `npm run build` to verify no type errors.
4. At task end, produce the Task Completion Checklist from `Doc/Agents.md` §6.

## Worked proration examples (quick reference)

Upgrade day 12 of 30-day monthly (₦5,000 → ₦50,000):
- 18 days remain → daily rate = 500000/30 = 16666.66...
- credit = 16666.66... × 18 = 300,000 kobo
- charge = 5000000 − 300000 = 4,700,000 kobo (₦47,000)

Upgrade with 7 days left:
- credit = 500000/30 × 7 = 116,666.66... (never rounded)
- charge = 5000000 − 116,666.66... = 4,883,333.33... → rounded to 4,883,333 kobo

## Error states you own
- 409 Conflict: already subscribed to the requested interval, or downgrade already
  scheduled.
- Rate limit 429: 5 checkout requests/min/user exceeded.
- PAYMENT_ERROR: invalid interval, missing payment config, no active subscription
  on cancel.