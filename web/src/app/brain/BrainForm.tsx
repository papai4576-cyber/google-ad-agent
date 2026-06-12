"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CATEGORIES = [
  "copy",
  "bidding",
  "structure",
  "scaling",
  "brand",
  "keywords",
  "audience",
  "competitive",
  "landing_page",
  "pmax",
  "reddit_intel",
  "general",
];

interface BrainFormProps {
  initialData?: {
    id?: string;
    category: string;
    source: string;
    sourceType: string;
    dateAdded?: string;
    title: string;
    summary: string;
    keyPoints: string[];
    rawText: string;
  };
  onClose?: () => void;
}

export default function BrainForm({ initialData, onClose }: BrainFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    category: initialData?.category || "",
    source: initialData?.source || "",
    sourceType: initialData?.sourceType || "manual",
    title: initialData?.title || "",
    summary: initialData?.summary || "",
    keyPoints: (initialData?.keyPoints || []).join("\n"),
    rawText: initialData?.rawText || "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const method = initialData ? "PUT" : "POST";
      const url = initialData ? `/api/brain/${initialData.id}` : "/api/brain";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: formData.category,
          source: formData.source,
          sourceType: formData.sourceType,
          title: formData.title,
          summary: formData.summary,
          keyPoints: formData.keyPoints
            .split("\n")
            .map((k) => k.trim())
            .filter((k) => k),
          rawText: formData.rawText,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err || `HTTP ${response.status}`);
      }

      router.refresh();
      if (onClose) onClose();
      setFormData({
        category: "",
        source: "",
        sourceType: "manual",
        title: "",
        summary: "",
        keyPoints: "",
        rawText: "",
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Category
          </label>
          <select
            value={formData.category}
            onChange={(e) =>
              setFormData({ ...formData, category: e.target.value })
            }
            required
            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
          >
            <option value="">Select category</option>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Source Type
          </label>
          <select
            value={formData.sourceType}
            onChange={(e) =>
              setFormData({ ...formData, sourceType: e.target.value })
            }
            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
          >
            <option value="manual">Manual</option>
            <option value="upload">Upload</option>
            <option value="reddit">Reddit</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          type="text"
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          required
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Source (filename, URL, etc.)
        </label>
        <input
          type="text"
          value={formData.source}
          onChange={(e) =>
            setFormData({ ...formData, source: e.target.value })
          }
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
          placeholder="e.g., 'performance-report.pdf'"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Summary (2–3 sentences)
        </label>
        <textarea
          value={formData.summary}
          onChange={(e) =>
            setFormData({ ...formData, summary: e.target.value })
          }
          rows={3}
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Key Points (one per line)
        </label>
        <textarea
          value={formData.keyPoints}
          onChange={(e) =>
            setFormData({ ...formData, keyPoints: e.target.value })
          }
          rows={4}
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
          placeholder="- Point 1&#10;- Point 2&#10;- Point 3"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          Raw Text
        </label>
        <textarea
          value={formData.rawText}
          onChange={(e) =>
            setFormData({ ...formData, rawText: e.target.value })
          }
          rows={6}
          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm px-3 py-2"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Saving..." : initialData ? "Update" : "Add Entry"}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-900 rounded-md hover:bg-gray-300"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
