"use client";
import { useState } from "react";

export interface WindowStats {
  cost: number;
  conversions: number;
  conversionValue: number;
  clicks: number;
  impressions: number;
}

interface PerfTabsProps {
  stats7d: WindowStats;
  stats30d: WindowStats;
  statsMtd: WindowStats;
  currency: string;
}

function fmt(n: number, decimals = 0) {
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{value}</span>
    </div>
  );
}

function StatsGrid({ s, currency }: { s: WindowStats; currency: string }) {
  const roas = s.cost > 0 ? (s.conversionValue / s.cost).toFixed(2) + "x" : "—";
  const cpa = s.conversions > 0 ? currency + fmt(s.cost / s.conversions, 0) : "—";
  const ctr = s.impressions > 0 ? ((s.clicks / s.impressions) * 100).toFixed(2) + "%" : "—";
  const cvr = s.clicks > 0 ? ((s.conversions / s.clicks) * 100).toFixed(2) + "%" : "—";
  const avgCpc = s.clicks > 0 ? currency + fmt(s.cost / s.clicks, 0) : "—";
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 pt-4">
      <Metric label="Spend" value={currency + fmt(s.cost)} />
      <Metric label="Conversions" value={fmt(s.conversions, 1)} />
      <Metric label="Conv. Value" value={currency + fmt(s.conversionValue)} />
      <Metric label="ROAS" value={roas} />
      <Metric label="CPA" value={cpa} />
      <Metric label="Clicks" value={fmt(s.clicks)} />
      <Metric label="Impressions" value={fmt(s.impressions)} />
      <Metric label="CTR" value={ctr} />
      <Metric label="CVR" value={cvr} />
      <Metric label="Avg CPC" value={avgCpc} />
    </div>
  );
}

const TABS = ["7 Days", "30 Days", "Month to Date"] as const;

export function PerfTabs({ stats7d, stats30d, statsMtd, currency }: PerfTabsProps) {
  const [active, setActive] = useState<(typeof TABS)[number]>("30 Days");
  const stats = active === "7 Days" ? stats7d : active === "30 Days" ? stats30d : statsMtd;
  return (
    <div>
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setActive(t)}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              active === t
                ? "border-b-2 border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <StatsGrid s={stats} currency={currency} />
    </div>
  );
}
