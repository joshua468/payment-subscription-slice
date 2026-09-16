"use client";

import { useState } from "react";

import type { Interval } from "@/types/payment";

export default function ChoosePlanButton({ interval }: { interval: Interval }) {
  const [status, setStatus] = useState<
    "idle" | "submitting" | "error" | "deferred"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [deferredMessage, setDeferredMessage] = useState<string | null>(null);

  async function handleChoose() {
    if (status === "submitting") return;
    setStatus("submitting");
    setError(null);
    setDeferredMessage(null);

    try {
      // Double-submit is prevented by disabling the button (Rule 9).
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const body = (await res.json()) as {
        flutterwaveRedirectUrl?: string;
        deferred?: boolean;
        message?: string;
        error?: string;
      };

      if (body.flutterwaveRedirectUrl) {
        window.location.href = body.flutterwaveRedirectUrl;
        return;
      }
      if (body.deferred) {
        setDeferredMessage(body.message ?? "Change applied at the end of your period.");
        setStatus("deferred");
        return;
      }
      setError(body.error ?? `Request failed (${res.status}).`);
      setStatus("error");
    } catch {
      setError("Could not reach the server. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleChoose}
        disabled={status === "submitting"}
        className="inline-flex h-10 w-full items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {status === "submitting" ? "Starting checkout…" : "Choose"}
      </button>
      {status === "error" && error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">
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
      {status === "deferred" && deferredMessage && (
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {deferredMessage}
        </p>
      )}
    </div>
  );
}