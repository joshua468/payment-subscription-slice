# Payment & Subscription Slice — Product Requirements Document

**Version:** 1.0  
**Status:** Approved — MVP  
**Owner:** Product + Engineering  
**Companion docs:** [`Doc/Agents.md`](./Agents.md) (operating rules), [`Doc/Section5.md`](./Section5.md) (architecture & money concepts)

This PRD is the **source of truth** for the Payment & Subscription Slice. If any other
file (including `Doc/Agents.md`) conflicts with this document, this document wins.

---

## 1. Product Overview

### 1.1 What we are building

A **production-grade subscription billing slice** for an existing signed-in SaaS
application. It lets a user manage exactly one paid plan across its full lifecycle —
subscribe, upgrade, downgrade, cancel — with fair, auditable proration, and records
every payment event in an **immutable append-only log** that serves as the dispute
source of truth.

This is a vertical slice: the *billing system only*. Authentication, the product
itself, and feature gating live outside this slice.

### 1.2 Product principles

1. **The log is the truth.** Entitlement is granted only from a server-verified,
   logged payment event — never from a redirect, a query string, or a client claim.
2. **Money is exact.** Every amount is stored as an integer in minor units (kobo).
   Rounding happens exactly once, at the final charge.
3. **Fair by contract.** Cancel = access until the end of the paid period. Upgrade and
   downgrade are priced by exact proration. The customer is never over-charged and the
   business never pays a refund it doesn't owe.
4. **Auditable end to end.** Initiation → verification → fulfilment (or failure) is
   recorded as separate, un-mutable log rows.
5. **No dead ends.** Every step of the payment flow renders a meaningful state.

### 1.3 Who it's for

Signed-in users of the host SaaS application. They reach the billing slice from
in-app navigation (Billing / Plans).

### 1.4 Target UX outcomes

- A user understands **what they have now** (plan, interval, price, renewal date) at a glance.
- Upgrading shows **exactly what it will cost** (prorated credit + charge) before paying.
- Downgrading is a **zero-friction "scheduled" action** with no charge today.
- Cancelling is **explicit and reversible-in-mind**: the user knows access stays until a specific date.
- Payment success is **honest**: the UI never claims a payment succeeded until the server log proves it.

---

## 2. Scope

### 2.1 In scope (MVP)

- Billing hub page (`/billing`) showing current subscription state and payment activity.
- Plans page (`/plans`) showing Free, Pro Monthly, Pro Yearly.
- Checkout initiation through **Flutterwave hosted checkout** (test mode only).
- Checkout success page (`/checkout/success`) that polls for server-side fulfilment.
- Webhook receipt + signature verification + server-side transaction verification.
- Upgrade (monthly → yearly) with **prorated** charge.
- Downgrade (yearly → monthly) **deferred to period end**, no charge.
- Cancel with **period-end access retention** and optional reason capture.
- Append-only payment log (`initiation → verification → fulfilment | failure`).
- In-memory rate limiting on checkout (5 req/min/user).
- Tests covering all payment flows and the proration math.

### 2.2 Out of scope (explicitly not built here)

- Authentication / sign-up (reused from the host app).
- Marketing landing page, "why upgrade" copy, or pricing marketing pages.
- Feature gating based on plan.
- Auto-renewal / recurring billing (periods lapse to Free at period end).
- Admin panels, invoices, email notifications, refunds.
- Multi-plan catalogs or multi-currency beyond NGN.
- Production payment credentials (test mode only by mandate).
- Storing card data, tokens, or payment method details (out of PCI scope by design).

---

## 3. Pricing (locked)

Exactly **one paid plan** (Pro), two intervals. Free is the default state, never sold.

| Item            | Minor units (kobo) | Displayed  | Interval length |
| --------------- | ------------------ | ---------- | --------------- |
| Free            | 0                  | ₦0.00      | —               |
| Pro · monthly   | 500000             | ₦5,000.00  | 30 days         |
| Pro · yearly    | 5000000            | ₦50,000.00 | 365 days        |

Interval lengths **monthly = 30 days, yearly = 365 days** are fixed for proration
math. Do not use calendar months.

Derived values (single source: `lib/plans.ts`):

- `PLAN = "Pro"`
- `PLAN_CURRENCY = "NGN"` — minor unit **kobo** (100 kobo = ₦1)
- `PRO_MONTHLY_MINOR_UNITS = 500000`
- `PRO_YEARLY_MINOR_UNITS = 5000000`

---

## 4. Functional Requirements

### FR-1 — Billing hub (`/billing`)

**As a signed-in user, I want to see my current subscription at a glance.**

1. Shows current plan or "Free" when no active subscription.
2. Shows a **status badge** keyed to subscription state:

   | Status               | Badge label                              |
   | -------------------- | ---------------------------------------- |
   | `active`             | Active                                   |
   | `payment_pending`    | Payment pending                          |
   | `pending_downgrade`  | Downgrade scheduled                      |
   | `pending_cancellation` | Cancelling at period end               |
   | `cancelled`          | Cancelled                                |

3. Shows billing interval + formatted price (e.g., "₦5,000.00 / month").
4. Shows **renewal date** (period end) when the subscription has one.
5. Shows the **cancellation reason** if captured and cancellation is pending.
6. Renders a "Cancel subscription" action for active/cancellable states.
7. Renders a "Change plan" link to `/plans`.
8. Shows **Payment activity**: up to 6 rows from the payment log, each with stage
   label, amount, timestamp, and error reason (where present).

**Design guidance:** plan card → status badge + interval + price → renewal line →
action row → payment activity list. See §6 UX Requirements.

### FR-2 — Plans page (`/plans`)

**As a user, I want to compare and change plans.**

1. Three cards: **Free** (default state), **Pro Monthly**, **Pro Yearly**.
2. "Current plan" badge on the user's current selection.
3. For an **upgrade opportunity** (active monthly), show a **pre-computed proration
   estimate** directly on the card: "X days left · credit ₦Y · upgrade charge ₦Z".
4. Interactions per card:
   - **Current plan** → disabled `SelectedPlanButton`.
   - **Upgrade** → `ChoosePlanButton` (opens checkout).
   - **Downgrade** (active yearly → monthly) → `DowngradeButton` (applies at period end).
5. Card copy is neutral — no marketing hype (out of scope).

### FR-3 — Subscribe / choose plan

**As a user, I want to buy Pro.**

1. User clicks Choose (monthly or yearly) → `POST /api/checkout { interval }`.
2. Server validates `interval ∈ {monthly, yearly}`, enforces rate limit (5/min), and
   creates a `tx_ref` (`ps-{userId}-{interval}-{random}`).
3. Server creates a `payment_pending` subscription (or reuses pending state),
   calls Flutterwave to create a checkout session, and **logs an `initiation` row**
   (store `txRef`, `flutterwavePaymentId`, `amountChargedMinorUnits`, interval).
4. Client redirects to Flutterwave hosted checkout URL.
5. If the user already subscribes to the requested interval → **409 Conflict**,
   "You're already on this plan." No second charge is created.
6. The client button is disabled after first click (double-submit protection).

Success path continues on **FR-7 (success page)**.

### FR-4 — Upgrade (monthly → yearly) with proration

**As a monthly Pro user, I want to upgrade to yearly and pay only the difference.**

1. Compute proration via **FR-8 proration math**:
   `credit = (currentAmount / daysInPeriod) × daysRemaining` at full precision;
   `proratedCharge = newAmount − credit`; **round once** at the end (`.min` 0).
2. Server initiates a checkout for the **prorated charge only**, not the full annual price.
3. Upgrade applies to users in `active`, `pending_cancellation`, and `pending_downgrade`
   states (all hold paid days; upgrade supersedes the pending flag).
4. On webhook fulfilment, new period opens (365 days) at yearly rate; the old monthly
   period's remaining value becomes the credit already applied.
5. The user must see the estimate (FR-2.3) before paying.

### FR-5 — Downgrade (yearly → monthly) deferred

**As a yearly Pro user, I want to downgrade to monthly without losing paid days.**

1. NO charge, NO checkout. The server sets status → `pending_downgrade`.
2. At period end, `applyDueTransitions` flips the user to a fresh active monthly
   period (30 days, ₦5,000) — no money moves, no new charge is created.
3. The billing hub shows "Downgrade scheduled" with the effective date.

### FR-6 — Cancel with period-end access

**As a user, I want to cancel but keep access until my paid period ends.**

1. Two-step confirmation: prompt, **cancel reason** (optional, `maxLength 200`),
   confirm (`POST /api/cancel`), and an escape hatch ("Keep subscription").
2. Server sets status → `pending_cancellation`, records `cancellationReason`,
   **leaves `periodEnd` untouched**; access persists until period end.
3. The billing hub shows "Cancelling at period end" + the exact end date.
4. At period end, `applyDueTransitions` sets status → `cancelled` (reverts to Free).
5. **No immediate revocation, ever.** (Rule 6.)
6. Re-subscribing after cancel goes through the full subscribe flow; there is no
   "reactivate" shortcut.

### FR-7 — Checkout success page (`/checkout/success`)

**As a user, I want a clear, honest post-payment landing.**

1. Reads `status`, `tx_ref`, `transaction_id` from the URL.
2. Distinguish states:
   - `status !== "successful"` → **"No payment made"** — money was not taken.
   - otherwise → **poll**: every 2.5 s up to 90 s, call `GET /api/subscriptions`
     (which applies due transitions) and `POST /api/verify` (idempotent accelerator)
     until the payment log shows `fulfilment`.
3. Mapped outcomes (server-log driven, never client-claimed):
   - `fulfilment` → **"You are all set"** card: plan, interval, renewal date, amount paid.
   - `failure` → **"Payment not confirmed"** + Retry / Support / Back to billing.
   - timeout → **support message** + return to billing link.
4. While polling → **"Confirming your payment…"** spinner. There is deliberately **no
   "payment received" state**: the redirect alone never confirms payment.
5. This page is **non-entitling** (Rule 2). It only reflects server state.

### FR-8 — Proration math

Handled by `lib/proration/calculate.ts`. Rules (Rule 7):

- `monthly = 30 days`, `yearly = 365 days` (locked).
- `dailyRate = currentAmount / daysInPeriod` (full precision).
- `credit = dailyRate × daysRemaining` — **never rounded** (`fullPrecisionCredit`).
- `proratedCharge = newAmount − credit`, **rounded once** at the end with
  `Math.round`, floored at 0.
- Validate `daysRemaining ∈ [0, daysInPeriod]` (throw `RangeError` otherwise).
- `daysBetween(from, to)` uses **whole days** (floor).

**Worked example — upgrade day 12 of monthly ₦5,000 → yearly ₦50,000:**
18 days remain → daily rate `500000/30 = 16,666.66...` → credit
`16,666.66... × 18 = 300,000` kobo (₦3,000) → charge `4,700,000` kobo (₦47,000).

**Worked example — upgrade with 7 days left:** credit `= 500000/30 × 7 =
116,666.66...` kobo; charge `= 4,883,333.33...` → rounded to **4,883,333** kobo.
The credit is never rounded before subtraction.

### FR-9 — Webhook handling

`POST /api/webhooks/flutterwave`:

1. Verify signature **before parsing** (Rule 3): HMAC‑SHA256 of the raw body against
   the webhook secret (constant-time `timingSafeEqual`), supporting the current
   `flutterwave-signature` header and legacy `verif-hash`. Invalid → **401**.
2. Parse payload (malformed → 400).
3. **Idempotency check** on `flutterwaveEventId` (`@unique`) (Rule 4). Duplicate →
   `already_processed`, no side effects.
4. **Server-side verify** the transaction with Flutterwave (`GET /v3/transactions/{id}`)
   — never trust the payload alone.
5. On successful + verified: append `verification` row → flip subscription to
   `active` (set period start/end, store `flutterwaveSubId` / `flutterwaveCustomerId`)
   → append `fulfilment` row.
6. On failure/unmatched: append a `failure` row with `errorReason`; grant nothing.
7. On transient verify error: return `unconfirmed`, do **not** consume the event id,
   leave the subscription `payment_pending` (retry-safe).

### FR-10 — Payment log (append-only)

`PaymentLog` records `stage` ∈ `initiation | verification | fulfilment | failure`.
Per Row Rule 11: **append-only, never updated or deleted.** Corrections are new rows.
`rawWebhookPayload` (Json) holds provider payload + internal data (amount charged,
txRef, proration breakdown) for audit. Idempotency keyed on `flutterwaveEventId`
(`@unique`).

Entitlement, billing dates, and proration credits are **derived from the log**, not
from cached subscription values (Rule 12).

### FR-11 — Rate limiting

Checkout endpoint limited to **5 requests/min/user** → **429 Too Many Requests** when
exceeded (Rule 9). Client button disabled after first submission. In-memory
sliding-window (`lib/rate-limit.ts`); note: single-instance only — revisit with Redis
if scaled.

### FR-12 — Due transitions

On read (`GET /api/subscriptions`) the server applies `applyDueTransitions`:

- `pending_downgrade` whose `periodEnd` passed → flip to **active monthly** (fresh 30-day period).
- `active` / `pending_cancellation` whose `periodEnd` passed → **cancelled** (reverts to Free).

---

## 5. Non-Negotiable Rules (Never Rules)

Sourced from the PRD's original requirements; consolidated for every engineer and
agent. A task that breaks any of these **fails**, even if code compiles and runs.

### Money & Financial
1. **Never store money as decimals/floats.** Integer minor units only (kobo). Catalog
   in `lib/plans.ts`; `amountMinorUnits Int` on `Subscription`.
2. **Never grant entitlement from frontend claims/redirects.** Success page is
   non-entitling; it polls until the log shows `fulfilment`. Subscription updated only
   after log-based server verification.
3. **Never process a webhook without verifying its signature first.**
4. **Never charge twice for the same payment intent.** Idempotency keyed on
   `flutterwaveEventId` (`@unique`).
5. **Never store card data/tokens/payment-method details.** Only provider
   subscription/customer IDs. (Out of PCI scope.)
6. **Never revoke access immediately on cancellation.** Access to paid period end.
7. **Never round intermediate proration values.** Round only the final charge.

### Data & Access
8. **Never leave a blank page / 404 in the payment flow.** Every state has a render +
   an action (Retry, Support, Return to Billing).
9. **Never allow unlimited checkout initiations.** 5 req/min/user → 429.
10. **Never mix test and prod credentials.** `PAYMENT_MODE` enforced at startup; mode
    mismatch = startup failure.
11. **Never delete or mutate a payment log entry.** Append-only; corrections are new rows.
12. **Never derive state from anything other than the payment log.**

### Scope
13. **Never build marketing pages, a landing page, or paywalled features.**
14. **Never implement feature gating inside this slice.** The app layer gates.

---

## 6. UX / UI Requirements

### 6.1 Design language

- **Palette:** Zinc family (`zinc-50` … `zinc-900`). Dark backgrounds `zinc-900`,
  content on white/`zinc-50` in light mode; dark mode via `prefers-color-scheme`.
- **Type:** Geist Sans (body) + Geist Mono (data/money, codes) via `next/font`.
- **Surfaces:** `rounded-lg border border-zinc-200 bg-white` cards.
- **Actions:** `rounded-full` pills — primary `bg-zinc-900 text-white`, secondary
  bordered, destructive red.
- **Status badges:** `rounded-full bg-zinc-100 px-3 py-1 text-xs`.
- **Layout:** centered max-width container (`max-w-2xl`/`max-w-4xl`), sticky header,
  back-chevron links, dashed-border empty states.
- **Formatting:** money via `Intl.NumberFormat` (`formatMinorUnits` in `lib/plans.ts`).

### 6.2 UX copy principles

- **Honest verbs.** Never claim "%s received" or "%s active" from a redirect. Use
  "Confirming your payment…", then "You are all set".
- **Forward-looking dates.** "Access until {date}", "Free at {date}", "Renews {date}".
- **Money visible before charge.** Proration estimate shown before upgrade checkout.
- **Every error has an action.** Retry / Support / Return to Billing.

### 6.3 States & empty states

| View            | State                    | Rendered content                                      |
| --------------- | ------------------------ | ----------------------------------------------------- |
| Billing         | No subscription          | "Free" + dashed empty state + CTA to `/plans`        |
| Billing         | Active                   | Plan, interval, price, renewal date, Cancel action   |
| Billing         | Payment pending          | "Payment pending" badge; action to re-verify? (none) |
| Billing         | Pending cancel/downgrade | Badge + effective date + (reason for cancel)         |
| Billing         | Cancelled                | "Cancelled" + renewed CTA to `/plans`                |
| Plans           | Current plan card        | Disabled selected button + badge                     |
| Plans           | Upgrade opportunity      | Proration estimate + Choose button                    |
| Plans           | Downgrade opportunity    | "Downgrade scheduled" button (no charge today)       |
| Checkout success | Non-successful          | "No payment made"                                     |
| Checkout success | Polling                 | "Confirming your payment…" spinner                    |
| Checkout success | Fulfilled               | "You are all set" + plan/interval/renewal/amount      |
| Checkout success | Failed / timeout        | "Payment not confirmed" + Retry/Support/Return        |

### 6.4 Accessibility
- Keyboard-reachable buttons; visible focus states.
- Confirmation dialog for cancel with explicit Cancel/Confirm.
- Sufficient contrast in dark & light modes.
- Status not communicated by color alone (always label text).
- Spinners carry `aria-label`/role=status.

---

## 7. Technical Architecture

### 7.1 Stack (locked)

| Layer          | Choice                        |
| -------------- | ----------------------------- |
| Framework      | Next.js (App Router) + TS     |
| DB / ORM       | PostgreSQL + Prisma           |
| Payments       | Flutterwave v3 (test only)    |
| Styling        | Tailwind CSS v4               |
| Tests          | Vitest (node env)             |

### 7.2 Folder layout

```
app/api/{checkout,cancel,verify,subscriptions,webhooks/flutterwave}/route.ts
app/billing/page.tsx   app/plans/page.tsx   app/checkout/success/page.tsx
components/{nav-links,choose-plan-button,cancel-button,downgrade-button}.tsx
lib/{auth,db,plans,rate-limit}.ts
lib/payment/flutterwave.ts
lib/proration/calculate.ts
lib/subscription/service.ts
prisma/schema.prisma   prisma/migrations/
tests/payment-flow/*.test.ts
types/payment.ts
```

### 7.3 Separation of concerns

- **API layer** — receive/validate input, call business logic. Never raw payment logic.
- **Business logic** (`lib/subscription`, `lib/payment`, `lib/proration`) — stateless,
  testable services.
- **DB** — Prisma ORM only; no raw SQL.
- **Webhooks** — verify signature, log, then delegate to service.

### 7.4 Data model

`User` (1:1) → `Subscription` (1:N) → `PaymentLog`, `Subscription.userId @unique`,
`PaymentLog.flutterwaveEventId @unique`, cascading deletes, indexes on `userId`,
`status`, `subscriptionId`, `flutterwaveEventId`. All amounts `Int` minor units.

---

## 8. API Contracts

| Route                       | Method | Purpose                                  | Notes                          |
| --------------------------- | ------ | ---------------------------------------- | ------------------------------ |
| `/api/checkout`             | POST   | Initiate checkout                        | 429 rate-limit; 409 conflict; `{flutterwaveRedirectUrl}` or `{deferred:true}` |
| `/api/cancel`               | POST   | Cancel subscription                      | body `{reason?}`; 404 `NO_ACTIVE_SUBSCRIPTION` |
| `/api/verify`               | POST   | Redirect-verify accelerator              | idempotent; always 200; never grants on error |
| `/api/subscriptions`        | GET    | Current subscription + latest stage      | applies due transitions first |
| `/api/webhooks/flutterwave` | POST   | Webhook receiver                         | signature-first; 401/400; duplicate→`already_processed` |

Errors are typed (`PaymentError extends Error { code }`); user-facing messages are
sanitized, server logs retain detail.

---

## 9. Success Criteria / Definition of Done

1. All 14 Never Rules hold (checklist in `Doc/Agents.md` §6).
2. Payment log shows complete lifecycle `initiation → verification → fulfilment`
   (or `failure`) for real test transactions.
3. Proration examples in FR-8 reproduce exactly.
4. Duplicate webhook evidence: one event id, one fulfilment.
5. `npm run test` passes; `npm run build` succeeds.
6. No dead-end page in any flow; success page is non-entitling.

---

## 10. Metrics (MVP)

- **Flow completion:** % of checkout initiations reaching `fulfilment`.
- **Proration correctness:** no charge > expected; credit + charge = annual price.
- **Dispute-defensibility:** every fulfilled transaction traceable to 3 log rows.
- **UX:** 0 dead-end sessions; error states always offer an action.

---

## 11. Risks & Known Limitations

- **In-memory rate limit** is single-instance; multi-instance deploys need Redis.
- **No auto-renewal** in this slice — long-term product would bill at period end.
- **Hardcoded dev user** in `lib/auth.ts` — swap for real session from the host app
  before production.
- **Flutterwave test mode only** — prod wiring requires prod credentials + re-validation.
- Prisma version lag (6.x) with a major (8.x) available — upgrade is a breaking
  change, tracked separately.

---

## 12. Future Roadmap (out of MVP)

- Auto-renewal / recurring billing at period end.
- Admin: refunds, invoices, email receipts.
- Redis-backed rate limiting.
- Real auth integration.
- Multi-plan catalog / multi-currency.
- Independent billing UI audit against §6.

---

*End of PRD. Questions → start with §4 functional requirements, then check the 14
Never Rules in §5, then `Doc/Agents.md`.*