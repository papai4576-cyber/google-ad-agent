"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BrainForm from "./BrainForm";

interface BrainEntryProps {
  entry: {
    id: string;
    category: string;
    source: string | null;
    sourceType: string | null;
    dateAdded: string;
    title: string;
    summary: string | null;
    keyPoints: string[] | null;
    rawText: string | null;
  };
}

export default function BrainEntry({ entry }: BrainEntryProps) {
  const router = useRouter();
  const [editMode, setEditMode] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm("Delete this entry?")) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/brain/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      router.refresh();
    } catch (err) {
      alert("Failed to delete: " + String(err));
      setDeleting(false);
    }
  };

  if (editMode) {
    return (
      <div className="px-6 py-4">
        <BrainForm
          initialData={{
            ...entry,
            source: entry.source || "",
            sourceType: entry.sourceType || "manual",
            summary: entry.summary || "",
            keyPoints: entry.keyPoints || [],
            rawText: entry.rawText || "",
          }}
          onClose={() => setEditMode(false)}
        />
      </div>
    );
  }

  return (
    <div className="px-6 py-4 hover:bg-gray-50 transition">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h4 className="text-base font-semibold text-gray-900">
            {entry.title}
          </h4>
          {entry.source && (
            <p className="text-sm text-gray-500 mt-1">
              Source: <span className="font-mono">{entry.source}</span>
            </p>
          )}
          {entry.summary && (
            <p className="text-sm text-gray-700 mt-2">{entry.summary}</p>
          )}
          {entry.keyPoints && entry.keyPoints.length > 0 && (
            <ul className="text-sm text-gray-600 mt-2 list-disc list-inside">
              {entry.keyPoints.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          {entry.sourceType || "manual"}
        </span>
        <span className="text-xs text-gray-500">
          Added {entry.dateAdded}
        </span>

        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setEditMode(true)}
            className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
