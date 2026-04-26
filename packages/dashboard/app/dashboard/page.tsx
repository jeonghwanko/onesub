import { requireClient } from '../../lib/auth';
import { OneSubFetchError } from '../../lib/onesub-client';

export const dynamic = 'force-dynamic';

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  emphasis?: 'default' | 'warning';
}

function StatCard({ label, value, hint, emphasis }: StatCardProps) {
  const accent =
    emphasis === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border ${accent} p-5 shadow-sm`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value.toLocaleString?.() ?? value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

interface DistributionTableProps {
  title: string;
  data: Record<string, number>;
  empty?: string;
}

function DistributionTable({ title, data, empty }: DistributionTableProps) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">{title}</div>
      {entries.length === 0 ? (
        <div className="px-5 py-6 text-center text-sm text-slate-400">{empty ?? '데이터 없음'}</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {entries.map(([key, count]) => (
              <tr key={key} className="border-b border-slate-50 last:border-0">
                <td className="px-5 py-3 text-slate-700">{key}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-900">{count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function DashboardOverview() {
  const client = await requireClient();

  let metrics;
  try {
    metrics = await client.getActiveMetrics();
  } catch (err) {
    // 401 from the upstream server means the cookie is stale — clear it and
    // bounce to login. (Edge middleware can't probe the upstream itself, so
    // this server-side guard backs it up.)
    if (err instanceof OneSubFetchError && err.status === 401) {
      const { clearAdminSecret } = await import('../../lib/auth');
      await clearAdminSecret();
      const { redirect } = await import('next/navigation');
      redirect('/login');
    }
    throw err;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-slate-500">
          실시간 entitled 수 + 그룹별 분포. 새로고침하면 다시 집계됩니다.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total entitled"
          value={metrics.total}
          hint="active subs + grace_period subs + non-consumable purchases"
        />
        <StatCard
          label="Active subscriptions"
          value={metrics.activeSubscriptions}
          hint="status = active or grace_period (expiresAt > now)"
        />
        <StatCard
          label="Grace period (at risk)"
          value={metrics.gracePeriodSubscriptions}
          hint="payment failed; entitlement still valid"
          emphasis={metrics.gracePeriodSubscriptions > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Non-consumable purchases"
          value={metrics.nonConsumablePurchases}
          hint="lifetime products"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DistributionTable
          title="By product (active subscriptions)"
          data={metrics.byProduct}
          empty="활성 구독이 없습니다"
        />
        <DistributionTable
          title="By platform (subs + non-consumable)"
          data={metrics.byPlatform}
          empty="데이터 없음"
        />
      </div>
    </div>
  );
}
