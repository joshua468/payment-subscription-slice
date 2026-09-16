import Link from "next/link";

import CancelButton from "@/components/cancel-button";
import { getCurrentUser } from "@/lib/auth";
import { formatMinorUnits } from "@/lib/plans";
import {
  getPaymentActivity,
  getSubscriptionState,
} from "@/lib/subscription/service";
import type { SubscriptionStatus } from "@/types/payment";

export const metadata = {
  title: "Billing",
  description: "Manage your subscription.",
};

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: "Active",
  payment_pending: "Payment pending",
  pending_downgrade: "Downgrade scheduled",
  pending_cancellation: "Cancelling at period end",
  cancelled: "Cancelled",
};

const STAGE_LABEL: Record<string, string> = {
  initiation: "Checkout started",
  verification: "Payment verified",
  fulfilment: "Subscription activated",
  failure: "Payment failed",
};

export default async function BillingPage() {
  const user = await getCurrentUser();
  const { subscription } = await getSubscriptionState(user.id);
  const activity = await getPaymentActivity(user.id);

  const active =
    subscription &&
    subscription.status !== "cancelled" &&
    subscription.status !== "payment_pending";

  const canCancel =
    subscription &&
    subscription.status !== "pending_cancellation" &&
    subscription.status !== "pending_downgrade" &&
    subscription.status !== "payment_pending";

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-2xl">
        <Link
          href="/plans"
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
          View plans
        </Link>
        <h1 className="mt-6 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Billing
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Your subscription and payment record.
        </p>

        <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Current plan
              </p>
              <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                {active && subscription ? subscription.plan : "Free"}
              </p>
            </div>
            <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {active && subscription
                ? STATUS_LABEL[subscription.status as SubscriptionStatus]
                : !subscription || subscription.status === "payment_pending"
                  ? "No charge yet"
                  : STATUS_LABEL[subscription.status as SubscriptionStatus]}
            </span>
          </div>

          {active && subscription ? (
            <>
              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">Billing</dt>
                  <dd className="mt-1 font-medium capitalize text-zinc-900 dark:text-zinc-50">
                    {subscription.interval} ·{" "}
                    {formatMinorUnits(subscription.amountMinorUnits)}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">
                    Renewal date
                  </dt>
                  <dd className="mt-1 font-medium text-zinc-900 dark:text-zinc-50">
                    {subscription.periodEnd
                      ? new Date(subscription.periodEnd).toLocaleDateString()
                      : "pending"}
                  </dd>
                </div>
                {subscription.cancellationReason && (
                  <div>
                    <dt className="text-zinc-500 dark:text-zinc-400">
                      Cancellation reason
                    </dt>
                    <dd className="mt-1 font-medium text-zinc-900 dark:text-zinc-50">
                      {subscription.cancellationReason}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {canCancel && (
                  <CancelButton periodEnd={subscription.periodEnd} />
                )}
                <Link
                  href="/plans"
                  className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:focus-visible:outline-zinc-50"
                >
                  Change plan
                </Link>
              </div>
            </>
          ) : (
            <div className="mt-6">
              <Link
                href="/plans"
                className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                View plans
              </Link>
            </div>
          )}
        </div>

        <div className="mt-8">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Payment activity
          </h2>
          {activity.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              No payment activity yet.
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
              {activity.map((row) => (
                <li
                  key={`${row.createdAt.getTime()}-${row.stage}`}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {STAGE_LABEL[row.stage] ?? row.stage}
                    </p>
                    {row.errorReason && (
                      <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">
                        {row.errorReason}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    {row.amountMinorUnits !== null && (
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        {formatMinorUnits(row.amountMinorUnits)}
                      </p>
                    )}
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {row.createdAt.toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        </div>
    </div>
  );
}

export const dynamic = "force-dynamic";