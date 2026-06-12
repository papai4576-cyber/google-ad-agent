import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { desc } from "drizzle-orm";
import BrainForm from "./BrainForm";
import BrainEntry from "./BrainEntry";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brain | Google Ads Agent",
  description: "Manage strategy knowledge entries",
};

export default async function BrainPage() {
  if (!db) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <p className="text-red-600">Database not configured</p>
      </div>
    );
  }

  const entries = await db
    .select()
    .from(brainEntries)
    .orderBy(desc(brainEntries.dateAdded))
    .limit(100);

  const categoryGroups = entries.reduce(
    (acc, entry) => {
      if (!acc[entry.category]) {
        acc[entry.category] = [];
      }
      acc[entry.category].push(entry);
      return acc;
    },
    {} as Record<string, (typeof brainEntries.$inferSelect)[]>
  );

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Brain</h1>
            <p className="text-gray-600 mt-1">Strategy knowledge base</p>
          </div>
        </div>

        <div className="mb-8 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Add Entry
          </h2>
          <BrainForm />
        </div>

        {Object.keys(categoryGroups).length === 0 ? (
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-gray-500">No entries yet.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {Object.entries(categoryGroups).map(([category, items]) => (
              <div key={category} className="bg-white rounded-lg shadow overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                  <h3 className="text-lg font-semibold text-gray-900 capitalize">
                    {category}
                  </h3>
                  <p className="text-sm text-gray-600">
                    {items.length} entr{items.length === 1 ? "y" : "ies"}
                  </p>
                </div>

                <div className="divide-y divide-gray-200">
                  {items.map((entry) => (
                    <BrainEntry key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
