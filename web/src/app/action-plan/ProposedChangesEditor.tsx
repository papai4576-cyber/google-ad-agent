"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ProposedChange = { type: string; params: Record<string, unknown> };

/** Field names whose value is rendered as one-item-per-line (arrays of strings, e.g. RSA headlines). */
const ARRAY_FIELDS = new Set(["headlines", "descriptions", "final_urls"]);

function toEditableValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("\n");
  if (v == null) return "";
  return String(v);
}

function fromEditableValue(key: string, raw: string, original: unknown): unknown {
  if (Array.isArray(original) || ARRAY_FIELDS.has(key)) {
    return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof original === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : original;
  }
  return raw;
}

/**
 * Editable form for a pending recommendation's proposed_changes — generic over
 * every ProposedChange type (no per-type branching needed): every param key
 * renders as a textarea (array fields, one value per line) or a text input
 * (scalar fields), and on save the same shape goes back through
 * normalizeProposedChanges() server-side. Only rendered for status='pending'
 * rows — see /api/action-plan/[planId]'s PATCH handler for why.
 */
export default function ProposedChangesEditor({ planId, changes }: { planId: string; changes: ProposedChange[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProposedChange[]>(changes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (changes.length === 0) return null;

  function setField(idx: number, key: string, raw: string) {
    setDraft((prev) => {
      const next = prev.slice();
      const original = next[idx].params[key];
      next[idx] = { ...next[idx], params: { ...next[idx].params, [key]: fromEditableValue(key, raw, original) } };
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/action-plan/${planId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposedChanges: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(changes);
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1.5 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        Edit before approving
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/20 p-3">
      {draft.map((change, idx) => (
        <div key={idx} className="space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">{change.type}</p>
          {Object.entries(change.params).map(([key, value]) => (
            <label key={key} className="block">
              <span className="text-[10px] text-zinc-400">{key}</span>
              {Array.isArray(value) || ARRAY_FIELDS.has(key) ? (
                <textarea
                  value={toEditableValue(value)}
                  onChange={(e) => setField(idx, key, e.target.value)}
                  rows={Math.max(2, toEditableValue(value).split("\n").length)}
                  className="mt-0.5 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-800 dark:text-zinc-200"
                />
              ) : (
                <input
                  type="text"
                  value={toEditableValue(value)}
                  onChange={(e) => setField(idx, key, e.target.value)}
                  className="mt-0.5 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-800 dark:text-zinc-200"
                />
              )}
            </label>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="rounded-md bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}
