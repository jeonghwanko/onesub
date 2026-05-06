import { requireClient } from '../../lib/auth';
import { OneSubFetchError } from '../../lib/onesub-client';
import { GrowthChart } from './_components/growth-chart';
import { PurchasesChart } from './_components/purchases-chart';

export const dynamic = 'force-dynamic';

const GROWTH_WINDOW_DAYS = 30;

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
        <div className="px-5 py-6 text-center text-sm text-slate-400">{empty ?? 'No data'}</div>
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

  // 30d rolling window — `to` is now, `from` is 29 days back so the chart
  // shows 30 inclusive UTC buckets (today + 29 prior days).
  const to = new Date();
  const from = new Date(to.getTime() - (GROWTH_WINDOW_DAYS - 1) * 86_400_000);

  let metrics;
  let started;
  let expired;
  let purchasesStarted;
  try {
    [metrics, started, expired, purchasesStarted] = await Promise.all([
      client.getActiveMetrics(),
      client.getStartedMetrics(from, to, { groupBy: 'day' }),
      client.getExpiredMetrics(from, to, { groupBy: 'day' }),
      client.getPurchasesStartedMetrics(from, to, { groupBy: 'day' }),
    ]);
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
          Live entitled count and group distribution. Refreshes on each load.
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
        <GrowthChart started={started.buckets ?? []} expired={expired.buckets ?? []} />
        <PurchasesChart buckets={purchasesStarted.buckets ?? []} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <DistributionTable
          title="By product (active subscriptions)"
          data={metrics.byProduct}
          empty="No active subscriptions"
        />
        <DistributionTable
          title="By product (non-consumable)"
          data={metrics.byProductPurchases}
          empty="No lifetime purchases"
        />
        <DistributionTable
          title="By platform (subs + non-consumable)"
          data={metrics.byPlatform}
          empty="No data"
        />
      </div>
    </div>
  );
}
