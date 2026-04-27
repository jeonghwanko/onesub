import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { SubscriptionInfo } from '@onesub/shared';
import { requireClient, clearAdminSecret } from '../../../../lib/auth';
import { OneSubFetchError } from '../../../../lib/onesub-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ transactionId: string }>;
}

function StatusBadge({ status }: { status: SubscriptionInfo['status'] }) {
  const styles: Record<SubscriptionInfo['status'], string> = {
    active:        'bg-emerald-100 text-emerald-800',
    grace_period:  'bg-amber-100 text-amber-800',
    on_hold:       'bg-rose-100 text-rose-800',
    paused:        'bg-sky-100 text-sky-800',
    expired:       'bg-slate-200 text-slate-600',
    canceled:      'bg-slate-200 text-slate-600',
    none:          'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`inline-block rounded px-2.5 py-1 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

// Returns "in 14 days" / "12 days ago" / "today". Operators eyeball the table
// faster with a relative anchor next to the absolute timestamp.
function relativeFromNow(iso: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const diffMs = target - Date.now();
  const days = Math.round(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days > 0)  return `in ${days} day${days === 1 ? '' : 's'}`;
  return `${-days} day${days === -1 ? '' : 's'} ago`;
}

export default async function SubscriptionDetailPage({ params }: PageProps) {
  const { transactionId } = await params;

  const client = await requireClient();
  let sub: SubscriptionInfo;
  try {
    sub = await client.getSubscription(transactionId);
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 401) {
      await clearAdminSecret();
      redirect('/login');
    }
    if (err instanceof OneSubFetchError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  // Pivot link to the per-customer view (subs + purchases + entitlements in one
  // round-trip) — more useful than a filtered subs list when investigating
  // a specific user's full state.
  const customerHref = `/dashboard/customers/${encodeURIComponent(sub.userId)}`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/subscriptions"
          className="text-sm text-slate-500 underline-offset-2 hover:underline"
        >
          ← Subscriptions
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Subscription detail</h1>
          <StatusBadge status={sub.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-slate-500">{sub.originalTransactionId}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailCard title="Identity">
          <Row label="userId">
            <span className="font-mono">{sub.userId}</span>
            <Link
              href={customerHref}
              className="ml-2 text-xs text-brand-600 underline-offset-2 hover:underline"
            >
              상세 보기
            </Link>
          </Row>
          <Row label="productId">{sub.productId}</Row>
          <Row label="platform">{sub.platform}</Row>
          <Row label="originalTransactionId">
            <span className="font-mono text-xs">{sub.originalTransactionId}</span>
          </Row>
        </DetailCard>

        <DetailCard title="Lifecycle">
          <Row label="status"><StatusBadge status={sub.status} /></Row>
          <Row label="willRenew">{sub.willRenew ? 'yes' : 'no'}</Row>
          <Row label="purchasedAt">
            <span className="font-mono tabular-nums">{sub.purchasedAt}</span>
            <span className="ml-2 text-xs text-slate-400">{relativeFromNow(sub.purchasedAt)}</span>
          </Row>
          <Row label="expiresAt">
            <span className="font-mono tabular-nums">{sub.expiresAt}</span>
            <span className="ml-2 text-xs text-slate-400">{relativeFromNow(sub.expiresAt)}</span>
          </Row>
        </DetailCard>
      </div>

      {(sub.linkedPurchaseToken || sub.autoResumeTime) ? (
        <DetailCard title="Google-only fields">
          {sub.linkedPurchaseToken ? (
            <Row label="linkedPurchaseToken">
              <span className="font-mono text-xs">{sub.linkedPurchaseToken}</span>
            </Row>
          ) : null}
          {sub.autoResumeTime ? (
            <Row label="autoResumeTime">
              <span className="font-mono tabular-nums">{sub.autoResumeTime}</span>
              <span className="ml-2 text-xs text-slate-400">{relativeFromNow(sub.autoResumeTime)}</span>
            </Row>
          ) : null}
        </DetailCard>
      ) : null}
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">{title}</div>
      <div className="divide-y divide-slate-50">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-3 text-sm">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-right text-slate-900">{children}</span>
    </div>
  );
}
