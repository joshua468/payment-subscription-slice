"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { formatMinorUnits } from "@/lib/plans";

type PollState = {
  subscription: {
    plan?: string;
    interval?: string;
    periodEnd?: string;
    status?: string;
    amountMinorUnits?: number | null;
  } | null;
  latestStage: string | null;
};

function SuccessInner() {
  const searchParams = useSearchParams();


  const redirectStatus = searchParams.get("status");
  const [status, setStatus] = useState<
    "checking" | "fulfilled" | "failed" | "cancelled" | "timeout"
  >(() =>
    redirectStatus != null && redirectStatus !== "successful"
      ? "cancelled"
      : "checking"
  );
  const [subscription, setSubscription] = useState<PollState["subscription"]>(null);
  const [amountMinorUnits, setAmountMinorUnits] = useState<number | null>(null);
  const verifyInFlightRef = useRef(false);

  useEffect(() => {
    if (searchParams.get("status") !== "successful") {
      return;
    }

    const deadline = Date.now() + 90_000;
    let timer: ReturnType<typeof setTimeout>;

    // This page never grants entitlement (Rule 2); it only reflects the
    // server-side payment log. Webhooks can be delayed (or never arrive in
    // sandbox against localhost), so on a successful redirect we also ask the
    // server to verify the transaction directly and fulfil it if pending. The
    // endpoint is idempotent and safe to run alongside the webhook.
    async function verifyRedirectPayment() {
      if (verifyInFlightRef.current) return;
      const txRef = searchParams.get("tx_ref");
      const transactionId = searchParams.get("transaction_id");
      if (!txRef || !transactionId) return;
      verifyInFlightRef.current = true;
      try {
        // This page never grants entitlement (Rule 2); it only reflects the
        // server-side payment log. Verify is merely an accelerator for the
        // fulfilment the webhook normally records: it is idempotent, safe to
        // run alongside the webhook, and safe to call repeatedly while we wait
        // (a single verify call can fail transiently against the sandbox, or
        // the webhook itself can be delayed or never arrive against localhost,
        // so we keep re-asking until the server records the outcome).
        await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txRef, transactionId }),
        });
      } catch {
        // Transient error — the poll keeps running and the endpoint can be
        // called again from a refresh; it is idempotent.
      } finally {
        verifyInFlightRef.current = false;
      }
    }

    // Once the redirect has triggered a verification we keep polling â€” verify
    // is merely an accelerator for the fulfilment the webhook normally records.
    async function poll() {
      try {
        const res = await fetch("/api/subscriptions", { cache: "no-store" });
        const state = (await res.json()) as PollState;

        if (
          state.subscription &&
          typeof state.subscription.amountMinorUnits === "number"
        ) {
          setAmountMinorUnits(state.subscription.amountMinorUnits);
        }

        if (state.latestStage === "fulfilment" && state.subscription) {
          setSubscription(state.subscription);
          setStatus("fulfilled");
          return;
        }
        if (state.latestStage === "failure") {
          setStatus("failed");
          return;
        }
      } catch {

      }

      if (Date.now() > deadline) {
        setStatus("timeout");
        return;
      }
      // Verify is idempotent and in-flight-guarded, so keep re-asking while we
      // wait: a single verify call can fail transiently, and the webhook can be
      // delayed or never arrive against localhost, so the plan flips as soon as
      // the first successful verify (or webhook) records fulfilment server-side.
      verifyRedirectPayment();
      timer = setTimeout(poll, 2500);
    }

    verifyRedirectPayment();
    poll();
    return () => clearTimeout(timer);
  }, [searchParams]);

  const redirectSuccessful = redirectStatus === "successful";

  if (status === "fulfilled" && subscription) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          You are all set
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {amountMinorUnits !== null
            ? `Your payment of ${formatMinorUnits(amountMinorUnits)} has been applied.`
            : "Your payment has been applied."}
        </p>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Your {subscription.plan} plan (
          <span className="capitalize">{subscription.interval}</span>) is active.
          Renews on{" "}
          {subscription.periodEnd
            ? new Date(subscription.periodEnd).toLocaleDateString()
            : "a future date"}
          .
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/plans"
            className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Check your updated plan
          </Link>
          <Link
            href="/billing"
            className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Go to billing
          </Link>
        </div>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          No payment made
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          You left the checkout before paying, so nothing was charged and your
          plan is unchanged.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/plans"
            className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            View plans
          </Link>
          <Link
            href="/billing"
            className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Return to billing
          </Link>
        </div>
      </div>
    );
  }

  if (redirectSuccessful) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Confirming your payment…
      </p>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Payment not confirmed
      </h1>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
        {status === "failed"
          ? "Your payment did not complete. No charge has been applied."
          : "We haven't received a payment yet. If you didn't complete the checkout, nothing has been charged â€” you can try again."}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/plans"
          className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Retry
        </Link>
        <Link
          href="/billing"
          className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Return to billing
        </Link>
      </div>
      <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
        {status === "timeout"
          ? "Need help? Contact support and quote your payment reference."
          : "If you were charged but see this, contact support with your payment reference."}
      </p>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <Suspense fallback={<p>Loadingâ€¦</p>}>
          <SuccessInner />
        </Suspense>
      </div>
    </div>
  );
}