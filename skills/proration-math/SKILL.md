---
name: proration-math
description: Use when calculating, implementing, debugging, or testing plan upgrade/downgrade proration. Covers the full-precision algorithm, 30/365-day interval locks, worked examples, and edge cases. Trigger keywords: proration, prorated charge, credit, upgrade cost, daily rate, days remaining.
---

# Proration Math Skill

## Core rules

1. **Monthly = 30 days, yearly = 365 days** — locked. Never use calendar months.
2. **All amounts are kobo (minor units).** ₦5,000 = 500000; ₦50,000 = 5000000.
3. **Full floating-point precision** at every intermediate step.
4. **Round only once** — at the final charge amount, via `Math.round`.
5. Floor the final charge at 0 (never negative).

## Algorithm

```
dailyRate      = currentAmount / daysInPeriod       (full precision, never rounded)
daysRemaining  = daysBetween(periodStart, periodEnd) (whole days, floor)
credit         = dailyRate × daysRemaining            (fullPrecisionCredit, never rounded)
proratedCharge = Math.max(newAmount - credit, 0)     (rounded once here)
```

`daysBetween(from, to)` = `Math.floor((to - from) / MS_PER_DAY)` where
`MS_PER_DAY = 86400000`.

Interval constants:
```
DAYS_PER_MONTH = 30
DAYS_PER_YEAR  = 365
MS_PER_DAY     = 86400000
```

## Worked examples

### Upgrade day 12 of monthly → yearly

- Current: 500000 kobo (₦5,000), 30-day period.
- New: 5000000 kobo (₦50,000), 365-day period.
- Days remaining: 30 − 12 = 18.
- Daily rate: 500000 / 30 = 16666.666...
- Credit: 16666.666... × 18 = 300000 (₦3,000) — exact.
- Charge: 5000000 − 300000 = 4700000 (₦47,000).

### Upgrade with 7 days left

- Days remaining: 7.
- Credit: 500000 / 30 × 7 = 116666.666... (never rounded).
- Charge: 5000000 − 116666.666... = 4883333.333... → rounded to **4883333** (₦48,333.33).

### Edge: 0 days remaining

- credit = 0.
- charge = full newAmount (rounded, which is already an integer).

### Edge: full period remaining

- credit = full currentAmount.
- charge = newAmount − currentAmount.

### Edge: downgrade (yearly → monthly)

- **No charge, no checkout.** The server sets `pending_downgrade` and defers the flip
  to `applyDueTransitions` at period end. No proration math is run; the user keeps
  their paid yearly access until period end.

## Output types

```ts
interface ProrationResult {
  daysRemaining: number;
  dailyRate: number;
  fullPrecisionCredit: number;
  proratedCharge: number; // Math.max(newAmount - credit, 0), rounded once
  currentAmountMinorUnits: number;
  newAmountMinorUnits: number;
}
```

The `rawWebhookPayload` initiation row stores the full `ProrationResult` breakdown
for audit.

## Validation

- `daysRemaining` must be ∈ [0, daysInPeriod]. Throw `RangeError` otherwise.
- `dailyRate` is never explicitly validated but is derived; if `daysInPeriod` is 0
  (impossible with 30/365 locks) it would throw — acceptable.

## Test checklist

- [ ] Happy path: upgrade on day N of 30-day monthly, verify charge.
- [ ] Edge: 0 days remaining → full new-amount charge.
- [ ] Edge: full period → credit = current amount.
- [ ] Non-round credit (7 days left) → charge correctly rounded once.
- [ ] Credit never rounded before subtraction (verify `fullPrecisionCredit`).
- [ ] Downgrade sets `pending_downgrade`, no checkout, no charge.
- [ ] Days remaining out of range → `RangeError`.
- [ ] `daysBetween` uses whole-day floor (not ceiling).