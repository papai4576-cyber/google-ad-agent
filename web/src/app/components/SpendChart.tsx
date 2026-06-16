"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface SpendChartProps {
  data: { date: string; spend: number }[];
  currency: string;
}

export function SpendChart({ data, currency }: SpendChartProps) {
  if (!data.length) return <p className="py-8 text-center text-sm text-zinc-400">No spend data yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "#71717a" }}
          tickFormatter={(v: string) => v.slice(5)}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#71717a" }}
          tickFormatter={(v: number) => `${currency}${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: "#a1a1aa" }}
          formatter={(v) => [`${currency}${Number(v).toLocaleString()}`, "Spend"]}
        />
        <Bar dataKey="spend" fill="#6366f1" radius={[3, 3, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
