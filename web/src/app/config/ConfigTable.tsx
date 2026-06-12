"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ConfigRow {
  key: string;
  value: string;
  description?: string | null;
  updatedAt: Date;
}

interface ConfigTableProps {
  configs: ConfigRow[];
}

export default function ConfigTable({ configs }: ConfigTableProps) {
  const router = useRouter();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [addingNew, setAddingNew] = useState(false);

  const startEdit = (config: ConfigRow) => {
    setEditingKey(config.key);
    setEditValue(config.value);
    setEditDesc(config.description || "");
  };

  const handleSave = async (key: string) => {
    setLoading(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          value: editValue,
          description: editDesc,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      router.refresh();
      setEditingKey(null);
    } catch (err) {
      alert("Failed to save: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete config key "${key}"?`)) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/config/${key}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      router.refresh();
    } catch (err) {
      alert("Failed to delete: " + String(err));
      setLoading(false);
    }
  };

  const handleAddNew = async () => {
    if (!newKey || !newValue) {
      alert("Key and Value are required");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: newKey,
          value: newValue,
          description: newDesc,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      router.refresh();
      setNewKey("");
      setNewValue("");
      setNewDesc("");
      setAddingNew(false);
    } catch (err) {
      alert("Failed to add: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Add New Row */}
      {!addingNew ? (
        <button
          onClick={() => setAddingNew(true)}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
        >
          + Add Config
        </button>
      ) : (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Add New Config
          </h3>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Key (e.g., RULE_BUDGET_LOST_IS)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2"
              />
              <input
                type="text"
                placeholder="Value (e.g., 0.30)"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2"
              />
            </div>
            <textarea
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded-md px-3 py-2"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAddNew}
                disabled={loading}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? "Saving..." : "Add"}
              </button>
              <button
                onClick={() => setAddingNew(false)}
                className="px-4 py-2 bg-gray-200 text-gray-900 rounded-md hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse border border-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="border border-gray-200 px-4 py-2 text-left font-semibold text-gray-900">
                Key
              </th>
              <th className="border border-gray-200 px-4 py-2 text-left font-semibold text-gray-900">
                Value
              </th>
              <th className="border border-gray-200 px-4 py-2 text-left font-semibold text-gray-900">
                Description
              </th>
              <th className="border border-gray-200 px-4 py-2 text-left font-semibold text-gray-900">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {configs.map((config) => (
              <tr
                key={config.key}
                className={
                  editingKey === config.key ? "bg-yellow-50" : "hover:bg-gray-50"
                }
              >
                <td className="border border-gray-200 px-4 py-2 font-mono text-sm text-gray-900">
                  {config.key}
                </td>
                <td className="border border-gray-200 px-4 py-2">
                  {editingKey === config.key ? (
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                  ) : (
                    <span className="font-mono text-sm text-gray-700">
                      {config.value}
                    </span>
                  )}
                </td>
                <td className="border border-gray-200 px-4 py-2 text-sm text-gray-600">
                  {editingKey === config.key ? (
                    <input
                      type="text"
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                  ) : (
                    config.description || "—"
                  )}
                </td>
                <td className="border border-gray-200 px-4 py-2 text-sm">
                  {editingKey === config.key ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSave(config.key)}
                        disabled={loading}
                        className="px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingKey(null)}
                        className="px-2 py-1 bg-gray-300 rounded hover:bg-gray-400"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => startEdit(config)}
                        className="px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(config.key)}
                        className="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
