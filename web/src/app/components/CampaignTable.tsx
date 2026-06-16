"use client";
import { useState } from "react";

export interface CampaignRow {
  campaignId: string;
  campaignName: string;
  channelType: string | null;
  biddingStrategy: string | null;
  budgetPerDay: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  clicks: number;
  impressions: number;
  ctr: number;
  avgCpc: number;
  budgetLostIs: number;
  rankLostIs: number;
  searchIs: number;
}

type SortKey = keyof CampaignRow;

function pct(n: number) { return (n * 100).toFixed(0) + "%"; }
function fmt(n: number, d = 0) { return n.toLocaleString(undefined, { maximumFractionDigits: d }); }

function IsBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(value * 100, 100)}%` }} />
      </div>
      <span className="text-xs">{pct(value)}</span>
    </div>
  );
}

function BudgetBar({ spend, budget }: { spend: number; budget: number }) {
  if (budget <= 0) return <span className="text-xs text-zinc-400">—</span>;
  const pctUsed = Math.min(spend / budget, 1.5);
  const color = pctUsed > 1.2 ? "bg-red-500" : pctUsed > 0.9 ? "bg-emerald-500" : pctUsed > 0.5 ? "bg-amber-400" : "bg-zinc-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pctUsed * 100, 100)}%` }} />
      </div>
      <span className="text-xs">{pct(Math.min(pctUsed, 1))}</span>
    </div>
  );
}

export function CampaignTable({ rows, currency }: { rows: CampaignRow[]; currency: string }) {
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  function toggle(key: SortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir("desc"); }
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sort] as number | string;
    const bv = b[sort] as number | string;
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return dir === "asc" ? cmp : -cmp;
  });

  function Th({ label, k }: { label: string; k: SortKey }) {
    return (
      <th
        onClick={() => toggle(k)}
        className="px-3 py-2 text-left text-xs font-medium text-zinc-500 cursor-pointer select-none whitespace-nowrap hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        {label} {sort === k ? (dir === "desc" ? "↓" : "↑") : ""}
      </th>
    );
  }

  if (!rows.length) return <p className="text-sm text-zinc-400 py-4">No campaign data.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <Th label="Campaign" k="campaignName" />
            <Th label="Type" k="channelType" />
            <Th label="Budget/day" k="budgetPerDay" />
            <Th label="Spend" k="spend" />
            <Th label="Conv" k="conversions" />
            <Th label="ROAS" k="conversionValue" />
            <Th label="CPA" k="conversions" />
            <Th label="CTR" k="ctr" />
            <Th label="Avg CPC" k="avgCpc" />
            <Th label="Utilisation" k="spend" />
            <Th label="IS Lost (Budget)" k="budgetLostIs" />
            <Th label="IS Lost (Rank)" k="rankLostIs" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const roas = c.spend > 0 && c.conversionValue > 0 ? (c.conversionValue / c.spend).toFixed(2) + "x" : "—";
            const cpa = c.conversions > 0 ? currency + fmt(c.spend / c.conversions, 0) : "—";
            const cpaNum = c.conversions > 0 ? c.spend / c.conversions : 0;
            const roasNum = c.spend > 0 ? c.conversionValue / c.spend : 0;
            const cpaColor = cpaNum > 0 && cpaNum < 300 ? "text-emerald-600 dark:text-emerald-400" : cpaNum > 600 ? "text-red-500" : "";
            const roasColor = roasNum > 4 ? "text-emerald-600 dark:text-emerald-400" : roasNum > 0 && roasNum < 2 ? "text-red-500" : "";
            const strategy = (c.biddingStrategy ?? "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
            return (
              <tr key={c.campaignId} className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td className="px-3 py-2.5 max-w-[220px]">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate block" title={c.campaignName}>
                    {c.campaignName}
                  </span>
                  <span className="text-xs text-zinc-400">{strategy}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-zinc-500 whitespace-nowrap">
                  {(c.channelType ?? "—").replace("SEARCH", "Search").replace("PERFORMANCE_MAX", "PMax").replace("SHOPPING", "Shopping")}
                </td>
                <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">{currency}{fmt(c.budgetPerDay)}</td>
                <td className="px-3 py-2.5 font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">{currency}{fmt(c.spend)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">{fmt(c.conversions, 1)}</td>
                <td className={`px-3 py-2.5 font-medium whitespace-nowrap ${roasColor}`}>{roas}</td>
                <td className={`px-3 py-2.5 font-medium whitespace-nowrap ${cpaColor}`}>{cpa}</td>
                <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400 whitespace-nowrap">{((c.ctr || 0) * 100).toFixed(2)}%</td>
                <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400 whitespace-nowrap">{c.avgCpc > 0 ? currency + fmt(c.avgCpc) : "—"}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <BudgetBar spend={c.spend} budget={c.budgetPerDay * 30} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <IsBar value={c.budgetLostIs} color={c.budgetLostIs > 0.3 ? "bg-red-500" : c.budgetLostIs > 0.1 ? "bg-amber-400" : "bg-emerald-500"} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <IsBar value={c.rankLostIs} color={c.rankLostIs > 0.4 ? "bg-red-500" : c.rankLostIs > 0.2 ? "bg-amber-400" : "bg-emerald-500"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
