# AGENTS.md: Payment & Subscription Slice

## Question 1: What is this project?

**Project name:** Payment & Subscription Slice  
**What it does:** A production-grade subscription billing system that allows users to subscribe to a single plan in monthly or yearly intervals, upgrade/downgrade mid-cycle with prorated pricing, cancel with period-end access retention, and tracks all payment events in an immutable log.

**Who it's for:** Signed-in users of a SaaS application who can manage their subscription lifecycle.

**What version are we building now:** Complete MVP slice covering subscribe, upgrade, downgrade, cancel, and webhook handling with full payment logging.

**Which document is the source of truth:** The Payment & Subscription Slice PRD (attached). If the PRD and this file conflict, the PRD wins.

---

## Question 2: What is locked?

Do not change, swap, improve, or negotiate any of the following:

1. **Payment Provider**: You are integrating with Flutterwave in test mode. Never swap to Stripe, PayPal, or any other provider without explicit approval. Flutterwave's API, webhook format, signature verification method, and customer ID structure are fixed.

2. **Authentication**: Reuse the authentication system built in Assessment 1. Do not rebuild authentication. Do not create a new sign-up flow. Users are already signed-in.

3. **Plan Structure**: Exactly one paid plan (Pro), sold in two intervals only: monthly and yearly. The plans view shows Free (default state), Pro monthly, and Pro yearly. Do not create multiple tiers, add features, or create a free tier within this slice. (Free is the default state; it is not a plan to sell.)

4. **Test Mode**: This system runs in Flutterwave test mode only. Never accept production keys, never route to production endpoints, and never process real payments. Environment variables must enforce test vs. prod at startup.

5. **Database**: Prisma ORM with PostgreSQL. Do not use raw SQL, migrations written manually, or any other database pattern. All schema changes go through Prisma migrations.

6. **Framework & Language**: Next.js with TypeScript. Do not use alternative frameworks or languages.

7. **Interval Definition**: Monthly = 30 days, Yearly = 365 days. These are fixed for proration math. Do not use calendar months or actual day counts.

---

## Question 3: What must never happen?

Breaking any rule on this list means the task failed, even if the code compiles and runs.

### Money & Financial Rules

**1. Never store money as decimals or floating-point numbers.**  
Store every amount in the smallest unit (cents) as a whole integer. Example: $10.50 = 1050 cents, stored as `1050` (INTEGER in database). Decimals accumulate rounding errors and cause charge discrepancies. [PRD: Data & Money Handling]

**2. Never grant entitlement based on a frontend claim or redirect alone.**  
A user visiting the success URL directly, or a JavaScript call claiming "subscription active," must not grant a subscription. Entitlement is granted only after the server verifies payment through the payment log. Specifically:  
- Success page is non-entitling; it polls the backend until the payment log shows `fulfilment` status.  
- Subscription record is updated only after payment log verification is complete.  
[PRD: Payment Logging & Verification]

**3. Never process a webhook without verifying its signature.**  
Before reading any webhook payload, verify the signature using Flutterwave's public key. A webhook with an invalid or missing signature is rejected immediately; no processing occurs. [PRD: Webhook Handling]

**4. Never charge a user twice for the same payment intent.**  
Idempotency is keyed on the provider reference (Flutterwave event ID). If the same webhook arrives twice (network retry), it is logged only once in the payment log and acts on the subscription only once. Use a unique constraint on `(subscription_id, provider_event_id)` to prevent duplicates. [PRD: Idempotency]

**5. Never store card data, card tokens, or payment method details anywhere in this system.**  
Only store the provider's subscription ID and customer ID. If you need to charge the card again (retry failed payment), call Flutterwave's API with the subscription ID; they charge the card on file. This keeps the system out of PCI scope. [PRD: PCI Compliance]

**6. Never revoke subscription access immediately upon cancellation.**  
When a user cancels, they keep access until the end of the period they paid for. A yearly subscriber who cancels on day 50 keeps access until day 365, then reverts to free. The cancellation takes effect at period end, not now. [PRD: Cancellation & Period-End Access]

**7. Never calculate proration using rounded intermediate values.**  
Proration is calculated with full floating-point precision at each step. Round only the final charge amount (to the nearest cent) before submitting to Flutterwave. Example: days remaining / days in period × plan cost = credit. Keep full precision; round the final charge only. [PRD: Proration Calculation]

**8. Never leave a user on a blank page or 404 during the payment flow.**  
Every step in subscribe → checkout → success → billing must have a valid page or state display. If an error occurs (failed charge, webhook timeout, server error), display a clear error message and an action (Retry, Contact Support, Return to Billing). No dead ends. [PRD: Error Handling]

**9. Never allow unlimited checkout initiations.**  
Rate limit the checkout endpoint to 5 requests per minute per authenticated user. Return 429 Too Many Requests if exceeded. The frontend form is disabled after the first submission to prevent accidental double-clicks. [PRD: Rate Limiting]

### Data & Access Rules

**10. Never mix test and production payment credentials in the same deployment.**  
Environment variables must enforce a single mode: `PAYMENT_MODE=test` or `PAYMENT_MODE=prod`. Startup validation checks that all payment credentials match the mode. Mismatched credentials cause startup failure. [PRD: Test Mode]

**11. Never delete or mutate a payment log entry.**  
The payment log is append-only. Once an entry is created, it is never updated or deleted. This log is the source of truth for disputes and audits. If you need to record a correction, add a new entry explaining the correction. [PRD: Payment Log]

**12. Never derive subscription state from anything other than the payment log.**  
The subscription record shows the present state. But to understand what happened, you read the payment log. Entitlement status, billing dates, and proration credits are derived from the payment log, not from cached values in the subscription record. [PRD: Payment Log & Entitlement]

### Scope Rules

**13. Never build a landing page, pricing marketing page, or product features behind the paywall.**  
This slice sells only a plan flag. There is no marketing website, no "why you should upgrade" page, and no gated features. The only UI is the signed-in billing view. [PRD: Out of Scope]

**14. Never implement feature gating inside this slice.**  
The subscription system records the plan. The application layer (outside this slice) decides which features are allowed. If a user has the "Pro" plan, the feature gates check that plan in a separate service. This slice does not gate anything. [PRD: Out of Scope]

---

## Question 4: How is the work arranged?

**Folder structure for the Payment & Subscription Slice:**

```
/app
  /api
    /subscriptions
      route.ts                 # GET /api/subscriptions - fetch current subscription
      POST                     # (in route.ts) create subscription via webhook
    /checkout
      route.ts                 # POST /api/checkout - initiate checkout with Flutterwave
    /webhooks
      /flutterwave
        route.ts               # POST /api/webhooks/flutterwave - receive Flutterwave webhooks
    /cancel
      route.ts                 # POST /api/cancel - initiate cancellation
  /billing
    page.tsx                   # /billing - main billing hub (plans view + dashboard)
  /checkout
    /success
      page.tsx                 # /checkout/success - post-payment landing page

/lib
  /payment
    flutterwave.ts             # Flutterwave API client (charge, create subscription, verify signature)
  /db
    schema.prisma              # Database schema (in /prisma folder - see below)
  /proration
    calculate.ts               # Proration math (days remaining, credits, prorated charges)

/prisma
  schema.prisma                # Prisma schema (subscriptions, payment_log, users tables)
  migrations/
    [auto-generated]           # Prisma migrations

/tests
  /payment-flow
    subscribe.test.ts          # Happy path: subscribe monthly
    upgrade.test.ts            # Upgrade to yearly, verify proration
    downgrade.test.ts          # Downgrade to monthly, verify credit
    cancel.test.ts             # Cancel, verify period-end access
    duplicate-webhook.test.ts  # Webhook arrives twice, second is ignored
    error-handling.test.ts     # Failed charge, network errors, malformed webhooks

/types
  payment.ts                   # TypeScript types for payment, subscription, webhook payloads
```

**Database schema (Prisma):**

```prisma
model Subscription {
  id                      String    @id @default(cuid())
  userId                  String    @unique
  plan                    String    // "Pro"; only one plan in this slice
  interval                String    // "monthly" or "yearly"
  currency                String    // "USD", "NGN", etc.
  amountMinorUnits        Int       // e.g., 1050 for $10.50 (stored as cents)
  periodStart             DateTime
  periodEnd               DateTime
  status                  String    // "active", "pending_downgrade", "pending_cancellation", "payment_pending", "cancelled"
  flutterwaveSubId        String?   // Flutterwave subscription ID
  flutterwaveCustomerId   String?   // Flutterwave customer ID
  cancellationReason      String?   // Optional reason captured at cancellation
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @updatedAt

  paymentLog              PaymentLog[]
  user                    User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([status])
  @@unique([userId, status]) // Only one active/pending subscription per user
}

model PaymentLog {
  id                      String    @id @default(cuid())
  subscriptionId          String
  userId                  String
  stage                   String    // "initiation", "verification", "fulfilment", "failure"
  flutterwaveEventId      String?   @unique // Flutterwave event ID for idempotency
  timestamp               DateTime  @default(now())
  rawWebhookPayload       Json?     // Raw webhook data for auditing
  errorReason             String?   // If stage = "failure", the error
  createdAt               DateTime  @default(now())

  subscription            Subscription @relation(fields: [subscriptionId], references: [id])

  @@index([subscriptionId])
  @@index([userId])
  @@index([flutterwaveEventId])
}

model User {
  id                      String    @id
  // ... other user fields from Assessment 1 auth
  subscription            Subscription?
}
```

**Separation of concerns:**

- **API layer** (`/api/*`): Receives requests, validates input, calls business logic. Never touches payment logic directly.
- **Business logic** (`/lib/payment/*`): Manages Flutterwave API calls, signature verification, proration. Stateless, testable.
- **Database layer**: Prisma ORM handles all reads/writes. No raw SQL.
- **Webhooks** (`/api/webhooks/*`): Receives webhooks, verifies signature, logs the event, then delegates to business logic to update subscription. Webhook handling is separate from subscription state changes.

---

## Question 5: How should the code look?

**Style & Quality Standards:**

1. **TypeScript**: Strict mode enabled. All types are explicit; use `any` only in comments explaining why.

2. **Formatting**: Use Prettier with 2-space indentation, 80-character line length for readability.

3. **Naming Conventions:**
   - Functions: camelCase (`calculateProration`, `verifyWebhookSignature`)
   - Constants: UPPER_SNAKE_CASE (`MAX_RETRIES`, `PRORATION_DAYS_IN_YEAR`)
   - Classes/Interfaces: PascalCase (`PaymentClient`, `SubscriptionRequest`)
   - Database fields: snake_case in Prisma schema, camelCase in TypeScript interfaces

4. **Error Handling:**
   - All promises have `.catch()` or try/catch. No unhandled rejections.
   - Errors are typed: `class PaymentError extends Error { code: string }` rather than generic strings.
   - User-facing errors are sanitized; server logs contain full details.

5. **Comments:**
   - Comments explain the "why," not the "what." Code is self-documenting.
   - Complex logic (proration math, webhook verification) has a 2-3 line explanation above it.
   - Magic numbers are named constants: `const DAYS_PER_YEAR = 365`.

6. **Testing:**
   - Every payment flow is tested: happy path, error cases, edge cases (duplicate webhook, network timeout, invalid signature).
   - Tests use real database (sqlite in test mode) or mocked Flutterwave client.
   - Test names are descriptive: `test("should reject webhook with invalid signature")` not `test("webhook")`.

7. **Performance:**
   - Database queries are indexed on `userId` and `flutterwaveEventId` for fast lookups.
   - Webhook processing is idempotent and fast (< 1s).
   - Proration calculation uses only math, no database loops.

8. **LTS & Maintainability:**
   - Use stable, well-supported libraries: Next.js LTS, Prisma, TypeScript 5.x.
   - Avoid beta features or experimental APIs.
   - Code is modular: proration logic is separate from API logic, which is separate from Flutterwave client.

---

## Question 6: What counts as done?

At the end of each task, the agent must provide a checklist confirming all requirements are met. The code must build with no errors (`npm run build` succeeds).

### Checklist template (agent fills this out at the end):

```
## Task Completion Checklist

### Functional Requirements
- [ ] Subscriptions can be created (subscribe to monthly or yearly)
- [ ] Subscriptions can be upgraded mid-cycle with correct proration
- [ ] Subscriptions can be downgraded mid-cycle with correct proration
- [ ] Subscriptions can be cancelled with period-end access retention
- [ ] Billing view shows current plan, renewal date, and cancellation button
- [ ] Payment success page displays post-payment, polls for verification, shows confirmation
- [ ] Error handling prevents blank pages or 404s in payment flow

### Technical Requirements
- [ ] Money stored in minor units (integers) throughout
- [ ] Payment log is append-only and records all stages (initiation, verification, fulfilment, failure)
- [ ] Webhook signature verified before processing
- [ ] Idempotency prevents duplicate billing on webhook retry
- [ ] Proration calculated with full precision, rounded only at final charge
- [ ] No card data stored anywhere in the system
- [ ] Cancellation retains period-end access
- [ ] Rate limiting enforced on checkout endpoint (5 req/min per user)
- [ ] All database migrations are in /prisma/migrations/
- [ ] All TypeScript types are explicit; no `any` without justification

### Testing & Evidence
- [ ] Database screenshot: subscription record before/after upgrade showing interval and period_end changed
- [ ] Database screenshot: payment log showing complete transaction (initiation → verification → fulfilment)
- [ ] Proration calculation written out with real numbers (days remaining, daily rate, credit, final charge)
- [ ] Evidence of duplicate webhook: two log entries with same flutterwaveEventId, second ignored
- [ ] Database screenshot: cancelled subscription showing status and future period_end date
- [ ] All tests pass (`npm run test`)
- [ ] Build succeeds with no errors (`npm run build`)

### Code Quality
- [ ] All TypeScript types are explicit
- [ ] All async functions have error handling
- [ ] Comments explain the "why," not the "what"
- [ ] Folder structure matches the agreed layout
- [ ] No raw SQL; all database access via Prisma
- [ ] Proration, signature verification, and idempotency logic are in separate, testable modules
```

---

## Question 7: What does the agent do when unsure?

**Rule: Never invent scope. Never add features. Never introduce spaghetti code.**

If you are unsure about how to implement something:

1. **Check the PRD first.** Re-read the relevant section. The PRD is the source of truth.

2. **Check this AGENTS.md file.** Rules 1–14 cover the major constraints. Your decision is likely there.

3. **If still unsure, ask the human.** Do not guess. Do not add a feature you think might be useful. Do not refactor other parts of the codebase to fit your interpretation.

4. **Specific unclear areas in this project:**
   - **Proration formula**: If you are unsure whether proration applies to downgrades (it does), re-read PRD Question 3 of the Live Review.
   - **Webhook delay**: If the webhook is delayed and the user lands on success before entitlement is verified, the success page must poll. Do not grant entitlement early.
   - **Cancellation state machine**: If a user cancels and then wants to re-subscribe, they must move through the full subscription flow again. There is no "reactivate" shortcut.
   - **Feature gating**: This slice does not gate features. If you are tempted to check the plan before showing a button, stop. The application layer handles that.

5. **If a bug surfaces during implementation**: Pause. Report it with context (which test failed, what did you expect, what happened). Do not patch over it with a new rule you invent.

6. **When you complete a task**: Provide the checklist above. If any item is incomplete or blocked, say why. Do not mark it done if it is not.

---

## Self-Audit: Did this file catch the edge cases?

**Check 1: Is there a rule for every "never" in the PRD?**
- ✅ "Never on frontend claim" → Rule 2
- ✅ "Never store cards" → Rule 5
- ✅ "Never blank pages/404s" → Rule 8
- ✅ "Never decimals for money" → Rule 1
- ✅ All covered.

**Check 2: Did I invent new rules not in the PRD?**
- ✅ Rules 1–14 trace back to the PRD or the live review corrections.
- ✅ Folder structure is reasonable but not mandated by PRD; agent can adjust with justification.
- ✅ No invented scope.

**Check 3: Would breaking any rule make the feature fail even if code runs?**
- ✅ Rule 1 (decimals): Feature runs but charges are wrong. Fail.
- ✅ Rule 2 (entitlement): Feature runs but anyone can get free subscription. Fail.
- ✅ Rule 3 (webhook signature): Feature runs but accepts fake webhooks. Fail.
- ✅ All rules pass this test.

**Check 4: Is the folder structure realistic for a Next.js app?**
- ✅ Standard Next.js layout.
- ✅ Prisma migrations are in the right place.
- ✅ Tests co-located by feature.

**Check 5: Are locked choices actually locked?**
- ✅ Flutterwave is locked.
- ✅ Auth from Assessment 1 is locked.
- ✅ One plan, two intervals is locked.
- ✅ Test mode only is locked.
- ✅ Prisma + PostgreSQL is locked.

**Conclusion**: This file is ready. It answers all seven questions, covers all PRD rules, avoids invention, and provides clear guidance to the agent.

---

**End of AGENTS.md**