export interface WindowStats {
  cost: number;
  conversions: number;
  conversionValue: number;
  clicks: number;
  impressions: number;
}

function fmt(n: number, decimals = 0) {
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function Row({ label, v7, v30, vMtd }: { label: string; v7: string; v30: string; vMtd: string }) {
  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <td className="py-2 pr-4 text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{label}</td>
      <td className="py-2 px-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 text-right">{v7}</td>
      <td className="py-2 px-3 text-sm font-semibold text-indigo-700 dark:text-indigo-400 text-right">{v30}</td>
      <td className="py-2 pl-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 text-right">{vMtd}</td>
    </tr>
  );
}

function calc(s: WindowStats, currency: string) {
  return {
    spend: currency + fmt(s.cost),
    conv: fmt(s.conversions, 1),
    convVal: currency + fmt(s.conversionValue),
    roas: s.cost > 0 ? (s.conversionValue / s.cost).toFixed(2) + "x" : "—",
    cpa: s.conversions > 0 ? currency + fmt(s.cost / s.conversions, 0) : "—",
    clicks: fmt(s.clicks),
    impr: fmt(s.impressions),
    ctr: s.impressions > 0 ? ((s.clicks / s.impressions) * 100).toFixed(2) + "%" : "—",
    cvr: s.clicks > 0 ? ((s.conversions / s.clicks) * 100).toFixed(2) + "%" : "—",
    cpc: s.clicks > 0 ? currency + fmt(s.cost / s.clicks, 0) : "—",
  };
}

export function PerfTabs({ stats7d, stats30d, statsMtd, currency }: {
  stats7d: WindowStats; stats30d: WindowStats; statsMtd: WindowStats; currency: string;
}) {
  const d7 = calc(stats7d, currency);
  const d30 = calc(stats30d, currency);
  const mtd = calc(statsMtd, currency);

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-700">
            <th className="pb-2 pr-4 text-left text-xs text-zinc-400 font-normal">Metric</th>
            <th className="pb-2 px-3 text-right text-xs font-semibold text-zinc-500">7 Days</th>
            <th className="pb-2 px-3 text-right text-xs font-semibold text-indigo-600 dark:text-indigo-400">30 Days</th>
            <th className="pb-2 pl-3 text-right text-xs font-semibold text-zinc-500">Month to Date</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Spend"       v7={d7.spend}   v30={d30.spend}   vMtd={mtd.spend} />
          <Row label="Conversions" v7={d7.conv}    v30={d30.conv}    vMtd={mtd.conv} />
          <Row label="Conv. Value" v7={d7.convVal} v30={d30.convVal} vMtd={mtd.convVal} />
          <Row label="ROAS"        v7={d7.roas}    v30={d30.roas}    vMtd={mtd.roas} />
          <Row label="CPA"         v7={d7.cpa}     v30={d30.cpa}     vMtd={mtd.cpa} />
          <Row label="Clicks"      v7={d7.clicks}  v30={d30.clicks}  vMtd={mtd.clicks} />
          <Row label="Impressions" v7={d7.impr}    v30={d30.impr}    vMtd={mtd.impr} />
          <Row label="CTR"         v7={d7.ctr}     v30={d30.ctr}     vMtd={mtd.ctr} />
          <Row label="CVR"         v7={d7.cvr}     v30={d30.cvr}     vMtd={mtd.cvr} />
          <Row label="Avg CPC"     v7={d7.cpc}     v30={d30.cpc}     vMtd={mtd.cpc} />
        </tbody>
      </table>
    </div>
  );
}
