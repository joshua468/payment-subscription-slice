# Part C2 — AI Reverse Pseudocode & Implementation Comparison

## Overview & Methodology

In this phase of Task 5, I evaluated the interaction between precise human pseudocode specification and AI code generation:
1. **AI Generation:** I provided the exact pseudocode specification from Part B (`part-b/01-specification.md`) to an AI coding assistant with strict instructions to implement it without adding unspecified behaviors, producing `part-c/discount-ai.ts`.
2. **Reverse Pseudocoding:** I read through `discount-ai.ts` line-by-line and reverse-engineered its pseudocode without looking back at the original specification.
3. **Comparison & Verification:** I constructed a structured Difference Table (categorizing items as ADDED, OMITTED, or MISINTERPRETED) and ran both implementations against 10 complex test scenarios in `task-5/harness/c-discount-comparison.test.ts`.

---

## 1. Reverse pseudocode — derived from `part-c/discount-ai.ts`

Derived from `discount-ai.ts`. Identifier names are the ones in that file.

```
FUNCTION redeemDiscountCode(request, ctx)
INPUTS:
  request.code             (text)     — as typed by the user
  request.paymentRef       (text)     — the payment intent reference
  request.userId           (text)     — the signed-in user
  request.chargeMinorUnits (integer)  — the charge BEFORE any discount, in kobo
  ctx.store                (Store)    — data access, injected
  ctx.clock                (DateTime) — injected clock
OUTPUT: a RedeemOutcome containing
  code                        (text)
  discountMinorUnits          (integer) — the discount, in kobo
  payableMinorUnits           (integer) — what the customer now owes
  replayed                    (boolean) — true if this was a retry of a prior success
  totalRedeemedMinorUnits     (integer or null) — code-wide redeemed total, null if the
                                             aggregate query could not be read
SIDE EFFECTS: at most ONE save() call, which creates one Redemption row. Nothing is
  updated or deleted. No external call.
FAILS WHEN: — each rejection is a DiscountError carrying a code
  - code is not text, or is blank after trimming      → INVALID_CODE_FORMAT
  - paymentRef is missing or blank                    → INVALID_ORDER_REFERENCE
  - userId is missing or blank                        → INVALID_USER
  - chargeMinorUnits is not a whole, finite,
    non-negative, safe integer                        → INVALID_AMOUNT
  - no code with that name exists                     → CODE_NOT_FOUND
  - stored percentBps is not a whole number in
    [0, 10000]                                        → INVALID_DISCOUNT_VALUE
  - clock is outside [activeFrom, activeUntil]        → CODE_NOT_ACTIVE
  - chargeMinorUnits < minimumChargeMinorUnits        → MINIMUM_SPEND_NOT_MET
  - redemptions so far >= redemptionLimit             → CODE_EXHAUSTED
  - this user already has a redemption of this code   → CODE_ALREADY_USED
  - save() loses a race on the (code, userId)
    unique constraint                                  → CODE_ALREADY_USED
  - save() loses a race on the (code, paymentRef)
    unique constraint                                  → treated as a replay
```

**Steps**

```
1.  SET name to canonical(request.code).                        THROWS INVALID_CODE_FORMAT
2.  IF request.paymentRef is not filled, THROW INVALID_ORDER_REFERENCE.
3.  IF request.userId is not filled,     THROW INVALID_USER.
4.  IF NOT validKobo(request.chargeMinorUnits), THROW INVALID_AMOUNT.

5.  /* replay beats eligibility */
6.  SET replay to AWAIT ctx.store.redemptionByPaymentRef(name, request.paymentRef).
7.  IF replay is not null,
        RETURN outcomeFrom(replay, replayed=true, total=readTotal(...)).
        NOTE: keyed on the code NAME, not the row id.

8.  SET discount to AWAIT ctx.store.codeByName(name).
9.  IF discount is null, THROW CODE_NOT_FOUND.

10. IF NOT a whole number in [0, 10000] for discount.percentBps,
        THROW INVALID_DISCOUNT_VALUE.

11. IF NOT withinWindow(discount, ctx.clock),
        SET tooEarly to (activeFrom is not null AND clock < activeFrom).
        THROW CODE_NOT_ACTIVE with reason "not_yet_active" if tooEarly,
                                 otherwise reason "expired".

12. IF minimumChargeMinorUnits is not null
        AND chargeMinorUnits < minimumChargeMinorUnits,
        THROW MINIMUM_SPEND_NOT_MET carrying shortByMinorUnits.

13. SET used to AWAIT ctx.store.redemptionCount(discount.id).
14. IF NOT withinCapLimit(discount, used), THROW CODE_EXHAUSTED.

15. SET priorUse to AWAIT ctx.store.redemptionByUser(discount.id, request.userId).
16. IF NOT untouchedByUser(priorUse), THROW CODE_ALREADY_USED.

17. SET discountMinorUnits to CALL computeDiscount(chargeMinorUnits, percentBps):
        exact = (chargeMinorUnits * percentBps) / 10000
        RETURN min(chargeMinorUnits, round(exact))
18. SET payableMinorUnits to chargeMinorUnits - discountMinorUnits.

19. SET draft to { discountCodeId, code, userId, paymentRef, chargeMinorUnits,
                  discountMinorUnits, payableMinorUnits, createdAt = ctx.clock }.
20. TRY saved = AWAIT ctx.store.save(draft).
21.      RETURN outcomeFrom(saved, replayed=false, total=readTotal(...)).
22.  CATCH error:
23.      SET constraint to CALL losingConstraint(error).
24.      IF constraint is "user", THROW CODE_ALREADY_USED.
25.      IF constraint is "paymentRef",
            SET concurrent to AWAIT redemptionByPaymentRef(discount.code, paymentRef).
            IF concurrent is not null,
                RETURN outcomeFrom(concurrent, replayed=true, ...).
26.      RE-RAISE error.
```

### Helper functions, which the Part B version inlines

```
FUNCTION canonical(name)
  1. IF name is not text, THROW INVALID_CODE_FORMAT.
  2. SET squeezed to name with surrounding whitespace removed.
  3. IF squeezed is "", THROW INVALID_CODE_FORMAT.
  4. RETURN squeezed uppercased.

FUNCTION filled(value)      → value is text AND trimmed value is non-empty
FUNCTION validKobo(value)   → value is a safe integer AND value >= 0
FUNCTION withinWindow(code, clock)
     → (activeFrom is null OR clock >= activeFrom)
       AND (activeUntil is null OR clock <= activeUntil)
FUNCTION withinCapLimit(code, used) → used < redemptionLimit
FUNCTION untouchedByUser(existing)  → existing is null
FUNCTION computeDiscount(charge, bps)
     → min(charge, round((charge * bps) / 10000))
FUNCTION losingConstraint(error)
     → "user"           if error.constraint == "discountCodeId_userId"
     → "paymentRef"     if error.constraint == "discountCodeId_orderReference"
     → null             otherwise
FUNCTION outcomeFrom(redemption, replayed, total)
     → { code, discountMinorUnits, payableMinorUnits, replayed,
         totalRedeemedMinorUnits: total }
FUNCTION readTotal(ctx, discountCodeId)
     → AWAIT sumDiscountedMinorUnits(discountCodeId), or null if that call throws
```

---

## 2. Difference table

Categories are **ADDED** (present in the AI version, absent from Part B), **OMITTED**
(present in Part B, absent from the AI version), and **MISINTERPRETED** (both versions
have the element, but one reads the requirement differently). Each row says which side
is correct and why.

| # | Element | Part B (`discount.ts`) | AI (`discount-ai.ts`) | Category | Which is right |
|---|---|---|---|---|---|
| 1 | **Order: stored-percentage validation vs. the validity window** | Window checked first (steps 5 then 4 in code order), percentage validated second | Percentage validated first (step 10), window second (step 11) | **MISINTERPRETED** | **The AI version — and Part B was a bug.** `01-specification.md` §4.4 argues explicitly that `INVALID_DISCOUNT_VALUE` must precede the window so a misconfigured code pages someone instead of hiding behind a 410 until someone happens to use it during its active window. Part B's implementation contradicted its own spec. **Caught by this comparison; fixed.** |
| 2 | **Field names vs. the Prisma schema** | `basisPointsOff`, `minSpendMinorUnits`, `startsAt`, `expiresAt`, `maxRedemptions`, `orderReference`, `finalChargeMinorUnits`, `redeemedAt`, `alreadyRedeemed`, `discountedTotalMinorUnits`, `detail` | `percentBps`, `minimumChargeMinorUnits`, `activeFrom`, `activeUntil`, `redemptionLimit`, `paymentRef`, `payableMinorUnits`, `createdAt`, `replayed`, `totalRedeemedMinorUnits`, `meta` | **ADDED** | **Neither, as written — but Part B is safer.** The AI renamed every field away from the schema in §2 of the spec. Renaming is harmless for a standalone module and actively dangerous when wired to Prisma: `activeFrom` and `startsAt` mean the same thing, and a codebase that carries both spellings for one column is a codebase where someone picks the wrong one. Renaming also breaks every test, every client type and every log query written against the spec. |
| 3 | **Named predicates** | `isNonEmptyText`, `isValidCharge`, `constraintName` — three, and the rest inlined | `filled`, `validKobo`, `withinWindow`, `withinCapLimit`, `untouchedByUser`, `computeDiscount`, `losingConstraint`, `outcomeFrom`, `readTotal` — nine | **ADDED** | **The AI version, mildly.** Extracting `withinWindow` makes the inclusive-bounds decision visible in one place instead of split across two `if` statements, which is where an off-by-one is introduced. This is style, not correctness — every branch is identical. `untouchedByUser` is the weakest of them: a predicate whose body is `existing === null`, used once, is ceremony. |
| 4 | **Constraint-violation decoding** | Compares raw constraint strings at the call site: `constraint === "discountCodeId_userId"` | Decodes once in `losingConstraint`, returning `"user"` / `"paymentRef"` / `null` | **ADDED** | **The AI version.** Neither validates that `error.constraint` is actually a string before trusting it — both would throw on a driver that reports the violation differently. `losingConstraint` is a better *shape* but the same gap. |
| 5 | **Reversed-logic predicate at the call site** | `if (!Number.isSafeInteger(basisPointsOff) \|\| bps < 0 \|\| bps > MAX)` — three-way OR, negated | `if (!(isSafe && >= 0 && <= MAX))` via an `if` guard inside the negation, with the whole condition in one `if` | **ADDED** (form) | **Neither.** Both are correct. Noting this row only because the AI's shape — three negated clauses inside one `||` — is the one I would flag in review: `!a \|\| b < 0 \|\| b > MAX` has a negated term in the first position only, which is easy to misread when skimming. |
| 6 | **Spec §4.4 argument** | Present in the spec; argued at length; **not implemented** | Not present — the AI had only the requirements, not §4.4 | **OMITTED** | Neither — §4.4 is prose. But its omission from the AI version is precisely why the AI got row 1 *right*: the ordering came out of the code being written for the requirements rather than against an argument. That is a genuine finding about how the spec is structured, not about the model. |
| 7 | **Comment density and rationale** | Every non-obvious step carries a "why" comment, including the failed first attempt at the idempotency lookup | Fewer comments; each remaining one explains a *mechanism* (why multiply before divide) rather than a *decision* | **ADDED** | **Split decision, and it depends on audience.** The AI's `computeDiscount` comment is the better comment — it explains why the operation order matters, which is the thing a reader will get wrong. Part B's comments explain why the author chose an ordering, which is the thing a reviewer needs. Both are useful; neither substitutes for the other. |
| 8 | **Guard on `maxRedemptions` / `redemptionLimit` being a valid integer** | Absent | Absent | **OMITTED (both)** | **Neither is complete.** If `maxRedemptions` is negative or fractional, `used >= maxRedemptions` is trivially true for a negative value (code permanently exhausted) and the comparison is meaningless for a fractional one. The spec never required this check, so its absence is consistent — but it is a shared gap worth noting, and it is exactly the class of defect Part A3 was about. |
| 9 | **`INVALID_USER` / `INVALID_ORDER_REFERENCE` detail payload** | Neither carries `detail` on these two rejections | Neither carries `meta` on these two rejections | Tie | Tie. Same behaviour, and the omissions match each other. |
| 10 | **Error message wording** | "This code is not yet active" / "This code has expired" | "code is not active" | Tie (omitted by both) | Tie. Both attach the distinguishing `reason`, which is the part that matters; the prose is for logs. |
| 11 | **Does the file compile?** | `tsc --noEmit` clean | **Did not** — `discount-ai.ts:278` read `priorUse.redeemedAt`, but its own `Redemption` type declares `createdAt`. The error was live until I ran a typecheck | **OMITTED** | **Part B, obviously.** This is the difference that matters most in the whole table and it is not a design difference at all — it is a crash on `tsc`. Worth stating plainly: the ten-input behavioural comparison in §3 would never have caught this, because the code path is only reached on a `CODE_ALREADY_USED` rejection and the harness's happy paths passed. The defect surfaced only because I ran the project's typechecker, not because I tested. |

### Counts

| Category | Count |
|---|---|
| MISINTERPRETED | **1** (row 1) |
| ADDED | 4 (rows 2, 3, 4, 7) |
| OMITTED | 3 (rows 6, 8, 11) — rows 8 and 11 are not design choices at all |
| Tie / equivalent | 3 (rows 5, 9, 10) |

**One behavioural difference in ten rows, and it was a real bug in my own code.** Every
other difference is naming, structure, or comment style. That is what "correct
implementations of the same clear specification" should look like — and it is also the
main reason the ten-input comparison in §3 is going to find almost nothing. Read the
two tables together: a comparison that finds eight naming differences and one
behavioural one is measuring specification quality, not model quality.

**Row 11 is the correction to that conclusion, and it is the most useful thing in this
document.** "The behavioural comparison finds almost nothing" was true and still
misleading. The AI's code did not typecheck. My ten-input harness exercised it
successfully — every scenario passed — because the broken line sits behind a
`CODE_ALREADY_USED` rejection, and none of the ten inputs reached it in a way that
compiled the whole path. I found it by running `tsc`, which I only did at the very end
as a habit, not as part of verifying this table.

The lesson generalises past this exercise: **a green test suite is not the same as
working code.** Ten scenarios chosen by the person who wrote the specification are
blind to the specification's own blind spots. Typechecking, linting and running the
build are separate instruments, and none of them substitutes for another.

---

## 3. What row 1 actually taught me

Worth spelling out, because it is the only substantive finding in this section and it
is about my process rather than about the AI.

`01-specification.md` argues the ordering in §4.4 — "a data defect should page someone,
so check it before the window". Then `discount.ts`, written by me, an hour later,
checked the window first. The prose was correct and the code did the opposite, and
nothing in the test suite caught it, because every test that used a misconfigured
percentage was also outside the window and so passed for the wrong reason.

The AI version got it right — not because it reasoned better, but because it never saw
the argument and simply wrote the checks in the order the requirements list them. Two
lessons, both uncomfortable:

1. **A specification that argues for an ordering is a weaker specification than one
   that encodes it.** §4.4 should not be a paragraph; it should be a line in the
   numbered list, which it now is (step 4 of §3).
2. **A test that passes for the wrong reason is worse than no test.** The
   `INVALID_DISCOUNT_VALUE` cases did not distinguish "validated before the window"
   from "validated after it". The fix was to add a case with a *live* window and an
   out-of-range percentage — which is now
   `rejects an out-of-range stored percentage rather than clamping it` in
   `task-5/harness/b-discount.test.ts`, running against a code with no window at all.

The row-1 fix is in both `discount.ts` and the spec, and both are covered by the
harness.