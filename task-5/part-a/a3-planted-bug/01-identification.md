# A3.1 — Bug Identification & Analysis

**Function under review:** `calculateProrationForChange` (and helper `totalChargeAfterChange`) in `task-5/part-a/a3-planted-bug/planted-bug.ts`.
**Approach:** The Two-Pseudocode Method — writing one pseudocode block for what the function *actually does*, and a second pseudocode block for what it *should do*. The difference between the two highlights the defects.
**Verdict:** The function contains three distinct defects: premature rounding of intermediate daily rates, silent clamping of invalid inputs, and unverified idempotency assumptions.

---

## Method

Read the file for intent rather than for bugs: write down what it is supposed to do,
then compare. The intent, per `Doc/Agents.md` rule 7, is:

> Proration is calculated with full floating-point precision at each step. Round only
> the final charge amount before submitting to Flutterwave.

So the expected algorithm is: **one** rounding, on the final charge, and nowhere else.
That gives me a single concrete question to ask of every line: *is this a rounding? If
so, is it the only one, and is it the last one?*

Then I ran the two worked examples from the PRD (`Doc/PRD.md` FR-8) against it by
hand, before running any code — so that a failing test would tell me something I did
not already believe.

---

## Finding 1 — the intermediate daily rate is rounded (Rule 7 violation)

**Location:** `planted-bug.ts`, the line

```ts
const dailyRate = Math.round(currentAmountMinorUnits / daysInPeriod);
```

**What it should be:**

```ts
const dailyRate = currentAmountMinorUnits / daysInPeriod;
```

**Why it is wrong.** `Math.round` on the daily rate introduces a *per-day* error that
is then multiplied by every remaining day. The credit becomes
`round(round(amount ÷ days) × daysRemaining)` instead of `round(amount ÷ days ×
daysRemaining)`. These are not equal, and the outer `Math.round` on the credit does
not repair it — it locks the error in.

The comment above the line —

```ts
// The daily value of what the user has already paid for.
const dailyRate = Math.round(currentAmountMinorUnits / daysInPeriod);
```

with `// Rounded, because money is rounded.` — is what makes this survive review. The
comment is a *reasonable-sounding false statement*: it is true that money is rounded,
and false that this is where you round. A reviewer skimming for arithmetic errors
reads the comment, agrees with it, and moves on. That is not a failure of attention; it
is a failure of the code to be honest about itself.

**How wrong, quantitatively.** On the locked catalog, `Math.round` moves the daily
rate by at most half a kobo, and that error is multiplied by up to `daysInPeriod`:

| Current plan | Daily rate (exact) | Daily rate (rounded) | Error/day | Max days | Max total error |
|---|---|---|---|---|---|
| Pro monthly (500000 kobo ÷ 30) | 16,666.666… | 16,667 | +0.333 kobo | 30 | **10 kobo** (₦0.10) |
| Pro yearly (5,000,000 kobo ÷ 365) | 13,698.630… | 13,699 | +0.370 kobo | 365 | **135 kobo** (₦1.35) |

So: **the customer is always under-charged, by at most ₦1.35 on the locked catalog.**
I want to be precise that this is a *small* bug, and I am not going to inflate it. It
does not threaten anyone financially.

It is still a defect, for two reasons that have nothing to do with magnitude:

1. **It is a violation of a locked rule, not a matter of taste.** `Doc/Agents.md` rule 7
   is on the "a task that breaks any of these fails" list. `Doc/PRD.md` FR-8 spells out
   the same requirement and then gives two worked examples specifically so that an
   implementer can check their arithmetic against something concrete. The function
   misses both.
2. **The quoted number and the charged number disagree.** The plans page shows a
   proration estimate computed by the real `lib/proration/calculate.ts`; checkout
   charges what this function returns. If those two numbers differ, the customer was
   quoted a figure we did not charge, which is precisely the kind of thing that is
   embarrassing in a dispute and trivial to prevent.

Worth noting for calibration: the error is **always in the customer's favour** (charge
is always ≤ the specified charge). A reviewer skimming for "does this overcharge
anyone" would correctly conclude that it does not, and would miss the defect entirely.

---

## Finding 2 — an invalid input is silently clamped instead of rejected

**Location:** the `unusedDays` line

```ts
const unusedDays = Math.min(Math.max(0, Math.floor(daysRemaining)), daysInPeriod);
```

**What it should be:** validate and throw. `Doc/PRD.md` FR-8 requires
`daysRemaining ∈ [0, daysInPeriod]` and mandates a `RangeError` otherwise — the same
function in `lib/proration/calculate.ts` already does exactly that.

**Why it is wrong.** Clamping is not validation. It converts a loud failure into a
quiet wrong number.

If `daysRemaining` arrives as `45` for a 30-day monthly plan, this function does not
complain — it clamps to 30, computes a full-period credit, and returns a charge of
₦44,999.90 that looks entirely reasonable. Every downstream check passes: the credit
plus the charge still reconciles to the new plan price, the total is positive, and the
number is within a plausible range of what a monthly-to-yearly upgrade should cost.
The one piece of evidence that something upstream is broken has been destroyed at the
boundary where it should have been loudest.

**Why this is the most important of the three.** Its magnitude is smaller than finding
1's — 10 kobo on the clamped case. But it amplifies other defects: it takes a data bug
somewhere else in the system (a `periodEnd` computed in the wrong timezone, a day count
anchored to the wrong date, a stale cached value from the plans page) and turns it into
a wrong money amount that looks right. Its value is in not throwing. Remove the clamp,
restore the `RangeError`, and the upstream bug stays a bug instead of becoming a charge.

---

## Finding 3 — "safe to call twice" is not enforced by the function

**Location:** `totalChargeAfterChange`

```ts
export function totalChargeAfterChange(input: {
  existingChargeMinorUnits: number;
  creditMinorUnits: number;
  alreadyAppliedCreditMinorUnits?: number;
  now?: number;
}): number {
  const {
    existingChargeMinorUnits,
    creditMinorUnits,
    alreadyAppliedCreditMinorUnits = 0,
  } = input;
  const availableCredit = Math.max(
    0,
    creditMinorUnits - alreadyAppliedCreditMinorUnits
  );
  return Math.max(0, existingChargeMinorUnits - availableCredit);
}
```

**The claim:** the docstring says *"in a way that is safe to call twice."*

**The reality:** idempotency here is entirely the caller's responsibility. The
function subtracts `credit - alreadyApplied`, where `alreadyApplied` is an optional
argument that **defaults to zero**. A caller that omits it gets the full credit
subtracted, every time. There is no state, no ledger, and no guard inside this
function — so the "safe to call twice" property exists only for a caller that
correctly remembers and passes the previous value.

**Why it matters.** This is `Doc/Agents.md` rule 4 (never charge twice for the same
payment intent) expressed as a default value of `0`. A credit that can be spent twice
is an over-collection risk on the upgrade path, and it is the kind of thing where the
fix is not "add a parameter" but "do not keep idempotency state in the arguments".

Note also the unused `now?: number` parameter. An injected clock that is never read is
either dead code or a leftover from a version that did use it — and unused parameters
in a signature are how you end up with a function nobody is sure how to call.

---

## Verdict

**Do not ship. Three defects, two of them structural.**

| # | Defect | Type | Severity | Silent? |
|---|---|---|---|---|
| 1 | `Math.round` on the daily rate | Arithmetic / Rule 7 | Low — ≤ ₦1.35 | Yes |
| 2 | `daysRemaining` clamped instead of validated | Input handling / FR-8 | **High as an amplifier** | Yes |
| 3 | Idempotency delegated to an optional argument | Design / Rule 4 | **High** | Yes |

All three defects fail silently. Nothing throws, nothing logs, and every output stays in
a plausible range. A test suite checking "is the total positive and does it reconcile?"
passes all three.

**Fix:** findings 1 and 2 are one-line changes each, shown in
`03-corrected-expected.md`. Finding 3 needs the credit application moved out of
argument-passing and into an append-only record — which the real implementation in
`lib/proration/calculate.ts` and the `PaymentLog` already do, and which is why the
production code does not have this problem.

---

*Continue: `02-expected-trace.md` traces the buggy code against the spec;
`03-corrected-expected.md` gives the corrected function and proves it against the
same inputs.*