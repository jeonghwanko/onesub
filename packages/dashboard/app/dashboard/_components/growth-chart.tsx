'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsBucket } from '@onesub/shared';

interface GrowthChartProps {
  /** Daily started counts, sorted ascending. Server-fetched in the parent. */
  started: MetricsBucket[];
  /** Daily expired counts, same length and date alignment as `started`. */
  expired: MetricsBucket[];
}

interface ChartRow {
  date: string;
  /** Compact label for the X axis — drops the year to fit ~30 ticks. */
  label: string;
  started: number;
  expired: number;
  net: number;
}

function joinBuckets(started: MetricsBucket[], expired: MetricsBucket[]): ChartRow[] {
  // Both series come zero-filled across the same window; map by date so a
  // missing day on one side (defensive) just lands as 0.
  const byDate = new Map<string, ChartRow>();
  for (const b of started) {
    byDate.set(b.date, {
      date: b.date,
      label: b.date.slice(5),  // MM-DD
      started: b.count,
      expired: 0,
      net: b.count,
    });
  }
  for (const b of expired) {
    const row = byDate.get(b.date);
    if (row) {
      row.expired = b.count;
      row.net = row.started - b.count;
    } else {
      byDate.set(b.date, {
        date: b.date,
        label: b.date.slice(5),
        started: 0,
        expired: b.count,
        net: -b.count,
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function GrowthChart({ started, expired }: GrowthChartProps) {
  const data = joinBuckets(started, expired);
  const total = data.reduce(
    (acc, r) => ({ started: acc.started + r.started, expired: acc.expired + r.expired }),
    { started: 0, expired: 0 },
  );
  const net = total.started - total.expired;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">Growth — last 30 days</div>
          <div className="text-xs text-slate-500">
            UTC daily; bars = subscriptions started vs ended in the day
          </div>
        </div>
        <div className="flex gap-4 text-xs text-slate-500">
          <span>started <span className="ml-1 font-mono tabular-nums text-emerald-700">{total.started}</span></span>
          <span>expired <span className="ml-1 font-mono tabular-nums text-rose-700">{total.expired}</span></span>
          <span>net <span className={`ml-1 font-mono tabular-nums ${net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{net >= 0 ? `+${net}` : net}</span></span>
        </div>
      </div>
      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} interval="preserveStartEnd" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} width={32} />
            <Tooltip
              cursor={{ fill: '#f1f5f9' }}
              contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: '#cbd5e1' }}
              labelFormatter={(label, payload) => {
                const row = payload?.[0]?.payload as ChartRow | undefined;
                return row?.date ?? String(label);
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
            <Bar dataKey="started" name="started" fill="#10b981" radius={[2, 2, 0, 0]} />
            <Bar dataKey="expired" name="expired" fill="#f43f5e" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
