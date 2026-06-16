"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BulkApproveButton({ planIds }: { planIds: string[] }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [done, setDone] = useState(0);

  async function approveAll() {
    setState("running");
    setDone(0);
    for (const planId of planIds) {
      await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, action: "approve" }),
      }).catch(() => null);
      setDone((d) => d + 1);
    }
    setState("done");
    router.refresh();
  }

  if (planIds.length === 0) return null;

  return (
    <button
      type="button"
      onClick={approveAll}
      disabled={state === "running"}
      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
    >
      {state === "running"
        ? `Approving… ${done}/${planIds.length}`
        : state === "done"
        ? `Approved ${planIds.length}`
        : `Approve all P1 (${planIds.length})`}
    </button>
  );
}
