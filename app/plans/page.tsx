import Link from "next/link";
import ChoosePlanButton from "@/components/choose-plan-button";
import DowngradeButton from "@/components/downgrade-button";
import { getCurrentUser } from "@/lib/auth";
import { formatMinorUnits, getPlanPricing } from "@/lib/plans";
import {
  calculateProration,
  daysBetween,
  daysInInterval,
} from "@/lib/proration/calculate";
import { getSubscriptionState } from "@/lib/subscription/service";
import type { Subscription } from "@prisma/client";

export const metadata = {
  title: "Plans",
  description: "Choose a plan.",
};

interface CardProps {
  title: string;
  amount: string;
  cadence: string;
  description: string;
  badge?: string;
  button?: React.ReactNode;
  footnote?: string;
}

function PlanCard({ title, amount, cadence, description, badge, button, footnote }: CardProps) {
  return (
    <div className="flex flex-col rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
        {badge && (
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4">
        <span className="text-3xl font-semibold text-zinc-900 dark:text-zinc-50">
          {amount}
        </span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400"> {cadence}</span>
      </div>
      <p className="mt-3 flex-1 text-sm text-zinc-600 dark:text-zinc-400">
        {description}
      </p>
      {footnote && (
        <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          Upgrade pricing: {footnote}
        </p>
      )}
      <div className="mt-6">{button}</div>
    </div>
  );
}

function SelectedPlanButton({ label = "Selected plan" }: { label?: string }) {
  return (
    <button
      type="button"
      disabled
      className="w-full cursor-default rounded-full border border-zinc-200 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
    >
      {label}
    </button>
  );
}

function currentPlanLabel(subscription: Subscription | null): string {
  if (
    !subscription ||
    subscription.status === "cancelled" ||
    subscription.status === "payment_pending"
  ) {
    return "Free";
  }
  if (subscription.status === "pending_downgrade") {
    return `${subscription.interval === "yearly" ? "Yearly" : "Monthly"} · Free at period end`;
  }
  return subscription.interval === "yearly" ? "Yearly" : "Monthly";
}

function isCurrentPlan(subscription: Subscription | null, label: string): boolean {
  if (
    !subscription ||
    subscription.status === "cancelled" ||
    subscription.status === "payment_pending"
  ) {
    return label === "free";
  }
  if (subscription.status === "pending_downgrade") {
    return label === "monthly" || label === "free";
  }
  return label === subscription.interval;
}

export default async function PlansPage() {
  const user = await getCurrentUser();
  const { subscription } = await getSubscriptionState(user.id);

  const active = subscription && subscription.status === "active";

  // Live proration estimate for a mid-cycle upgrade, shown so the user sees the
  // exact math before handing off to the payment provider.
  let upgradeEstimate: string | null = null;
  if (active && subscription.interval === "monthly" && subscription.periodEnd) {
    const daysRemaining = Math.min(
      daysBetween(new Date(), subscription.periodEnd),
      daysInInterval("monthly")
    );
    const calc = calculateProration({
      currentAmountMinorUnits: getPlanPricing("monthly").amountMinorUnits,
      newAmountMinorUnits: getPlanPricing("yearly").amountMinorUnits,
      currentInterval: "monthly",
      newInterval: "yearly",
      daysRemaining,
    });
    upgradeEstimate = `${daysRemaining} days left · credit ${formatMinorUnits(
      calc.creditMinorUnits
    )} · upgrade charge ${formatMinorUnits(
      calc.proratedChargeMinorUnits
    )}`;
  }

  const monthly = getPlanPricing("monthly");
  const yearly = getPlanPricing("yearly");

  const cards: CardProps[] = [
    {
      title: "Free",
      amount: "₦0",
      cadence: "/ month",
      description: "The default state. No card, no commitment.",
      badge: isCurrentPlan(subscription, "free") ? "Current plan" : undefined,
      button: isCurrentPlan(subscription, "free") ? (
        <SelectedPlanButton />
      ) : subscription?.status === "pending_cancellation" ? (
        <SelectedPlanButton label="Free at period end" />
      ) : (
        <DowngradeButton />
      ),
    },
    {
      title: "Pro · Monthly",
      amount: formatMinorUnits(monthly.amountMinorUnits),
      cadence: "/ month",
      description: "Pro features, billed every 30 days. Cancel anytime.",
      badge: isCurrentPlan(subscription, "monthly") ? "Current plan" : undefined,
      button: isCurrentPlan(subscription, "monthly") ? (
        <SelectedPlanButton />
      ) : (
        <ChoosePlanButton interval="monthly" />
      ),
    },
    {
      title: "Pro · Yearly",
      amount: formatMinorUnits(yearly.amountMinorUnits),
      cadence: "/ year",
      description:
        "Pay once a year and save. Your unused monthly time is credited toward the yearly plan.",
      badge: isCurrentPlan(subscription, "yearly") ? "Current plan" : undefined,
      button: isCurrentPlan(subscription, "yearly") ? (
        <SelectedPlanButton />
      ) : (
        <ChoosePlanButton interval="yearly" />
      ),
      footnote: upgradeEstimate ?? undefined,
    },
  ];

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-4xl">
        <Link
          href="/billing"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
            className="h-4 w-4"
          >
            <path
              d="M12.5 4.5 7 10l5.5 5.5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to billing
        </Link>
        <h1 className="mt-6 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Plans
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          You’re on{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-50">
            {currentPlanLabel(subscription)}
          </span>{" "}
          and can switch between monthly and yearly anytime, keeping access
          until your paid period ends.
        </p>

        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <PlanCard key={card.title} {...card} />
          ))}
        </div>
      </div>
    </div>
  );
}

export const dynamic = "force-dynamic";