---
name: billing-ux-audit
description: Use when designing, reviewing, or auditing billing UI — status badges, error/empty states, dark mode, accessibility, copy correctness, and the no-dead-ends guarantee. Trigger keywords: billing page, plans page, checkout success, status badge, dark mode, accessibility, billing UI, empty state, error state, design review.
---

# Billing UX Audit Skill

## Purpose

Audit any billing-related page or component against the product's UX rules.
This skill catches: missing states, dead ends, misleading copy, accessibility
gaps, dark-mode failures, and design-language drift.

## Design language (source of truth: app/globals.css + existing components)

| Element            | Pattern                                                        |
| ------------------ | -------------------------------------------------------------- |
| Card surface       | `rounded-lg border border-zinc-200 bg-white`                   |
| Primary button     | `rounded-full bg-zinc-900 text-white px-4 py-2 text-sm`        |
| Secondary button   | `rounded-full border border-zinc-300 text-zinc-700 ...`        |
| Destructive button | `rounded-full bg-red-600 text-white ...`                       |
| Status badge       | `rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600`    |
| Empty state        | Dashed border container, neutral copy, CTA link                |
| Type               | Geist Sans (body) + Geist Mono (money/codes) via --font-sans   |
| Dark mode          | `prefers-color-scheme: dark` media query (NOT class toggle)    |
| Money formatting   | `Intl.NumberFormat` via `formatMinorUnits()` in lib/plans.ts   |

## Audit checklist

### 1. Status badge completeness
Every subscription status must render a badge with **text** (not color alone):

| Status               | Required label            |
| -------------------- | ------------------------- |
| `active`             | Active                    |
| `payment_pending`    | Payment pending           |
| `pending_downgrade`  | Downgrade scheduled       |
| `pending_cancellation` | Cancelling at period end |
| `cancelled`          | Cancelled                 |

- [ ] All five statuses have a corresponding badge label.
- [ ] Badge is rendered in all views that display subscription state.
- [ ] No status is communicated by color alone.

### 2. No dead-ends (Rule 8)
Every view in the payment flow must render a meaningful state:

- [ ] Billing page: no subscription → "Free" + empty state + CTA to plans.
- [ ] Billing page: active → plan info + actions.
- [ ] Billing page: payment pending → badge, no premature claim.
- [ ] Billing page: pending cancel/downgrade → badge + effective date + reason.
- [ ] Billing page: cancelled → badge + CTA to re-subscribe.
- [ ] Plans page: current plan → disabled selected button.
- [ ] Plans page: upgrade available → proration estimate + Choose button.
- [ ] Plans page: downgrade available → DowngradeButton (no charge).
- [ ] Success page: non-successful → "No payment made".
- [ ] Success page: polling → "Confirming your payment…".
- [ ] Success page: fulfilment → "You are all set".
- [ ] Success page: failure → "Payment not confirmed" + Retry/Support/Return.
- [ ] Success page: timeout → support message + return link.

### 3. UX copy correctness
- [ ] Success page **never** says "payment received" or "payment confirmed" — redirect alone does not confirm payment.
- [ ] Success page says "Confirming your payment…" while polling (honest).
- [ ] Cancellation shows the **exact date** access ends ("Access until {date}", not "soon").
- [ ] Proration estimate is shown **before** the user pays (plans card).
- [ ] Every error state has an **action** (Retry / Support / Return to Billing).
- [ ] 429 rate-limit error has a "try again shortly" or similar message, not a blank page.

### 4. Accessibility
- [ ] All interactive elements (buttons, links) are keyboard-reachable with visible focus ring.
- [ ] Cancel confirmation dialog has explicit Cancel / Confirm actions.
- [ ] Spinners carry `role="status"` or `aria-label="Loading"`.
- [ ] `aria-busy` or `disabled` set on buttons while submitting (no double-click).
- [ ] Sufficient color contrast in both light and dark modes (WCAG AA).
- [ ] `prefers-reduced-motion`: disable unnecessary animation if applicable.

### 5. Dark mode
- [ ] All backgrounds, text, borders, and badges have `dark:` variants where needed.
- [ ] `prefers-color-scheme: dark` media query in globals.css sets the body vars.
- [ ] No hardcoded white/black that breaks in dark mode (use zinc-50/zinc-900).
- [ ] Status badges remain readable in dark mode.
- [ ] Empty state dashed border is visible in dark mode.

### 6. Design language consistency
- [ ] Cards use `rounded-lg border border-zinc-200 bg-white`.
- [ ] Buttons are `rounded-full` pills (no sharp corners on CTAs).
- [ ] Primary actions: `bg-zinc-900 text-white`.
- [ ] Destructive actions: red palette (cancel button).
- [ ] Money formatted via `formatMinorUnits()` / `Intl.NumberFormat`, not raw kobo.
- [ ] No marketing copy, "why upgrade" language, or feature-gating copy.
- [ ] No new fonts, colors, or component patterns introduced without replacing all instances.

### 7. Proration visibility
- [ ] Plans card shows upgrade estimate: "{days} days left · credit ₦{credit} · upgrade charge ₦{charge}".
- [ ] The estimate updates on server render (plans page is `force-dynamic`).
- [ ] No stale or misleading estimates shown.

## How to run the audit

1. Read the page/component under review.
2. Walk through each section of the checklist above.
3. For each failing item, file it as a concrete fix with the exact file and line.
4. Run `npm run lint` and `npm run build` after fixes.
5. Check dark mode visually or by inspecting the CSS output.