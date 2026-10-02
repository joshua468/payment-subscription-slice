# A1.1 — `fulfilFromWebhook`

**Source:** `lib/subscription/service.ts:245-366`
**Chosen because:** it combines an idempotency guard, an external call whose failure mode
differs from a payment failure, a lookup with a fallback chain, and three append-only
writes. Misreading any one of those either double-grants entitlement or swallows a real
payment.

---

## Pseudocode

```
FUNCTION fulfilFromWebhook
INPUTS:
  data (object) — the provider's webhook `data` object, already parsed and shape-checked.
                 Fields read: id (string, the provider transaction id),
                 tx_ref (string or absent, the reference we issued at checkout),
                 status (string or absent, the provider's claim about the payment),
                 sub (string or absent, the provider subscription token),
                 customer.id (string or absent, the provider customer id)
  flutterwaveEventId (string) — the idempotency key for this event. The webhook route
                 passes the transaction id, so the real webhook and the verify
                 accelerator settle the same transaction under the same key.
  rawBody (string) — the exact unparsed request body, stored verbatim in the log for audit
OUTPUT: object with two fields —
  duplicate (boolean) — true only if this event had already been recorded
  status (string) — one of:
      "already_processed"    the event id was already in the log; nothing was done
      "unconfirmed"          provider verification itself failed; deliberately inconclusive
      "failed"               provider conclusively reported a non-successful payment
      "failed_no_subscription" the payment looks fine but we cannot match it to a subscription
      "fulfilled"            entitlement granted and recorded
SIDE EFFECTS:
  - CALLS the payment provider to verify the transaction (external; may fail; may be slow)
  - READS the payment log and the subscription table
  - WRITES up to two new payment log rows (append-only; never updates or deletes a row)
  - WRITES the subscription row
  - MAY write a line to the server console log
FAILS WHEN:
  - the database is unreachable — the error propagates to the caller uncaught
  - the payment configuration is invalid or the credentials are missing — a
    PaymentError propagates out of the provider call
  It does NOT throw for a declined payment. A declined payment is a return value,
  not an exception.
```

### Steps

1. LOOK UP the payment log row whose `flutterwaveEventId` equals the input
   `flutterwaveEventId`.
2. IF such a row exists
   RETURN an object with duplicate set to true and status set to `"already_processed"`.
   STOP. Do not call the provider. Do not write anything.
   OTHERWISE continue to step 3.
3. CALL the payment provider to fetch the independently verified record for the
   transaction named `data.id`. This is a network call: it may fail and it may be slow.
4. IF that call THROWS an error
   4a. SET `verifiedText` to the error's message, or to the text `"verification error"`
       if the thrown value was not an error object.
   4b. SET `success` to false.
   4c. SET `verificationErrored` to true.
   OTHERWISE
   4d. SET `verifiedText` to the status the provider returned from its own records.
   4e. SET `success` to true only if BOTH the provider's verified status is exactly
       the text `"successful"` AND `data.status` is exactly the text `"successful"`.
       Two independent sources must agree. Either one alone is not enough.
5. LOOK UP the subscription this payment belongs to, keyed on `data.tx_ref`:
   5a. IF `data.tx_ref` is absent, take the most recently updated subscription whose
       status is `"payment_pending"`.
   5b. OTHERWISE split `data.tx_ref` on hyphens, drop the leading `"ps"` and the LAST
       two segments (the interval and the random suffix), and rejoin what remains as
       the user id — because a user id may itself contain hyphens.
   5c. IF a subscription exists for that user id, use it and stop looking.
   5d. OTHERWISE, as a fallback, scan the 50 most recent `"initiation"` payment log
       rows for one whose stored payload contains this exact `tx_ref`, and use the
       subscription that row belongs to. This catches references we cannot parse.
   5e. IF still nothing matches, there is no subscription (it is null).
6. IF `verificationErrored` is true (step 4 took the failure branch)
   RETURN duplicate false and status `"unconfirmed"` if a subscription was found,
   otherwise duplicate false and status `"failed_no_subscription"`.
   Write NOTHING. Leave the event id free so a later webhook can still settle it.
   OTHERWISE continue to step 7.
7. IF no subscription was found OR `success` is false
   7a. IF a subscription WAS found: WRITE a new payment log row with stage
       `"failure"`, carrying the event id, the error reason
       `"Transaction status: "` followed by `verifiedText`, and a payload holding the
       raw body and the verified status. This is an append; nothing existing changes.
   7b. IF no subscription was found: write a line to the server console log noting the
       unmatched event id. Do not create a log row — there is no subscription to
       attach one to.
   7c. RETURN duplicate false and status `"failed_no_subscription"` if `success` was
       true, otherwise duplicate false and status `"failed"`.
   OTHERWISE continue to step 8. (From here on: a subscription was found AND the
   provider confirmed the payment succeeded.)
8. WRITE a new payment log row with stage `"verification"`, carrying the event id and
   a payload holding the raw body and the verified status. This row — not the
   fulfilment row — is the one that owns the unique event id.
9. SET `interval` to the subscription's stored interval, falling back to the text
   `"monthly"` if the stored value is missing.
10. SET `periodStart` to the current time.
11. SET `periodEnd` to `periodStart` plus 30 days if the interval is monthly, or
    365 days if it is yearly. These lengths are locked constants, not calendar maths.
12. WRITE the subscription row: status set to `"active"`, `periodStart` and `periodEnd`
    set as computed, the provider subscription token from `data.sub` (or null if
    absent), the provider customer id from `data.customer.id` (or null if absent).
    This is the single point in the whole slice where entitlement is granted, and it
    runs only after a valid signature and an independent provider verification.
13. WRITE a new payment log row with stage `"fulfilment"` against the updated
    subscription, with a payload holding the verified status, the subscription's
    amount, the interval, the period end, and the event id. This row deliberately
    does NOT set the event id column — that column is unique, and the verification row
    in step 8 already holds it.
14. RETURN duplicate false and status `"fulfilled"`.
```

---

## Hand traces

Fixed reference time for all traces: the clock is a function I do not control, so
`periodStart`/`periodEnd` are asserted by *duration* and by relationship, not by
literal value. The database is a real PostgreSQL instance; the provider is a mock.
Every trace below is reproduced as an executable assertion in
`task-5/harness/a1-trace-check.test.ts`.

### Input 1 — NORMAL. First delivery of a successful payment

**Given**
- an existing subscription for user `U1`, status `"payment_pending"`, interval `"yearly"`
- an `initiation` payment log row already exists for `U1`
- no payment log row anywhere has event id `evt-2001`
- `data` = `{ id: "tx-9", tx_ref: "ps-U1-yearly-abc123", status: "successful",
  sub: "SUB-77", customer: { id: "CUST-5" } }`
- the provider's independent verification returns `{ status: "successful" }`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | look up log row with event id `evt-2001` | none found |
| 2 | `existing` is null, so the guard does not fire | continue |
| 3 | call provider for transaction `tx-9` | returns `status: "successful"` |
| 4d | `verifiedText` ← `"successful"` | — |
| 4e | verified is `"successful"` AND `data.status` is `"successful"` | `success = true` |
| 5b | split `ps-U1-yearly-abc123` on `-` → `["ps","U1","yearly","abc123"]` | — |
| 5b | drop first, drop last two → `["U1"]` → rejoin | `userId = "U1"` |
| 5c | subscription found for `U1` | `subscription` = the row |
| 6 | `verificationErrored` is false | skip |
| 7 | subscription found AND `success` true | skip |
| 8 | append log row, stage `verification`, event id `evt-2001` | 1 new row |
| 9 | subscription interval is `"yearly"` | `interval = "yearly"` |
| 10 | `periodStart` = now | `T0` |
| 11 | yearly → 365 days | `periodEnd = T0 + 365d` |
| 12 | update subscription: `active`, `T0`, `T0+365d`, `SUB-77`, `CUST-5` | — |
| 13 | append log row, stage `fulfilment`, event id column left null | 1 new row |
| 14 | return | `{ duplicate: false, status: "fulfilled" }` |

**Expected observable state**
- return value `{ duplicate: false, status: "fulfilled" }`
- subscription status `active`, `periodEnd - periodStart === 365 days` exactly
- subscription `flutterwaveSubId === "SUB-77"`, `flutterwaveCustomerId === "CUST-5"`
- payment log stages in creation order: `initiation`, `verification`, `fulfilment`
- exactly ONE row carries event id `evt-2001`, and it is the `verification` row
- the `fulfilment` row's event id column is null

### Input 2 — EDGE. The same event delivered a second time

**Given** — the state left behind by Input 1, unchanged
**Event** — byte-identical redelivery, same event id `evt-2001`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | look up log row with event id `evt-2001` | **found** — the verification row |
| 2 | guard fires | return immediately |

**Expected observable state**
- return value `{ duplicate: true, status: "already_processed" }`
- the provider was **never** called (asserted: mock call count did not increase)
- zero new payment log rows
- subscription `periodEnd` is **unchanged** — the paid period is not extended
- still exactly one row with event id `evt-2001`

This is the Rule 4 guarantee. The `@unique` constraint on `flutterwave_event_id` is
what makes the guarantee hold under concurrency, not this lookup — the lookup is what
makes it cheap in the common case.

### Input 3 — INVALID / ADVERSARIAL. Provider verification itself is broken

**Given**
- a fresh subscription for user `U2`, status `"payment_pending"`, interval `"monthly"`
- no log row has event id `evt-3001`
- `data` = `{ id: "tx-ERR", tx_ref: "ps-U2-monthly-zzz", status: "successful" }`
- the provider call **throws** `PaymentError("VERIFICATION_FAILED", "connection reset")`
  — a network fault on our side, not a statement about the payment

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | look up log row with event id `evt-3001` | none found |
| 2 | guard does not fire | continue |
| 3 | call provider for `tx-ERR` | **throws** |
| 4a | `verifiedText` ← `"connection reset"` | — |
| 4b | `success = false` | — |
| 4c | `verificationErrored = true` | — |
| 5b | split `ps-U2-monthly-zzz` → drop first + last two | `userId = "U2"` |
| 5c | subscription found | `subscription` = the row |
| 6 | `verificationErrored` is true → return `"unconfirmed"` | **stop** |

**Expected observable state**
- return value `{ duplicate: false, status: "unconfirmed" }`
- **zero** new payment log rows — no failure row, no verification row
- subscription status is STILL `"payment_pending"` — nothing was granted
- event id `evt-3001` is still free, so the real webhook can arrive later and fulfil

**Why this branch exists (and why it is the subtlest line in the file).** If the
`catch` block had fallen through to the ordinary failure path, three things would
break at once: a `failure` row would be written carrying event id `evt-3001`,
permanently consuming it, so when the genuine webhook arrived it would return
`already_processed` and the user would *never* get their subscription despite paying;
the subscription would stay pending forever with no way to recover; and the checkout
success page, which polls until it sees a terminal stage, would flip to "Payment not
confirmed" for a payment that actually succeeded. A transient fault on our side would
be reported to the customer as their card being declined.

---

## Trace vs. execution

| # | Category | Predicted | Executed | Agree? |
|---|---|---|---|---|
| 1 | normal | `fulfilled`; stages `initiation, verification, fulfilment`; 365-day period; event id on the verification row only | same | ✅ |
| 2 | edge | `already_processed`; provider not called; no new rows; period not extended | same | ✅ |
| 3 | adversarial | `unconfirmed`; no rows written; status still `payment_pending`; event id still free | same | ✅ |
| 4 | adversarial | `failed`; a `failure` row with the provider's status in `errorReason`; no `fulfilment` row; status not `active` | same | ✅ |
| 5 | adversarial | payload says `successful` but the provider says otherwise → `failed`; the payload cannot outvote the provider | same | ✅ |
| 6 | adversarial | an unmatched `tx_ref` → `failed_no_subscription`; nothing written against any subscription | same | ✅ |

**Two things the harness fixture had to get right, and both were wrong on my first
attempt** — recorded because they are the same class of error as the proration table
above: a plausible guess that is quietly about a different thing than the real code.

1. **`fulfilFromWebhook` takes three positional arguments** —
   `(data, flutterwaveEventId, rawBody)` — and returns `{ duplicate, status }`. I first
   called it as `fulfilFromWebhook(payload)` and asserted on a field called `outcome`.
   Neither exists. The payload passed to this function is the **inner `data` object**,
   not the whole `{ event, data }` envelope: it reads `data.id`, `data.tx_ref`,
   `data.status`, `data.sub` and `data.customer.id` directly.
2. **The subscription is not found by user id.** `findSubscriptionByTxRef` matches
   `data.tx_ref` against `rawWebhookPayload.txRef` on the 50 most recent `initiation`
   rows. So seeding a `payment_pending` subscription is not sufficient — a test must
   also write the `initiation` row that `POST /api/checkout` would have written,
   carrying the same `txRef`. Without it the function correctly returns
   `failed_no_subscription`, which is probe 6 above, arrived at accidentally.

**Discrepancies found and corrected while writing this pseudocode: one.**

My first draft of step 5 said "look the subscription up by the user id embedded in
`tx_ref`". Reading the code again, the lookup is a *two-step chain*: the parsed
user id is tried first, and only on failure does it scan the 50 most recent
`initiation` rows for a matching `tx_ref`. That fallback exists because a `tx_ref`
issued by this system is not guaranteed to be re-parseable — the user id segment is
delimited only by position, so any user id containing a hyphen-shaped interval or
random suffix could parse wrong. I corrected the pseudocode to name both steps.

**A second discrepancy was caught only by running the code, and it is the kind that
only execution reveals.** I had assumed the `fulfilment` row also carries the provider
event id, because the function's own comment talks about "one fulfilment per
purchase". Executing it showed the `fulfilment` row's `flutterwaveEventId` column is
**null** — only the `verification` row owns it. This is correct, and it is load
bearing: the column is `@unique`, so writing the same id on two rows would make the
second insert throw and turn a successful payment into a 500. The comment in the
source is about *why a per-subscription guard is wrong*, not about where the id
lives. My pseudocode now states the placement explicitly, and the harness asserts it.
