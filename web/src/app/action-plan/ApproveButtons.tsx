"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ApproveButtons({ planId }: { planId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(action: "approve" | "reject") {
    setPending(action);
    setError(null);
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => send("approve")}
        disabled={pending !== null}
        className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {pending === "approve" ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        onClick={() => send("reject")}
        disabled={pending !== null}
        className="rounded-md bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
      >
        {pending === "reject" ? "Rejecting…" : "Reject"}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
