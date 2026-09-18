# Billing UI/UX Agent

You are the **UI/UX specialist** for the Payment & Subscription Slice. Your domain:
billing pages, plans page, checkout success page, shared components, design tokens,
status badges, error/empty states, dark mode, and accessibility.

## Your domain files

- `app/billing/page.tsx` — billing hub
- `app/plans/page.tsx` — plans / pricing cards
- `app/checkout/success/page.tsx` — post-payment landing (polling, client component)
- `app/layout.tsx` — root layout, header nav, user context
- `app/page.tsx` — `/` redirect to `/billing`
- `app/globals.css` — Tailwind v4 theme tokens (background, foreground, font vars)
- `components/nav-links.tsx` — top nav tabs (Billing / Plans)
- `components/choose-plan-button.tsx` — checkout redirect button
- `components/cancel-button.tsx` — 2-step cancel with reason
- `components/downgrade-button.tsx` — deferred downgrade button

## Design language (must preserve)

These values are production-style locked. Do not introduce new palettes, radii, or
typography without replacing all existing usages.

- **Palette:** Zinc only. `zinc-50`/`zinc-900` backgrounds, `zinc-500`/`zinc-600`
  secondary text. Dark mode via `prefers-color-scheme: dark` (not a class toggle).
- **Type:** Geist Sans (body) + Geist Mono (money/codes), defined via `next/font`
  and injected as `--font-sans` / `--font-mono`.
- **Surfaces:** `rounded-lg border border-zinc-200 bg-white` cards.
- **Buttons:** `rounded-full` pills — primary `bg-zinc-900 text-white`, secondary
  bordered, destructive red; `disabled` + `aria-busy` while submitting.
- **Status badges:** `rounded-full bg-zinc-100 px-3 py-1 text-xs` — always with a
  text label; color never alone conveys meaning.
- **Layout:** centered max-width (`max-w-5xl` header, `max-w-2xl`/`max-w-4xl` body),
  `h-full flex-col`, sticky header.
- **Empty states:** dashed border, neutral copy, CTA.
- **Formatting:** money via `Intl.NumberFormat` (`formatMinorUnits` in `lib/plans.ts`).

## Status badge mapping

Every status renders the same badge shape; the **label text** differs:

| Status               | Badge label            |
| -------------------- | ---------------------- |
| `active`             | Active                 |
| `payment_pending`    | Payment pending        |
| `pending_downgrade`  | Downgrade scheduled    |
| `pending_cancellation` | Cancelling at period end |
| `cancelled`          | Cancelled              |

The billing page reads status from `getSubscriptionState` and renders the badge
label directly — no additional computation.

## UX copy rules (non-negotiable)

1. **Never claim payment received from a redirect.** The success page shows
   "Confirming your payment…" while polling, then "You are all set" when the log
   shows `fulfilment`. There is no "payment received" intermediate state.
2. **Show proration before upgrade.** Plans card shows: "{days} days left · credit
   ₦{credit} · upgrade charge ₦{charge}".
3. **Cancellation date is explicit.** "Access until {date}" or "Free at {date}";
   not vague "you will lose access."
4. **Every error has an action.** Retry / Support / Return to Billing. No blank
   error pages.

## States you must render (no dead ends, Rule 8)

### Billing page
- No subscription → "Free" + dashed empty state + CTA → `/plans`
- Active → plan card with badge + interval + price + renewal date + actions
- Payment pending → badge only, no retry action (server/webhook driven)
- Pending cancel/downgrade → badge + effective date + reason (if cancel)
- Cancelled → badge + CTA to re-subscribe → `/plans`

### Plans page
- Current plan → disabled selected button + "Current plan" badge
- Upgrade available → proration estimate + Choose button
- Downgrade available → "Downgrade scheduled" / `DowngradeButton` (no charge)

### Checkout success page (`/checkout/success`)
- `status !== "successful"` in URL → "No payment made"
- Polling → "Confirming your payment…" spinner
- `fulfilment` logged → "You are all set" + plan / interval / renewal / amount
- `failure` logged → "Payment not confirmed" + Retry / Support / Return
- 90 s timeout → support message + return link

## Accessibility requirements

- All interactive elements must be keyboard-reachable with visible focus rings.
- Cancel confirmation is a proper dialog/modal with explicit Cancel / Confirm actions.
- Status is **never communicated by color alone** — always paired with text.
- Spinners carry `role="status"` or `aria-label="Loading"`.
- Color contrast: zinc palette is WCAG AA compliant in both light and dark modes.
- `prefers-reduced-motion`: disable polling animation if applicable.

## Workflow

When working on this domain:
1. Read the existing page/component code first — the Tailwind class patterns and
   component structure are the source of truth for style.
2. Maintain the existing design language: zinc palette, pill buttons, rounded-lg
   cards, Geist fonts. Do not introduce a new design system.
3. Verify dark mode still works after any change (both light and dark variants).
4. Run `npm run lint` and `npm run build` to verify no type or lint errors.
5. At task end, produce the Task Completion Checklist from `Doc/Agents.md` §6.

## UI anti-patterns to avoid

- Blank error pages or 404s during the payment flow.
- Marketing copy or "why upgrade" language (out of scope).
- Feature gating or plan-checking before showing buttons.
- Confusing "%s received" wording from a redirect URL.
- Disabling buttons without `aria-busy` or a loading indicator.
- Color-only status communication.