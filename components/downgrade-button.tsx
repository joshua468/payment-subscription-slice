"use client";

import { useState } from "react";

export default function DowngradeButton() {
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [periodEndLabel, setPeriodEndLabel] = useState<string | null>(null);

  async function handleDowngrade() {
    if (status === "submitting") return;
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { cancelled?: boolean; periodEnd?: string; error?: string };

      if (body.cancelled) {
        setPeriodEndLabel(
          body.periodEnd
            ? new Date(body.periodEnd).toLocaleDateString()
            : "the end of your paid period"
        );
        setStatus("done");
        return;
      }
      setError(body.error ?? `Request failed (${res.status}).`);
      setStatus("error");
    } catch {
      setError("Could not reach the server. Please try again.");
      setStatus("error");
    }
  }

  if (status === "done" && periodEndLabel) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Downgrade scheduled — Free at {periodEndLabel}.
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleDowngrade}
        disabled={status === "submitting"}
        className="inline-flex h-10 w-full items-center justify-center rounded-full border border-zinc-200 px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {status === "submitting" ? "Downgrading…" : "Downgrade to free"}
      </button>
      {status === "error" && error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
          <button
            type="button"
            onClick={() => setStatus("idle")}
            className="ml-2 underline"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
