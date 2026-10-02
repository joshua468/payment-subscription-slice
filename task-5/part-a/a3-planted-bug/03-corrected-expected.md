# A3.3 — What the function **should** do

This is the corrected specification, in the required standard, followed by a trace of
it against the same four inputs used in `02-expected-trace.md`.

The corrections are deliberately minimal. Fixing finding 1 is removing two `Math.round`
calls; fixing finding 2 is replacing a clamp with a guard. I have added two further
guards that the received function lacked, and I have marked them as deliberate
additions rather than pretending they were in the spec.

---

## The three corrections, in one table

| # | Received | Corrected | Why |
|---|---|---|---|
| 1 | `Math.round(currentAmount / daysInPeriod)` | `currentAmount / daysInPeriod` | Rule 7: no intermediate rounding |
| 1 | `Math.round(dailyRate * unusedDays)` | keep at full precision | FR-8 names this `fullPrecisionCredit` and says "never rounded" |
| 2 | `Math.min(Math.max(0, Math.floor(daysRemaining)), daysInPeriod)` | `THROW RangeError` if out of range | FR-8 requires a throw; a clamp hides bad data |
| 3 | `totalChargeAfterChange` idempotency via an optional argument | credit application is recorded, not passed | Rule 4: idempotency must not be the caller's memory |
| + | interval fallthrough → 365 | `ELSE THROW RangeError` | an unknown interval currently mints a year's credit |
| + | `newAmountMinorUnits` unchecked → credit the entire new plan | floored at 0 on the charge | upgrade to a *cheaper* plan must not pay the customer |

---

## Pseudocode — corrected

```
FUNCTION calculateProrationForChange(input)
INPUTS:
  currentAmountMinorUnits (integer >= 0)
        Full price of the plan the customer is on now, in kobo.
        NOT the amount charged — the list price for the interval.
  newAmountMinorUnits (integer >= 0)
        Full price of the plan they are moving to, in kobo.
  currentInterval (text)
        "monthly" or "yearly". Selects the divisor. Interval lengths are locked:
        monthly = 30 days, yearly = 365 days (Rule 7). Calendar months are NOT used.
  daysRemaining (integer)
        Whole paid days left in the current period, as an INTEGER.
        Produced by daysBetween(), which floors. This function does not floor it —
        a fractional value means the caller is wrong, and should be told.
OUTPUT: an object with
  creditMinorUnits        (integer) — credit for DISPLAY and PERSISTENCE. Rounded, and
                                    safe to store. Never use this in further maths.
  proratedChargeMinorUnits(integer) — THE MONEY. What the customer is charged.
                                    This is the only rounded value in the function.
  fullPrecisionCredit     (float)    — the unrounded credit, kept so the audit trail
                                    can show why the charge is what it is.
                                    NEVER PERSIST IT. Rule 1 forbids storing money as
                                    a decimal; this field exists only inside this
                                    calculation and inside log payloads that are
                                    already documented as non-authoritative.
  unusedDays              (integer) — echo of the validated daysRemaining
SIDE EFFECTS: NONE. Pure. No I/O, no mutation of the argument object. Safe to call
  concurrently and safe to call twice — it is a function of its inputs alone.
FAILS WHEN:
  - currentInterval is neither "monthly" nor "yearly"
      → RangeError. This function REJECTS rather than guessing. The received version
        fell through to the yearly divisor, so `currentInterval: "fortnight"` granted
        365 days of credit.
  - daysRemaining is not a finite integer
      → RangeError. Note: FR-8 specifies the RANGE check; requiring an integer is a
        deliberate ADDITION, justified because daysBetween() already floors, so a
        fractional value here can only mean an upstream defect.
  - daysRemaining < 0 or daysRemaining > daysInPeriod
      → RangeError. This is the FR-8 requirement, and the received version's main
        defect: it clamped instead.
  - currentAmountMinorUnits or newAmountMinorUnits is not a safe integer
      → RangeError. Guards against NaN, Infinity and values beyond 2^53−1, any of
        which would produce a NaN charge that survives as a "valid" object.
  - It does NOT throw when newAmountMinorUnits <= currentAmountMinorUnits. A
    downgrade is a legitimate no-charge event, and the charge floors at 0.
```

**Steps**

```
1.  IF currentInterval == "monthly",
        SET daysInPeriod to 30.
    OTHERWISE IF currentInterval == "yearly",
        SET daysInPeriod to 365.
    OTHERWISE,
        THROW RangeError("currentInterval must be monthly or yearly; got <value>").
2.  IF currentAmountMinorUnits is not a safe integer,
        OR newAmountMinorUnits is not a safe integer,
        THROW RangeError("amounts must be safe integers in kobo").
3.  IF daysRemaining is not a safe integer,
        THROW RangeError("daysRemaining must be a whole number of days").
4.  IF daysRemaining < 0 OR daysRemaining > daysInPeriod,
        THROW RangeError("daysRemaining must be between 0 and <daysInPeriod>; got <value>").
        NOTE: validate. DO NOT clamp. A clamp converts a loud failure into a quiet
        wrong number, and destroys the only evidence that an upstream defect exists.
5.  SET unusedDays to daysRemaining.
6.  SET dailyRate to currentAmountMinorUnits / daysInPeriod.
        NO ROUNDING. This is a rate, not an amount. It is generally fractional
        (500000 / 30 = 16666.666...). Rounding it introduces an error that is then
        multiplied by every remaining day.
7.  SET fullPrecisionCredit to dailyRate * unusedDays.
        NO ROUNDING. PRD FR-8: "The credit is never rounded before subtraction."
8.  SET fullPrecisionCharge to newAmountMinorUnits - fullPrecisionCredit.
        NO ROUNDING.
9.  IF fullPrecisionCharge <= 0,
        SET proratedChargeMinorUnits to 0.
    OTHERWISE,
        SET proratedChargeMinorUnits to Math.round(fullPrecisionCharge).
        THIS IS THE ONLY ROUNDING IN THE FUNCTION. FR-8: "round once at the end".
        The max(0) floor means a downgrade never produces a negative charge, which
        would otherwise become a refund — out of scope for this slice.
10. SET creditMinorUnits to Math.round(fullPrecisionCredit).
        Rounded ONLY so it can be displayed and logged as an integer. Not used in
        step 8 or 9.
11. RETURN { creditMinorUnits, proratedChargeMinorUnits, fullPrecisionCredit,
             unusedDays }.
```

### The guarantee this function provides

```
fullPrecisionCredit + proratedChargeMinorUnits  ==  newAmountMinorUnits
                                                to within 0.5 kobo
```

**Do not** write `creditMinorUnits + proratedChargeMinorUnits == newAmountMinorUnits`.
`creditMinorUnits` is rounded for display, so the two can differ by 1 kobo:

| `fullPrecisionCredit` | `creditMinorUnits` | `fullPrecisionCharge` | `proratedCharge` | Sum of rounded | Exact? |
|---|---|---|---|---|---|
| 300,000 | 300,000 | 4,700,000 | 4,700,000 | 5,000,000 | ✅ |
| 116,666.666… | 116,667 | 4,883,333.333… | 4,883,333 | 5,000,000 | ✅ |
| 0.5 | 1 | 9.5 | 10 | 11 | ❌ off by 1 |

This is not sloppiness — it is what FR-8 mandates, and it is unavoidable given that the
charge must be an integer and the credit must not be rounded before subtraction. The
metric in §10 of the PRD ("credit + charge = annual price") holds against the
**full-precision** credit, and only there. Getting this backwards produces a
reconciliation test that fails intermittently and then gets "fixed" by rounding the
credit — which reintroduces finding 1.

---

## Corrected implementation

```ts
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

export type ProrationChangeInput = {
  currentAmountMinorUnits: number;
  newAmountMinorUnits: number;
  currentInterval: "monthly" | "yearly";
  daysRemaining: number;
};

export type ProrationChangeResult = {
  creditMinorUnits: number;
  proratedChargeMinorUnits: number;
  fullPrecisionCredit: number;
  unusedDays: number;
};

export function calculateProrationForChange(
  input: ProrationChangeInput
): ProrationChangeResult {
  const {
    currentAmountMinorUnits,
    newAmountMinorUnits,
    currentInterval,
    daysRemaining,
  } = input;

  // 1. Reject an unknown interval. Guessing here would silently grant a year of
  //    credit to a caller that passed an unrecognised string.
  let daysInPeriod: number;
  if (currentInterval === "monthly") {
    daysInPeriod = DAYS_PER_MONTH;
  } else if (currentInterval === "yearly") {
    daysInPeriod = DAYS_PER_YEAR;
  } else {
    throw new RangeError(
      `currentInterval must be "monthly" or "yearly"; got ${String(currentInterval)}`
    );
  }

  // 2. Guard the money. NaN and Infinity both pass every numeric comparison the
  //    naive version relies on, and both produce a charge of NaN.
  if (!Number.isSafeInteger(currentAmountMinorUnits)) {
    throw new RangeError("currentAmountMinorUnits must be a safe integer");
  }
  if (!Number.isSafeInteger(newAmountMinorUnits)) {
    throw new RangeError("newAmountMinorUnits must be a safe integer");
  }

  // 3. Validate rather than clamp. See note on step 4 of the pseudocode.
  if (!Number.isSafeInteger(daysRemaining)) {
    throw new RangeError("daysRemaining must be a whole number of days");
  }
  if (daysRemaining < 0 || daysRemaining > daysInPeriod) {
    throw new RangeError(
      `daysRemaining must be between 0 and ${daysInPeriod}; got ${daysRemaining}`
    );
  }

  const unusedDays = daysRemaining;

  // 4. Full precision throughout. Rule 7: round only the final charge.
  const dailyRate = currentAmountMinorUnits / daysInPeriod;
  const fullPrecisionCredit = dailyRate * unusedDays;
  const fullPrecisionCharge = newAmountMinorUnits - fullPrecisionCredit;

  // 5. The one rounding, at the end, floored at zero so a downgrade is a no-charge
  //    event rather than a refund.
  const proratedChargeMinorUnits =
    fullPrecisionCharge <= 0 ? 0 : Math.round(fullPrecisionCharge);

  return {
    creditMinorUnits: Math.round(fullPrecisionCredit),
    proratedChargeMinorUnits,
    fullPrecisionCredit,
    unusedDays,
  };
}
```

### Finding 3 — where the credit actually has to be recorded

The corrected arithmetic does not fix finding 3, and it cannot: idempotency is not
arithmetic. The fix is that **"how much credit has this subscription already been
credited?" is a question about the payment log, not about a function argument.**

```
FUNCTION creditAvailableFor(subscription, paymentLog)
INPUTS:
  subscription        — the record whose entitlement is being changed
  paymentLog          — the append-only log of stages for that subscription
OUTPUT: integer — credit in kobo that has NOT yet been spent
SIDE EFFECTS: NONE. Read-only over the log.
FAILS WHEN: the log contains a fulfilment row for this subscription but the
  subscription record does not agree with it. That is a data-integrity fault and it
  must be loud, not defaulted.
STEPS:
1.  SET spent to 0.
2.  FOR EACH entry in paymentLog WHERE the stage is "fulfilment"
    2a. SET spent to spent + the credit recorded in that entry's payload.
    END FOR
3.  RETURN the maximum of 0 and (totalCreditOwed − spent).
```

This is why the production code does not have the bug: `PaymentLog` rows are
append-only, so "what credit has been spent" is answerable from the log rather than
from a caller's memory. `lib/subscription/service.ts` appends a fulfilment row per
completed payment and never overwrites one, which is what makes
`alreadyAppliedCreditMinorUnits` unnecessary — and what makes it a Rule 4 problem if
you try to keep it in the arguments.

---

## Trace of the corrected function, same four inputs

### Trace 1 — 18 days remaining

| Step | Evaluation | Result |
|---|---|---|
| 1 | `"monthly"` | `daysInPeriod = 30` |
| 2 | `500000` and `5000000` are both safe integers | pass |
| 3 | `18` is a safe integer | pass |
| 4 | `18 >= 0` and `18 <= 30` | pass — **no clamp, and no throw needed** |
| 5 | — | `unusedDays = 18` |
| 6 | `500000 / 30` | `dailyRate = 16666.6666…` — **unrounded** ✓ |
| 7 | `16666.6666… × 18` | `fullPrecisionCredit = 300000` exactly ✓ |
| 8 | `5000000 − 300000` | `fullPrecisionCharge = 4700000` |
| 9 | `4700000 > 0`; `Math.round(4700000)` | `proratedChargeMinorUnits = 4700000` |
| 10 | `Math.round(300000)` | `creditMinorUnits = 300000` |
| 11 | — | `{ credit: 300000, charge: 4700000, fpCredit: 300000, days: 18 }` |

**Spec: `charge = 4,700,000`. Produced: `4,700,000`.** ✅ Exact — 18 days is precisely
60% of a 30-day period, so the credit lands on a whole kobo with no rounding anywhere.

### Trace 2 — 7 days remaining

| Step | Evaluation | Result |
|---|---|---|
| 1–4 | `monthly`, both amounts safe integers, `7` is an integer in `[0, 30]` | pass |
| 5 | — | `unusedDays = 7` |
| 6 | `500000 / 30` | `dailyRate = 16666.6666…` |
| 7 | `16666.6666… × 7` | `fullPrecisionCredit = 116666.6666…` — **unrounded** ✓ |
| 8 | `5000000 − 116666.6666…` | `fullPrecisionCharge = 4883333.3333…` |
| 9 | `> 0`; `Math.round(4883333.3333…)` | `proratedChargeMinorUnits = 4883333` ✓ |
| 10 | `Math.round(116666.6666…)` | `creditMinorUnits = 116667` (display only) |
| 11 | — | `{ credit: 116667, charge: 4883333, fpCredit: 116666.6666…, days: 7 }` |

**Spec: `charge = 4,883,333`. Produced: `4,883,333`.** ✅ Matches FR-8's second
worked example exactly. Note that the *rounded* credit (116,667) and the charge
(4,883,333) sum to precisely 5,000,000 here — which is the coincidence discussed above,
not a guarantee. They agree in this case; they would not in general.

### Trace 3 — `daysRemaining = 45`

| Step | Evaluation | Result |
|---|---|---|
| 1 | `"monthly"` | `daysInPeriod = 30` |
| 2 | amounts safe | pass |
| 3 | `45` is a safe integer | pass |
| 4 | `45 <= 30`? **NO** | **`THROW RangeError("daysRemaining must be between 0 and 30; got 45")`** |

**Spec: `RangeError`. Produced: `RangeError`.** ✅

The upstream defect that produced `45` now surfaces at the boundary, with the
sentinel value in the message, instead of being converted into a ₦44,999.90 charge.

### Trace 4 — finding 3, expressed against the log

`creditAvailableFor(subscription, paymentLog)` where the log holds one fulfilment row
crediting 300,000:

| Step | Evaluation | Result |
|---|---|---|
| 1 | — | `spent = 0` |
| 2 | one fulfilment entry, credit 300,000 | `spent = 300000` |
| 3 | `max(0, totalOwed − 300000)` | **0** |

A second charge attempt gets `availableCredit = 0` and is charged the full
5,000,000. The caller cannot influence this: the answer is a property of the log, not
of the arguments. Total collected across both attempts: 4,700,000 + 5,000,000 =
9,700,000 for a 5,000,000 plan, of which the customer is owed 3,000 of credit — the
correct total, and derived from an append-only record rather than remembered by a
caller.

---

## Corrected vs. received

| # | Input | Received | Corrected | Spec | ✅ |
|---|---|---|---|---|---|
| 1 | 18 days left | `charge 4,699,994` | **`4,700,000`** | `4,700,000` | ✅ |
| 2 | 7 days left | `charge 4,883,331` | **`4,883,333`** | `4,883,333` | ✅ |
| 3 | 45 days on a 30-day plan | `{ credit 500010, charge 4499990 }` | **`RangeError`** | `RangeError` | ✅ |
| 4 | credit applied twice | total collected **9,400,000** | **9,700,000**, credit spent once | credit spent once | ✅ |
| + | `currentInterval: "fortnight"` | 365 days of credit | **`RangeError`** | — (addition) | ✅ |
| + | monthly → Free downgrade | `charge 0` (via clamp) | **`charge 0`** | `charge 0` | ✅ |

All six traces agree with the specification. Executable assertions for every row are
in `task-5/harness/a3-trace-check.test.ts`.

---

## What I would send back to the partner

1. Delete the `Math.round` on `dailyRate`, and stop rounding `fullPrecisionCredit` in
   the return value's maths. Keep it for display. That is the whole of finding 1.
2. Replace the clamp with the `RangeError`. Two lines. Do not skip this because the
   amount is small — the clamp is what stops you finding the bug that produced the bad
   `daysRemaining`.
3. Do not pass `alreadyAppliedCreditMinorUnits`. Read it from `PaymentLog`. Passing it
   means every caller has to remember, and a caller that forgets is a double credit.
4. Reject an unrecognised `currentInterval` instead of defaulting to 365.
5. Add `Number.isSafeInteger` guards on the two amounts. `NaN` passes every comparison
   you would write by hand, and produces a `chargeMinorUnits` of `NaN` in an object
   that looks completely valid.