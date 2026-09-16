"use client";

import { useState } from "react";

export default function CancelButton({ periodEnd }: { periodEnd: Date | null }) {
  const [step, setStep] = useState<"idle" | "confirm" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const periodEndLabel = periodEnd
    ? new Date(periodEnd).toLocaleDateString()
    : "the end of your paid period";

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim() ? reason.trim() : undefined,
        }),
      });
      const body = (await res.json()) as { cancelled?: boolean; error?: string };
      if (body.cancelled) {
        setStep("done");
      } else {
        setError(body.error ?? `Request failed (${res.status}).`);
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done") {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Cancellation scheduled. You keep access until {periodEndLabel}.
      </p>
    );
  }

  if (step === "confirm") {
    return (
      <div className="w-full rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
          Confirm cancellation
        </p>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          You keep Pro access until {periodEndLabel}. After that you revert to
          Free, with no refunds for the current period.
        </p>
        <label className="mt-3 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Reason (optional)
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            placeholder="Help us improve"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          />
        </label>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="inline-flex h-9 items-center justify-center rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Cancelling…" : "Cancel subscription"}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStep("idle");
            }}
            className="inline-flex h-9 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Keep subscription
          </button>
        </div>
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setStep("confirm");
        }}
        className="inline-flex h-10 items-center justify-center rounded-full border border-red-200 px-4 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        Cancel subscription
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}