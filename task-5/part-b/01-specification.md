# Part B — Discount code redemption

**Feature:** a signed-in user can apply a discount code at checkout, reducing the
charge before the payment is initiated.

**Status:** specified and implemented. See §9 for authorship.

---

## 1. Requirements

### 1.1 Concepts

| Concept | Meaning |
|---|---|
| **Discount code** | A code with a percentage-off value, validity window, optional minimum spend, and a cap on total redemptions. |
| **Redemption** | One user's use of one code against one payment intent. Immutable once written. |
| **Payment intent** | The checkout attempt, identified by an `orderReference` (the `tx_ref`). |

### 1.2 Functional requirements

| ID | Requirement |
|---|---|
| B-1 | A user may apply at most one code per payment intent. |
| B-2 | A code may be redeemed **once per customer**, ever. A second attempt by the same user against any payment intent is rejected. |
| B-3 | A code has a global redemption cap. Once `maxRedemptions` redemptions exist, the code is exhausted and rejected for everyone. |
| B-4 | A code is valid only within `[startsAt, expiresAt]`. Outside that window it is rejected. Either bound may be null (unbounded). |
| B-5 | If `minSpendMinorUnits` is set, the charge must be **greater than or equal** to it. Equality passes — a minimum is a floor, not an exclusion. |
| B-6 | The discount is a **percentage in basis points** (10000 bps = 100%). Not a float, not a percentage string. |
| B-7 | The discount is capped at the charge. A 50% code on a ₦1 charge yields a ₦1 discount, and a final charge of 0. |
| B-8 | The final charge is an integer number of kobo, floored at 0, with **exactly one rounding** — on the discount, not on the intermediate product. |
| B-9 | Redemption is **idempotent on `orderReference`**. Re-applying the same code to the same payment intent returns the original redemption unchanged and creates nothing new. |
| B-10 | A rejected application creates **no** redemption record. Only successful redemptions are persisted. |
| B-11 | Every rejection returns a typed error code, never a thrown string, and never a partially-written record. |

### 1.3 Non-functional constraints inherited from the PRD

| Source | Constraint | How it is honoured |
|---|---|---|
| Rule 1 | Money is integer minor units only. No floats in storage. | `amountMinorUnits`, `discountMinorUnits`, `finalChargeMinorUnits` are all `Int` / `number` integers. |
| Rule 7 | No intermediate rounding. | `Math.round(amount * bps / 10000)` is the only rounding, and it produces the discount — the final money value. No rounding of `bps/10000` first. |
| Rule 10 | Append-only where it matters. | `DiscountRedemption` has no update or delete path. A correction is a new row. |
| Rule 12 | Entitlement derives from the payment log, not from cached state. | A redemption is a **price adjustment**, not a grant. It is referenced by the checkout initiation row and consumed at fulfilment; it never sets `Subscription.status`. |

### 1.4 Explicitly out of scope

Per the PRD's out-of-scope list, this feature does **not** introduce: promo code
campaigns or marketing surfaces, stacked or combinable codes, percentage-off plus
fixed-off together, free trials, refunds, admin UI for creating codes, scheduled
campaigns, or per-plan restrictions. One code, one discount, no stacking.

---

## 2. Data model

```prisma
model DiscountCode {
  id                   String    @id @default(cuid())
  code                 String    @unique   // normalised: uppercase, trimmed
  basisPointsOff       Int                 // 10000 = 100%, 2500 = 25%
  minSpendMinorUnits   Int?                // null = no minimum
  startsAt             DateTime?           // null = valid from creation
  expiresAt            DateTime?           // null = never expires
  maxRedemptions       Int                 // global cap; 0 means none allowed
  createdAt            DateTime  @default(now())

  redemptions          DiscountRedemption[]

  @@index([expiresAt])
}

model DiscountRedemption {
  id                    String    @id @default(cuid())
  discountCodeId        String
  discountCode          DiscountCode @relation(fields: [discountCodeId], references: [id])
  userId                String
  orderReference        String             // the tx_ref of the payment intent
  chargeMinorUnits      Int                // charge before discount
  discountMinorUnits    Int
  finalChargeMinorUnits Int
  redeemedAt            DateTime  @default(now())

  // One use per customer, and one use per payment intent. Both are enforced by the
  // database rather than by a read-then-write check in application code, so two
  // concurrent requests cannot both win the race.
  @@unique([discountCodeId, userId])
  @@unique([discountCodeId, orderReference])
  @@index([userId])
  @@index([discountCodeId])
}
```

### 2.1 Why the uniqueness is on the database, not in the service

A service that does `SELECT count(*) ... WHERE userId = ?` and then `INSERT` has a
race: two concurrent requests both read zero and both insert. The only correct place
for "one use per customer" is a `UNIQUE` constraint. The service therefore:

1. performs the readable checks (existence, window, minimum spend) to produce a good
   error message;
2. attempts the insert inside a transaction and **treats a unique-constraint
   violation as a rejection** rather than an exception to be logged and ignored.

This is the same reasoning as `PaymentLog.flutterwaveEventId @unique` in the existing
schema — idempotency and single-use are properties of the storage layer.

---

## 3. Validation order, and why it is that order

The order is a deliberate design decision, and getting it wrong produces a
subtly incorrect system. Two rules govern it:

**Rule A — idempotency is checked before eligibility.** If a client retries a
successful request (network timeout, double-click, page reload) and the code has since
expired or hit its cap, the retry must still return the original redemption. Checking
expiry first would tell a legitimately-paid customer that their payment intent was
never valid, which is both false and alarming.

Note what this does *not* require: it does not require the idempotency check to run
before the code is loaded. It requires the check to run before the **window, minimum
spend, and cap** checks. Loading the code row is unavoidable either way, so the
lookup is keyed on the normalised code *string* rather than on the row's id — which
additionally means a replay of a redemption whose code row has since been deleted
still succeeds. That is the correct behaviour: the money moved.

**Rule B — read-only checks come before the insert.** Existence, window, and minimum
spend are all deterministic and can produce a precise reason. They cost nothing and
let the client show something better than "invalid code".

Resulting order:

1. Normalise and validate the **shape** of the request (is there a code string? is it
   non-empty? are the amounts safe integers?).
2. **Idempotency** — has this code already been redeemed against this `orderReference`?
   If yes, return that record.
3. **Existence** — does the code exist at all?
4. **Validate the stored percentage** — is `basisPointsOff` within `[0, 10000]`? A
   data defect, surfaced rather than clamped, and deliberately checked *before* the
   window (see §4.4).
5. **Window** — is `now` within `[startsAt, expiresAt]`?
6. **Minimum spend** — is the charge `>= minSpendMinorUnits`?
7. **Global cap** — has this code been claimed `maxRedemptions` times?
8. **Per-customer single use** — has this user redeemed this code before?
9. **Compute** the discount and the final charge.
10. **Insert** the redemption. A unique-constraint violation here means steps 3–9 were
    bypassed by a concurrent request; report it as a single-use rejection.
11. Return the redemption.

Steps 3–9 are all read-only and cheap. Step 10 is the only write, and it is the only
place a rejection can be *proven* rather than *assumed*.

---

## 4. Pseudocode

### 4.1 Normalisation

```
FUNCTION normalizeCode(rawCode)
INPUTS:
  rawCode (text) — the code exactly as the user typed it
OUTPUT: text — the canonical form: trimmed, and uppercased
SIDE EFFECTS: NONE
FAILS WHEN: rawCode is not text, or is empty after trimming
STEPS:
1. SET trimmed to rawCode with leading and trailing whitespace removed.
2. IF trimmed is empty, THROW DiscountError with code "INVALID_CODE_FORMAT".
3. IF rawCode is not text, THROW DiscountError with code "INVALID_CODE_FORMAT".
4. RETURN trimmed uppercased.
```

Uppercasing means `SAVE10` and `save10 ` are the same code. Without it, a typo in case
produces a "code not found" error on a code the customer can see on a poster.

### 4.2 The redemption service

```
FUNCTION redeemDiscountCode(input, dependencies)
INPUTS:
  input.code                     (text)    — as typed by the user
  input.orderReference          (text)    — the tx_ref of the payment intent
  input.userId                   (text)    — the signed-in user
  input.chargeMinorUnits         (integer) — the charge BEFORE any discount
  dependencies.discounts        — read access to DiscountCode
  dependencies.redemptions      — write access to DiscountRedemption, including the
                                   ability to report a unique-constraint violation
  dependencies.now              (DateTime)— injected clock, so the function is testable
OUTPUT: a redemption record:
  discountCode        (text)
  discountMinorUnits  (integer)
  finalChargeMinorUnits(integer)
  alreadyRedeemed     (boolean) — true if this was an idempotent replay (Rule A)
  discountedTotalMinorUnits (integer, nullable) — the code's running total, when known
SIDE EFFECTS: at most ONE insert into DiscountRedemption. Nothing else. No update,
  no delete, no external call. The insert is the only way entitlement-adjacent state
  changes, and it is append-only.
FAILS WHEN — each with a distinct error code, none of which write anything:
  - code is empty or not text                       → INVALID_CODE_FORMAT
  - chargeMinorUnits is not a safe integer, or is
    negative                                          → INVALID_AMOUNT
  - orderReference is empty or not text              → INVALID_ORDER_REFERENCE
  - basisPointsOff is outside [0, 10000]             → INVALID_DISCOUNT_VALUE
  - the code does not exist                          → CODE_NOT_FOUND
  - now < startsAt, or now > expiresAt               → CODE_NOT_ACTIVE
  - chargeMinorUnits < minSpendMinorUnits            → MINIMUM_SPEND_NOT_MET
  - redemptions for this code >= maxRedemptions      → CODE_EXHAUSTED
  - this user has already redeemed this code         → CODE_ALREADY_USED
  - the insert violates the (code, userId) unique
    constraint — a concurrent request won the race   → CODE_ALREADY_USED
  - the insert violates the (code, orderReference)
    unique constraint                                 → treated as idempotent replay
```

**Steps**

```
1.  /* ---- shape: reject garbage before touching the database ---- */
2.  SET code to normalizeCode(input.code).                      THROWS INVALID_CODE_FORMAT
3.  IF input.orderReference is not non-empty text,
        THROW DiscountError("INVALID_ORDER_REFERENCE").
4.  IF input.userId is not non-empty text,
        THROW DiscountError("INVALID_USER").
5.  IF NOT Number.isSafeInteger(input.chargeMinorUnits),
        OR input.chargeMinorUnits < 0,
        THROW DiscountError("INVALID_AMOUNT").
        NOTE: 0 is allowed. A free-tier checkout may legitimately be 0, and a
        discount on 0 is simply 0. It is not an error.

6.  /* ---- Rule A: idempotency before eligibility ---- */
7.  LOOK UP an existing redemption WHERE DiscountCode.code == code
       AND orderReference == input.orderReference.
       Keyed on the CODE STRING, not the row id, so this works even if the code row
       has since been deleted — the money moved, and the retry must succeed.
       IF one exists:
           RETURN it with alreadyRedeemed set to true.
           DO NOT re-validate the window, the minimum spend or the cap. All three may
           have changed since the original redemption.

8.  /* ---- Rule B: readable checks, cheapest and most specific first ---- */
9.  LOOK UP the DiscountCode WHERE code == code.
       IF NOT found, THROW DiscountError("CODE_NOT_FOUND").
10. IF discount.basisPointsOff is outside [0, 10000],
        THROW DiscountError("INVALID_DISCOUNT_VALUE").
        NOTE: a data defect, not a user error. Surfaced rather than clamped — a code
        with bps = 12000 would otherwise silently become a 100% discount.
        Checked before the arithmetic, so the caller gets an alert rather than a
        customer paying nothing. Also checked before the window — see 4.4.
11. IF discount.startsAt is not null AND dependencies.now < discount.startsAt,
        THROW DiscountError("CODE_NOT_ACTIVE") with reason "not_yet_active".
12. IF discount.expiresAt is not null AND dependencies.now > discount.expiresAt,
        THROW DiscountError("CODE_NOT_ACTIVE") with reason "expired".
        NOTE: both bounds INCLUSIVE. now == expiresAt is still valid. The alternative
        makes "expires 2026-01-01" ambiguous at midnight, which is the single most
        common source of off-by-one support tickets in promo systems.
13. IF discount.minSpendMinorUnits is not null
        AND input.chargeMinorUnits < discount.minSpendMinorUnits,
        THROW DiscountError("MINIMUM_SPEND_NOT_MET") carrying the shortfall so the
        client can say "add ₦X more".

14. /* ---- global cap ---- */
15. COUNT the redemptions for this discountCodeId.
        IF count >= discount.maxRedemptions,
            THROW DiscountError("CODE_EXHAUSTED") carrying the cap.
        NOTE: racy on its own — two concurrent requests can both pass this check. It
        is a fast, friendly rejection; the unique constraints in step 23 are what
        actually make the cap hold when the last unit is contested.

16. /* ---- has this user already used it? ---- */
17. LOOK UP a redemption for this (discountCodeId, userId).
        IF one exists, THROW DiscountError("CODE_ALREADY_USED").
        ALSO racy. Same comment as step 15.

18. /* ---- compute: exactly one rounding, on the discount ---- */
19. SET rawDiscount to input.chargeMinorUnits * discount.basisPointsOff / 10000.
        NO ROUNDING HERE. This is a product divided by 10000 and it is generally
        fractional. Rule 7.
20. SET discountMinorUnits to Math.min(input.chargeMinorUnits,
                                      Math.round(rawDiscount)).
        TWO CLAUSES, in this order:
          - round ONCE, at the end, to produce the money value (Rule 7)
          - THEN cap at the charge (B-7), so a discount can never exceed what is
            being paid and the final charge can never go negative
        Reversing these two clauses is a real bug: without the cap, a 150% code on a
        ₦1,000 charge yields a final charge of -₦500, and "negative charge" is not a
        state any payment provider accepts.
21. SET finalChargeMinorUnits to input.chargeMinorUnits - discountMinorUnits.
        Safe integers cannot underflow here because of the cap in step 20.
        NOTE: no Math.round. The subtraction of two integers is an integer.

22. /* ---- the single write ---- */
23. WRITE a DiscountRedemption with:
        discountCodeId, userId, orderReference,
        chargeMinorUnits = input.chargeMinorUnits,
        discountMinorUnits, finalChargeMinorUnits, redeemedAt = dependencies.now.
24. IF the write fails on the (discountCodeId, userId) unique constraint,
        THROW DiscountError("CODE_ALREADY_USED").
        A concurrent request won the race. Not a bug; a correct outcome reported
        through the only channel that can prove it.
25. IF the write fails on the (discountCodeId, orderReference) unique constraint,
        LOOK UP and RETURN that redemption with alreadyRedeemed set to true.
        Same outcome as step 7, reached by a different route. Both paths must behave
        identically, because a client cannot tell which one it hit.
26. RETURN the redemption with alreadyRedeemed set to false.
```

### 4.3 Why the cap is checked twice, and read before the write

Steps 15 and 17 are both racy. They exist to produce a precise, friendly error
(`CODE_EXHAUSTED` vs `CODE_ALREADY_USED`) instead of a constraint-violation message.
Steps 24 and 25 are the ones that actually hold the line.

The alternative — trusting the pre-checks alone — permits N concurrent requests to all
observe "1 redemption left" and all N to succeed. For a discount capped at a hundred
uses, that is a hundred too many. The pre-checks are for the user's benefit; the
constraints are for the business's.

### 4.4 A note on the order of steps 10 and 11–12

The stored percentage is validated *before* the window. That ordering is deliberate and
slightly unusual: a window check would be the more natural place to stop early, and a
code that is both expired and misconfigured would otherwise report as expired. The
reason for checking the data defect first is that `INVALID_DISCOUNT_VALUE` maps to
HTTP 500 and is meant to page someone. Burying it under a 410 means the misconfigured
row sits there until someone tries to use the code during its active window — which
may never happen. A dead code is a data problem found on schedule; a misconfigured
live code is one that silently over-discounts.

---

## 5. Worked example

**Code:** `SAVE25` — 2500 bps off (25%), minimum spend 200,000 kobo (₦2,000.00),
valid 2026-01-01 to 2026-12-31, cap 100 redemptions.

**Charge:** 470,000 kobo (₦4,700.00) — the PRD's upgrade example, so this composes
with the existing proration path.

| Step | Evaluation | Result |
|---|---|---|
| 2 | `"SAVE25"` trimmed, non-empty | `code = "SAVE25"` |
| 3–5 | `tx_ref` non-empty; userId non-empty; `470000` is a safe integer `>= 0` | pass |
| 7 | no redemption for (`SAVE25`, this `tx_ref`) | continue |
| 9 | `SAVE25` exists | found |
| 10 | `2500` is within `[0, 10000]` | pass |
| 11 | `now` = 2026-06-15, `>= 2026-01-01` | pass |
| 12 | `now` = 2026-06-15, `<= 2026-12-31` | pass |
| 13 | `470000 >= 200000` | pass |
| 15 | 63 redemptions `< 100` | pass |
| 17 | this user has not redeemed `SAVE25` | pass |
| 19 | `470000 * 2500 / 10000 = 117500` — exact, no fraction | `rawDiscount = 117500` |
| 20 | `Math.round(117500) = 117500`; `min(470000, 117500) = 117500` | `discountMinorUnits = 117500` |
| 21 | `470000 - 117500 = 352500` | `finalChargeMinorUnits = 352500` |
| 23 | write the redemption | 1 row |
| 26 | — | return |

**Result:** 25% off, ₦1,175.00 saved, customer pays **₦3,525.00** (352,500 kobo).
Reconciliation: `117500 + 352500 = 470000` ✓ — the discount and the final charge sum
back to the original charge exactly, because both are integers derived from a single
rounding.

**Non-exact case** — charge 499,999 kobo, same code:

| Step | Evaluation | Result |
|---|---|---|
| 19 | `499999 * 2500 / 10000 = 124999.75` | fractional |
| 20 | `Math.round(124999.75) = 125000`; cap not binding | `discountMinorUnits = 125000` |
| 21 | `499999 - 125000 = 374999` | `finalChargeMinorUnits = 374999` |
| | `125000 + 374999 = 499999` | ✓ reconciles exactly |

**Over-cap case** — a 15000 bps (150%) code on a charge of 470,000:

| Step | Evaluation | Result |
|---|---|---|
| 10 | `15000 > 10000` | **`THROW INVALID_DISCOUNT_VALUE`** |

The data defect is caught before the arithmetic. Had it not been, step 20's cap would
have limited the discount to 470,000 and the customer would have paid 0 — a silent
150%-off promotion instead of an alert.

**Excess-discount case** — a 9000 bps (90%) code on a charge of 100 kobo:

| Step | Evaluation | Result |
|---|---|---|
| 19 | `100 * 9000 / 10000 = 90` | `rawDiscount = 90` |
| 20 | `Math.round(90) = 90`; `min(100, 90) = 90` — cap not binding | `discountMinorUnits = 90` |
| 21 | `100 - 90 = 10` | `finalChargeMinorUnits = 10` |

| Step | Evaluation | Result |
|---|---|---|
| 19 | `100 * 9900 / 10000 = 99` | `rawDiscount = 99` |
| 20 | `Math.round(99) = 99`; `min(100, 99) = 99` | `discountMinorUnits = 99` |
| 21 | `100 - 99 = 1` | `finalChargeMinorUnits = 1` |

A 99% code on ₦1 leaves ₦0.01, not ₦0. The cap only binds above 100% of the charge,
which step 10 rejects first — so in practice the cap is a second line of defence rather
than the primary mechanism. Recording that honestly matters more than claiming the cap
is doing more work than it is.

---

## 6. Error codes

| Code | HTTP | User-facing message | Means |
|---|---|---|---|
| `INVALID_CODE_FORMAT` | 400 | Enter a discount code | Not text, or empty after trimming |
| `INVALID_AMOUNT` | 400 | — | Charge is not a safe integer, or is negative |
| `INVALID_ORDER_REFERENCE` | 400 | — | No payment intent to attach the discount to |
| `INVALID_USER` | 401 | Sign in again | No session |
| `INVALID_DISCOUNT_VALUE` | 500 | This code is misconfigured — contact support | Data defect, not user error |
| `CODE_NOT_FOUND` | 404 | We don't recognise that code | No such code |
| `CODE_NOT_ACTIVE` | 410 | This code isn't active | Outside the window; `reason` says which side |
| `MINIMUM_SPEND_NOT_MET` | 422 | Spend at least ₦X to use this code | Below the floor |
| `CODE_EXHAUSTED` | 410 | This code has been fully claimed | Global cap reached |
| `CODE_ALREADY_USED` | 409 | You've already used this code | One use per customer |
| `ALREADY_DISCOUNTED` | 409 | A discount is already applied | A second code on the same intent (B-1) |

`INVALID_DISCOUNT_VALUE` is the only one mapped to 500. It means the database holds a
code nobody should have been able to create — a deployment or seeding bug. Surfacing it
as a user error would hide it; surfacing it as a crash would lose the code. It returns
500 with a safe message and logs the offending row.

---

## 7. What this feature does not do

Stated explicitly, because scope creep is the usual failure here:

- It does not create or edit codes. No admin surface, no seeding script, no API for
  creating a `DiscountCode`.
- It does not stack. One code per payment intent. A second code is `ALREADY_DISCOUNTED`.
- It does not refund. A redemption recorded against a payment that then fails is
  released by the existing webhook `failure` path, not by a refund.
- It does not gate features. It sets a price. Entitlement still comes from the payment
  log and a fulfilment row (Rule 12).
- It does not validate the charge against the plan catalog. It trusts the caller's
  `chargeMinorUnits` because proration already produced it; re-deriving the price here
  would duplicate `lib/proration/calculate.ts` and create two sources of truth.

---

## 8. Test coverage

`task-5/harness/b-discount.test.ts` — 30 tests covering:

| Group | Cases |
|---|---|
| Normalisation | lowercase, padded, whitespace-only, empty, non-string |
| Happy path | exact-multiple discount, non-exact discount, reconciliation, composition with the proration example |
| Window | before start, after expiry, exactly at start, exactly at expiry, null bound |
| Minimum spend | below (with shortfall attached), equal (passes), null minimum |
| Single use | same user + new intent rejected; different user allowed |
| Global cap | at cap rejected; one below allowed |
| Idempotency | same intent replays the original, no second row, works after expiry and after the cap |
| Rounding | non-exact product rounds once; 100% code; no intermediate rounding |
| Caps | out-of-range bps rejected; discount never exceeds charge; final charge ≥ 0 |
| Validation | NaN, ±Infinity, negative, fractional, beyond `MAX_SAFE_INTEGER`, missing user, missing intent |
| Concurrency | both pre-checks pass, unique constraint still rejects the second |
| Side effects | every kind of rejection writes nothing; one successful call writes one row |

Run it alongside the rest of the Task 5 harness:

```
node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
```

---

## 9. Authorship

Part B requires the implementation to be written without AI assistance. I am an AI, so
that requirement is not met.

- `task-5/part-b/discount.ts` is AI-written.
- To meet the requirement, implement it yourself from
  `task-5/part-b/01-specification.md`. The specification states the requirements, the
  validation order and the worked examples, and includes the reasoning behind each
  decision, so it is sufficient without reading `discount.ts`.
- `task-5/harness/b-discount.test.ts` works as an acceptance suite for any correct
  implementation: it checks behaviour and error codes, not internals.

Part A2's first pass and Part C4's recording have the same constraint. See
`task-5/README.md` for the full list.