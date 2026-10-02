# A1.2 — `calculateProration`

**Source:** `lib/proration/calculate.ts:18-49`
**Why this one:** it is the only function in the slice that produces a number a
customer is charged, and it is the function that encodes Never Rule 7 — *never round
an intermediate proration value*. The whole design is about **where** the single
rounding happens, and that is invisible unless you trace it deliberately.

---

## Pseudocode

```
FUNCTION calculateProration
INPUTS:
  currentAmountMinorUnits (whole integer, kobo) — the full price of the plan the user
                 is on right now. For this slice, Pro monthly = 500000 kobo
  newAmountMinorUnits (whole integer, kobo) — the full price of the plan they are
                 moving to. Pro yearly = 5000000 kobo
  currentInterval (text, either "monthly" or "yearly") — which locked interval length
                 governs the CURRENT plan. This is the only input that picks the divisor
  daysRemaining (whole number) — whole days of already-paid time left in the current
                 period. Produced by whole-day difference against the period end
OUTPUT: object with three fields —
  creditMinorUnits (integer kobo) — the credit rounded for DISPLAY and for the log
  fullPrecisionCredit (decimal, unrounded) — the exact credit, so nothing downstream
                 has to re-derive it and lose precision
  proratedChargeMinorUnits (integer kobo) — the amount actually charged, rounded once
SIDE EFFECTS: NONE. Pure. No clock, no database, no network, no randomness.
                 Two calls with equal inputs always return equal outputs.
FAILS WHEN:
  - daysRemaining is below 0 — THROWS a RangeError
  - daysRemaining is above the number of days in the current interval — THROWS a
    RangeError
  It does NOT fail on:
  - a negative or zero current amount (no validation; the arithmetic simply runs)
  - an unrecognised currentInterval — the ternary treats anything that is not the
    exact text "monthly" as yearly, so a typo silently produces 365-day maths
```

### Steps

1. SET `daysInPeriod` to 30 if `currentInterval` is exactly the text `"monthly"`,
   OTHERWISE to 365. Note this is a two-way branch, not a validated lookup: any
   unrecognised interval falls into the 365 case.
2. IF `daysRemaining` is less than 0
   THROW a RangeError whose message states the allowed range 0 to `daysInPeriod`
   and the value actually received.
   OTHERWISE continue.
3. IF `daysRemaining` is greater than `daysInPeriod`
   THROW that same RangeError.
   OTHERWISE continue.
4. CALCULATE `dailyRate` as `currentAmountMinorUnits` divided by `daysInPeriod`.
   Keep it as a decimal. Do NOT round it.
5. CALCULATE `fullPrecisionCredit` as `dailyRate` multiplied by `daysRemaining`.
   Do NOT round it.
6. CALCULATE `fullPrecisionCharge` as `newAmountMinorUnits` minus
   `fullPrecisionCredit`. This subtraction happens on the UNROUNDED credit.
7. IF `fullPrecisionCharge` is less than or equal to zero
   SET `proratedChargeMinorUnits` to 0.
   OTHERWISE SET `proratedChargeMinorUnits` to `fullPrecisionCharge` rounded to the
   nearest whole kobo.
8. RETURN an object holding all three values:
   - `creditMinorUnits` = `fullPrecisionCredit` rounded to the nearest whole kobo
   - `fullPrecisionCredit` = the unrounded value from step 5
   - `proratedChargeMinorUnits` = the value from step 7

**The single most important line is step 6 followed by step 8.** The charge is derived
from the *unrounded* credit, and the rounded credit is produced afterwards, purely
for showing to a human. Reversing those two steps changes the amount charged. That
ordering is the entire content of Never Rule 7, and it is one line of code.

---

## Hand traces

All traces use the PRD's worked example pair: monthly `500000` kobo → yearly
`5000000` kobo, so `currentInterval = "monthly"` and `daysInPeriod = 30`.

### Input 1 — NORMAL. Upgrade on day 12 of a monthly cycle (18 days left)

**Given:** `currentAmountMinorUnits = 500000`, `newAmountMinorUnits = 5000000`,
`currentInterval = "monthly"`, `daysRemaining = 18`

**Trace**

| Step | Calculation | Value |
|---|---|---|
| 1 | interval is `"monthly"` | `daysInPeriod = 30` |
| 2 | `18 < 0`? no | continue |
| 3 | `18 > 30`? no | continue |
| 4 | `500000 / 30` | `dailyRate = 16666.666…` (repeating) |
| 5 | `16666.666… × 18` | `fullPrecisionCredit = 300000` exactly |
| 6 | `5000000 − 300000` | `fullPrecisionCharge = 4700000` |
| 7 | `4700000 > 0`, so round it | `proratedChargeMinorUnits = 4700000` |
| 8 | round the credit for display: `300000` | `creditMinorUnits = 300000` |

**Expected output**
- `creditMinorUnits = 300000` (₦3,000.00)
- `fullPrecisionCredit = 300000`
- `proratedChargeMinorUnits = 4700000` (₦47,000.00)

Sanity: 300000 + 4700000 = 5000000 — the credit plus the charge equals the yearly
price exactly. This holds because 18/30 of the month is exactly 60% of 500000.

### Input 2 — EDGE. Upgrade with only 7 days left (the PRD's second example)

**Given:** same amounts, `currentInterval = "monthly"`, `daysRemaining = 7`

**Trace**

| Step | Calculation | Value |
|---|---|---|
| 1 | `"monthly"` | `daysInPeriod = 30` |
| 2 | `7 < 0`? no | continue |
| 3 | `7 > 30`? no | continue |
| 4 | `500000 / 30` | `dailyRate = 16666.666…` |
| 5 | `16666.666… × 7` | `fullPrecisionCredit = 116666.666…` (**not** 116667) |
| 6 | `5000000 − 116666.666…` | `fullPrecisionCharge = 4883333.333…` (**not** 4883333.667) |
| 7 | `> 0`, so round once | `proratedChargeMinorUnits = 4883333` |
| 8 | round the credit for display | `creditMinorUnits = 116667` |

**Expected output**
- `creditMinorUnits = 116667` (₦1,166.67)
- `fullPrecisionCredit ≈ 116666.666…`
- `proratedChargeMinorUnits = 4883333` (₦48,833.33)

**This is the input that proves step 6 runs before step 8.** If the credit had been
rounded to 116667 *before* the subtraction, the charge would be `5000000 − 116667 =
4883333` — the same number. So this case alone does not separate the two orderings.
I picked a case that does, and it is Input 3b below.

### Input 3a — INVALID. Days remaining exceeds the interval

**Given:** `daysRemaining = 31`, everything else as Input 1

**Trace**

| Step | Calculation | Value |
|---|---|---|
| 1 | `"monthly"` | `daysInPeriod = 30` |
| 2 | `31 < 0`? no | continue |
| 3 | `31 > 30`? **yes** | **THROW RangeError** |

**Expected output** — a thrown `RangeError` reading
`daysRemaining must be between 0 and 30; got 31`. No object is returned; steps 4-8
never execute.

This is the guard that stops a caller passing a 400-day "days remaining" for a
30-day plan and producing a negative credit — which would become a *charge* rather
than a credit and bill the user for the upgrade. Note the real callers clamp before
calling (`service.ts:106-109` and `plans/page.tsx:111-114` both wrap `daysBetween`
in `Math.min`), so the throw is a defence-in-depth backstop, not the primary control.

### Input 3b — EDGE PROBE. The case that separates the two roundings

I added this fourth trace because Input 2 does not discriminate. I need a plan pair
where rounding the credit first would change the charge.

**Given:** `currentAmountMinorUnits = 100000`, `newAmountMinorUnits = 5000000`,
`currentInterval = "monthly"`, `daysRemaining = 1`

**Trace**

| Step | Calculation | Value |
|---|---|---|
| 4 | `100000 / 30` | `dailyRate = 3333.333…` |
| 5 | `3333.333… × 1` | `fullPrecisionCredit = 3333.333…` |
| 6 | `5000000 − 3333.333…` | `fullPrecisionCharge = 4996666.666…` |
| 7 | round once | `proratedChargeMinorUnits = 4996667` |
| 8 | credit rounded for display | `creditMinorUnits = 3333` |

**Expected output:** `creditMinorUnits = 3333`, `proratedChargeMinorUnits = 4996667`.

**The counterfactual.** Had step 6 used the *rounded* credit:
`5000000 − 3333 = 4996667`. Identical again — `Math.round` on `x` and on `N − x`
commute whenever `x` has a fractional part other than exactly `0.5`.

So I searched for the failing shape analytically rather than guessing. The charge is
wrong-by-one under the bad ordering exactly when the fractional part of
`fullPrecisionCredit` is **greater than 0.5**, because then the credit rounds *up* and
the charge, computed from the rounded credit, rounds *down* too aggressively.

`dailyRate = 100000/30 = 3333.333…`; multiplying by 2 gives `6666.666…` (fraction
0.667, above 0.5):

**Given:** `currentAmountMinorUnits = 100000`, `daysRemaining = 2`

| Step | Correct (round last only) | Wrong (round credit first) |
|---|---|---|
| 5 | credit = `6666.666…` | credit = `6667` |
| 6 | `5000000 − 6666.666… = 4993333.333…` | `5000000 − 6667 = 4993333` |
| 7 | round → **`4993333`** | (already whole) → `4993333` |
| 8 | displayed credit = `6667` | displayed credit = `6667` |

Still equal. `N − x` and `round(N − x)` are symmetric, so **for any whole-number `N`,
rounding the credit first and rounding the charge last give the same charge.** The two
orderings only diverge when the subtraction is not the last operation before rounding —
that is, when something downstream re-derives the credit and re-subtracts.

That is what happens in the real system, and it is why this matters:

**The failure mode is in the caller, not the function.** The caller stores only
`creditMinorUnits` (rounded) in the payment log and later re-derives the charge as
`newAmount − storedCredit`. `5000000 − 6667 = 4993333` happens to match here, but that is
luck. Trying `currentAmount = 250000`, `daysRemaining = 1`: credit = `8333.333…`, rounds
to `8333`; charge = `5000000 − 8333.333… = 4991666.666…`, rounds to `4991667`;
re-derived as `5000000 − 8333 = 4991667`. Equal again.

**No within-function counterexample exists.** With `newAmountMinorUnits` a whole number
of kobo, the ordering of the two roundings does not change the charge, and I am not
going to manufacture a difference to make this trace look more productive than it is.
Rule 7's force in this function is elsewhere: (a) `fullPrecisionCredit` is returned, so
callers need not re-derive it, (b) `creditMinorUnits` is documented as a display value,
and (c) the clamp at zero in step 7 cannot be defeated by a rounded credit. A caller
that re-derives from the rounded credit, or rounds a percentage twice, does break — but
that is outside this function.

### Input 4 — EDGE PROBE. Zero days remaining, and the zero floor

**Given:** `daysRemaining = 0`

| Step | Calculation | Value |
|---|---|---|
| 5 | `dailyRate × 0` | `fullPrecisionCredit = 0` |
| 6 | `5000000 − 0` | `fullPrecisionCharge = 5000000` |
| 7 | `> 0`, round | `proratedChargeMinorUnits = 5000000` |

**Expected output:** credit `0`, charge `5000000` — the user pays full yearly price
because no unused days exist to credit. Correct: upgrade on the very last day of a
monthly period.

**The floor, probed separately:** with `newAmountMinorUnits = 100000` and
`currentAmountMinorUnits = 500000`, `daysRemaining = 30` (the whole month unused):
credit = `500000` exactly, `100000 − 500000 = −400000`, which is `≤ 0`, so step 7
returns `0`. The user is never charged a negative amount; they are charged nothing
and the "upgrade" is free. That floor is what stops a pathological input from
becoming a refund or a credit balance.

---

## Trace vs. execution

| # | Category | Predicted `creditMinorUnits` | Predicted `proratedChargeMinorUnits` | Executed | Agree? |
|---|---|---|---|---|---|
| 1 | normal (18 days) | 300000 | 4700000 | same | ✅ |
| 2 | edge (7 days) | 116667 | 4883333 | same | ✅ |
| 3a | invalid (31 days) | — | — | threw `RangeError: daysRemaining must be between 0 and 30; got 31` | ✅ |
| 3b | edge probe (`currentAmount = 100000`, 1 day — see Input 3b) | 3333 | 4996667 | same | ✅ |
| 4 | edge probe (0 days) | 0 | 5000000 | same | ✅ |
| 4b | zero-floor probe | 500000 | 0 | same | ✅ |

**Discrepancies found: none in the final pseudocode. Three in my reasoning.**

0. **The summary table above mixed two inputs.** Row 3b originally read "2 days → credit
   6667, charge 4993333". Those are correct for the `currentAmountMinorUnits = 100000`
   probe in Input 3b and wrong for the `monthly = 500000` plan every other row uses. The
   monthly plan with 2 days remaining gives credit `33333`, charge `4966667`; the
   `100000` probe gives `3333`, `4996667`. Each row now states its input. This is the
   failure mode the others were not: a plausible number that was quietly about a
   different plan.
1. **My first hand-trace of Input 3b predicted a one-kobo difference between rounding the
   credit first and rounding last. There is none.** For whole-number `N`, `round(N − x)`
   and `N − round(x)` agree whenever the fraction of `x` is not exactly `0.5`. I had
   asserted a difference without constructing one. The fabricated proof is replaced by
   the analysis above.
2. **The important property of this function is not the rounding order.** It is that
   `fullPrecisionCredit` is returned, so no caller re-derives a credit from a rounded
   number, and `creditMinorUnits` is labelled a display value in the type it flows into
   (`ProrationBreakdown` in `types/payment.ts` carries all three, so the log records the
   full-precision figure alongside the rounded one). That is why the
   worked example in the PRD and the executed value agree to the last kobo.

**One real fragility the trace surfaced, worth flagging as a review comment rather
than a fix:** step 1 is `interval === "monthly" ? 30 : 365`. A caller that passes
`"Monthly"`, `"MONTHLY"` or `undefined` — all reachable from a database column typed
as a bare `String` in `prisma/schema.prisma` — silently gets 365-day maths. There is no
`FAILS WHEN` entry for that, because the code cannot detect it. The type system claims
`Interval` is a two-value union, but the database does not enforce it.
