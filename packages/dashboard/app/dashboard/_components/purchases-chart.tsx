'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsBucket } from '@onesub/shared';

interface PurchasesChartProps {
  /** Daily non-consumable purchase counts, sorted ascending. */
  buckets: MetricsBucket[];
}

interface ChartRow {
  date: string;
  /** MM-DD label — same compaction as growth chart. */
  label: string;
  count: number;
}

function toRows(buckets: MetricsBucket[]): ChartRow[] {
  return buckets.map((b) => ({ date: b.date, label: b.date.slice(5), count: b.count }));
}

export function PurchasesChart({ buckets }: PurchasesChartProps) {
  const data = toRows(buckets);
  const total = data.reduce((acc, r) => acc + r.count, 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">Purchases — last 30 days</div>
          <div className="text-xs text-slate-500">
            UTC daily; non-consumable (lifetime) purchases by purchasedAt
          </div>
        </div>
        <div className="text-xs text-slate-500">
          total <span className="ml-1 font-mono tabular-nums text-slate-900">{total}</span>
        </div>
      </div>
      <div className="mt-4 h-56">
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
            <Bar dataKey="count" name="purchases" fill="#6366f1" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
