# A3.2 — Expected trace of the function **as received**

This document does three things: restates the partner's function in the required
pseudocode standard (so the defect is visible in the abstraction, not just in the
source), hand-traces it on the PRD's own worked examples, and states what each trace
*should* have produced.

The point of tracing before running is that a failing test should tell me something I
did not already believe. Everything below was worked out by hand from
`Doc/PRD.md` FR-8, and only then checked against execution
(`task-5/harness/a3-trace-check.test.ts`).

---

## Pseudocode — the function as received, unmodified

```
FUNCTION calculateProrationForChange(input)
INPUTS:
  currentAmountMinorUnits (integer)  — full price of the current plan, in kobo
  newAmountMinorUnits     (integer)  — full price of the target plan, in kobo
  currentInterval         (text)     — "monthly" or "yearly"; selects the divisor
  daysRemaining           (integer)  — whole paid days left in the current period
  now                     (integer)  — current time in ms; accepted and never used
OUTPUT: an object with
  creditMinorUnits (integer) — the credit applied against the new plan
  chargeMinorUnits (integer) — what the customer is charged
  unusedDays       (integer) — the days the credit was computed over
SIDE EFFECTS: NONE. Pure function, no I/O, no mutation of its argument.
FAILS WHEN:
  - newAmountMinorUnits is zero or negative → RangeError
  - daysRemaining is outside [0, daysInPeriod] → NOTHING. It is silently clamped.
    THIS IS THE DEFECT. The PRD requires a RangeError here (FR-8).
  - daysRemaining is fractional → NOTHING. It is silently floored.
  - currentInterval is neither "monthly" nor "yearly" → NOTHING. The ternary falls
    through to the yearly divisor. THIS IS ALSO A DEFECT: "fortnight" would be
    treated as 365 days, giving a user a full year's credit instead of none.
```

**Steps as received**

```
1.  SET daysInPeriod to 30 IF currentInterval == "monthly", OTHERWISE 365.
2.  SET unusedDays to the smaller of the larger of 0 and the floor of daysRemaining,
    and daysInPeriod.
3.  IF newAmountMinorUnits <= 0, THROW RangeError.
4.  SET dailyRate to Math.round(currentAmountMinorUnits / daysInPeriod).
5.  SET creditMinorUnits to Math.round(dailyRate * unusedDays).
6.  SET chargeMinorUnits to Math.round(newAmountMinorUnits - creditMinorUnits).
7.  RETURN { creditMinorUnits, chargeMinorUnits, unusedDays }.
```

### Marked against the standard

| # | Step | Reads into | Defect? |
|---|---|---|---|
| 1 | `IF currentInterval == "monthly", OTHERWISE 365` | a two-way branch written as a fallthrough — no `ELSE` | **Yes.** An unrecognised interval silently gets the yearly divisor. `ELSE IF` + `THROW` is required. |
| 2 | `SET unusedDays to the smaller of…` | a clamp in place of a guard | **Yes.** The PRD requires `THROW RangeError`. |
| 3 | `IF newAmountMinorUnits <= 0, THROW RangeError` | — | No. Correct, and correctly placed *before* the arithmetic. |
| 4 | `SET dailyRate to Math.round(amount / daysInPeriod)` | **rounding an intermediate** | **Yes.** Rule 7. The PRD's formula is `amount ÷ daysInPeriod`, unrounded. |
| 5 | `SET creditMinorUnits to Math.round(dailyRate * unusedDays)` | **rounding an intermediate** | **Yes.** Rule 7. The PRD names this value `fullPrecisionCredit` and says it is "never rounded". |
| 6 | `SET chargeMinorUnits to Math.round(newAmount − creditMinorUnits)` | rounding the final charge | **No. This is the one rounding that is allowed**, and the PRD requires it. |
| 7 | `RETURN { … }` | — | No. |

The useful observation is that **six of seven steps contain exactly one rounding that
the rules permit (step 6) and two that they forbid (steps 4 and 5).** The function is
almost right, and the wrong parts sit next to a comment explaining why they are
supposed to be that way.

---

## Trace 1 — the PRD's first worked example

**Spec (FR-8, "upgrade day 12 of monthly ₦5,000 → yearly ₦50,000"):**

> 18 days remain → daily rate `500000/30 = 16,666.66...` → credit
> `16,666.66... × 18 = 300,000` kobo (₦3,000) → charge `4,700,000` kobo (₦47,000).

**Inputs:** `currentAmountMinorUnits = 500000`, `newAmountMinorUnits = 5000000`,
`currentInterval = "monthly"`, `daysRemaining = 18`

| Step | Evaluation | Result |
|---|---|---|
| 1 | `"monthly"` → 30 | `daysInPeriod = 30` |
| 2 | `floor(18) = 18`; `max(0, 18) = 18`; `min(18, 30) = 18` | `unusedDays = 18` ✓ |
| 3 | `5000000 <= 0`? no | pass |
| 4 | `500000 / 30 = 16666.6666…`; `Math.round(16666.6666…)` | `dailyRate = 16667` ✗ **+0.3333 kobo/day** |
| 5 | `16667 × 18 = 300006`; `Math.round(300006)` | `creditMinorUnits = 300006` ✗ **spec: 300000** |
| 6 | `5000000 − 300006 = 4699994`; `Math.round(4699994)` | `chargeMinorUnits = 4699994` |
| 7 | — | `{ 300006, 4699994, 18 }` |

**Expected per spec:** `credit = 300000`, `charge = 4700000`
**Produced:** `credit = 300006`, `charge = 4699994`

| Quantity | Spec | Produced | Deviation |
|---|---|---|---|
| credit | 300,000 (₦3,000.00) | 300,006 | **+6 kobo** (₦0.06) |
| charge | 4,700,000 (₦47,000.00) | 4,699,994 | **−6 kobo** (₦0.06) |

The `+6` is exactly `0.3333 × 18`: the per-day rounding error from step 4, multiplied by
18 days. Step 5's own `Math.round` changes nothing here, because `300006` is already an
integer — which is precisely what makes the bug hard to see. There is no obviously
"rounded" value in the output to question.

**Direction: under-charge.** The customer pays ₦0.06 less than the contract specifies.

---

## Trace 2 — the PRD's second worked example, 7 days remaining

**Spec (FR-8, "upgrade with 7 days left"):**

> credit `= 500000/30 × 7 = 116,666.66...` kobo; charge `= 4,883,333.33...` → rounded
> to **4,883,333** kobo. The credit is never rounded before subtraction.

**Inputs:** `currentAmountMinorUnits = 500000`, `newAmountMinorUnits = 5000000`,
`currentInterval = "monthly"`, `daysRemaining = 7`

| Step | Evaluation | Result |
|---|---|---|
| 1 | monthly → 30 | `daysInPeriod = 30` |
| 2 | `min(max(0, 7), 30) = 7` | `unusedDays = 7` ✓ |
| 3 | `5000000 <= 0`? no | pass |
| 4 | `16666.6666…` → `Math.round` | `dailyRate = 16667` ✗ |
| 5 | `16667 × 7 = 116669`; already an integer | `creditMinorUnits = 116669` ✗ **spec: 116,666.666…** |
| 6 | `5000000 − 116669 = 4883331`; integer | `chargeMinorUnits = 4883331` |
| 7 | — | `{ 116669, 4883331, 7 }` |

**Expected per spec:** `charge = 4883333`
**Produced:** `charge = 4883331`

| Quantity | Spec | Produced | Deviation |
|---|---|---|---|
| credit (exact) | 116,666.666… | 116,669 | +2.333 kobo |
| charge | 4,883,333 (₦48,833.33) | 4,883,331 | **−2 kobo** (₦0.02) |

**This is the trace that proves finding 1 and exonerates step 5.** The spec's headline
instruction — "the credit is never rounded before subtraction" — is about *this*
example. It also happens that the buggy code's credit rounds to the same integer the
spec's charge is derived from, so `charge` differs by only 2 kobo. Had I only run
trace 1, I could have concluded the error was 6 kobo. Had I only run trace 2, I could
have concluded it was 2. Running both, and then the 45-day case below, is what tells
me the error *scales with `unusedDays`* — which is the signature of a per-day rate
error rather than a final-rounding error, and that is what actually identifies the
defect.

---

## Trace 3 — invalid input: `daysRemaining = 45` on a 30-day period

**Spec (FR-8):** "Validate `daysRemaining ∈ [0, daysInPeriod]` (throw `RangeError`
otherwise)."

**Inputs:** `currentAmountMinorUnits = 500000`, `newAmountMinorUnits = 5000000`,
`currentInterval = "monthly"`, `daysRemaining = 45`

| Step | Evaluation | Result |
|---|---|---|
| 1 | monthly → 30 | `daysInPeriod = 30` |
| 2 | `floor(45) = 45`; `max(0, 45) = 45`; `min(45, 30) = 30` | `unusedDays = 30` — **should have thrown** ✗ |
| 3 | `5000000 <= 0`? no | pass |
| 4 | `16666.666…` → `Math.round` | `dailyRate = 16667` |
| 5 | `16667 × 30 = 500010` | `creditMinorUnits = 500010` |
| 6 | `5000000 − 500010 = 4499990` | `chargeMinorUnits = 4499990` |
| 7 | — | `{ 500010, 4499990, 30 }` |

**Expected per spec:** `RangeError`, no return value.
**Produced:** a successful return of a ₦44,999.90 charge.

Note what a caller sees: a valid-looking object, a positive charge, and a charge that
is *within 5% of the correct answer*. There is no way for the caller to tell that its
input was rejected. The only signal that anything was wrong — the 45 itself — was
consumed inside the function. And the 45 almost certainly did not come from nowhere:
`periodEnd` computed in the wrong timezone, or days counted from the wrong anchor date,
produces exactly this, and would produce exactly this amount. **The clamp does not just
fail to catch the bug; it actively destroys the evidence of it.**

Also worth noting: even at the clamp boundary, the function still has finding 1 active,
so `500010` instead of `500000`. Two defects stacked in one trace.

---

## Trace 4 — `totalChargeAfterChange` called twice with the same arguments

**Inputs, first call:** `{ existingChargeMinorUnits: 5000000, creditMinorUnits: 300000 }`
(`alreadyAppliedCreditMinorUnits` omitted → defaults to `0`)

| Step | Evaluation | Result |
|---|---|---|
| — | destructure; `alreadyAppliedCreditMinorUnits = 0` | — |
| — | `availableCredit = max(0, 300000 − 0)` | `300000` |
| — | `return max(0, 5000000 − 300000)` | `4700000` |

**Inputs, second call: identical.**

| Step | Evaluation | Result |
|---|---|---|
| — | `alreadyAppliedCreditMinorUnits = 0` again | — |
| — | `availableCredit = max(0, 300000 − 0)` | `300000` |
| — | `return max(0, 5000000 − 300000)` | `4700000` |

Read as a *single* function, that is idempotent — the same arguments give the same
answer, which is what "safe to call twice" appears to promise.

**But read as its actual caller reads it — applying one credit to two charges:**

| Call | Arguments | Result | Credit actually taken |
|---|---|---|---|
| 1 | `{ existingCharge: 5000000, credit: 300000 }` | 4,700,000 | 300,000 |
| 2 | `{ existingCharge: 5000000, credit: 300000 }` | 4,700,000 | 300,000 **again** |
| | | **Total collected: 9,400,000** | **600,000** |

The user paid ₦94,000 for a plan that costs ₦50,000, and received ₦6,000 of credit
where they were entitled to ₦3,000. The function did not malfunction — it behaved
exactly as written, because nothing in it records that the credit was spent.

Passing `alreadyAppliedCreditMinorUnits: 300000` on the second call *does* fix it:
`availableCredit = max(0, 300000 − 300000) = 0` → the second charge stays at
5,000,000. That is the whole defect in one sentence — **the safety is opt-in, and the
default is the unsafe path.** A guard that must be remembered by every caller, and
whose absence is silent, is not a guard.

The unused `now?: number` parameter belongs to the same finding: it is declared,
accepted, defaulted, and never read, which means callers are being invited to pass
something that does nothing.

---

## Summary of what the traces established

| Trace | Input | Expected | Produced | Established |
|---|---|---|---|---|
| 1 | day 12, 18 days left | `charge 4,700,000` | `4,699,994` | error **−6**, and it scales with days |
| 2 | 7 days left | `charge 4,883,333` | `4,883,331` | error **−2**; confirms per-day, not final, rounding |
| 3 | 45 days on a 30-day plan | `RangeError` | `{ credit 500010, charge 4499990 }` | **silent clamp**, no error raised |
| 4 | credit applied twice | ≤ 5,000,000 total | **9,400,000** | credit **double-spent**, silently |

Errors 1 and 2 differ (6 vs 2) for the same code on different inputs. That variation is
the evidence: a final-rounding bug would give a bounded, input-independent discrepancy
near ±1 kobo. A discrepancy that **grows in proportion to `unusedDays`** can only come
from a per-day rate, which is exactly step 4. I would not have been able to name that
line from trace 1 alone.

Everything above is confirmed by execution in
`task-5/harness/a3-trace-check.test.ts`.

*Continue: `03-corrected-expected.md` — the corrected pseudocode and its trace against
the same four inputs.*