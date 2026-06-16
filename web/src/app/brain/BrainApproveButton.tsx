"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BrainApproveButton({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "approving" | "rejecting">("idle");

  async function setStatus(status: "active" | "rejected") {
    setState(status === "active" ? "approving" : "rejecting");
    await fetch(`/api/brain/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => setStatus("active")}
        disabled={state !== "idle"}
        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {state === "approving" ? "Adding…" : "Add to Brain"}
      </button>
      <button
        onClick={() => setStatus("rejected")}
        disabled={state !== "idle"}
        className="rounded-md bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300"
      >
        {state === "rejecting" ? "Rejecting…" : "Discard"}
      </button>
    </div>
  );
}
