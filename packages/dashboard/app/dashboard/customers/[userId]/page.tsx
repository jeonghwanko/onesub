import Link from 'next/link';
import { redirect } from 'next/navigation';
import type {
  CustomerProfileResponse,
  EntitlementStatus,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { requireClient, clearAdminSecret } from '../../../../lib/auth';
import { OneSubFetchError } from '../../../../lib/onesub-client';
import { GrantForm } from './_components/grant-form';
import { PurchaseActions } from './_components/purchase-actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ userId: string }>;
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
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function relativeFromNow(iso: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const diffMs = target - Date.now();
  const days = Math.round(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days > 0)  return `in ${days}d`;
  return `${-days}d ago`;
}

export default async function CustomerDetailPage({ params }: PageProps) {
  const { userId } = await params;

  const client = await requireClient();
  let profile: CustomerProfileResponse;
  try {
    profile = await client.getCustomer(userId);
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 401) {
      await clearAdminSecret();
      redirect('/login');
    }
    throw err;
  }

  const isEmpty = profile.subscriptions.length === 0 && profile.purchases.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/customers" className="text-sm text-slate-500 underline-offset-2 hover:underline">
          ← Customers
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Customer</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">{profile.userId}</p>
      </div>

      {isEmpty ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          No subscriptions or purchases found for this user.
        </div>
      ) : null}

      <GrantForm userId={profile.userId} />

      {profile.entitlements ? <EntitlementsCard entitlements={profile.entitlements} /> : null}

      {profile.subscriptions.length > 0 ? (
        <SubscriptionsCard subscriptions={profile.subscriptions} />
      ) : null}

      {profile.purchases.length > 0 ? (
        <PurchasesCard purchases={profile.purchases} currentUserId={profile.userId} />
      ) : null}
    </div>
  );
}

// ─── Cards ──────────────────────────────────────────────────────────────────

function EntitlementsCard({ entitlements }: { entitlements: Record<string, EntitlementStatus> }) {
  const entries = Object.entries(entitlements);
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
        Entitlements
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <Th>id</Th>
            <Th>active</Th>
            <Th>source</Th>
            <Th>productId</Th>
            <Th>expiresAt</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([id, e]) => (
            <tr key={id} className="border-t border-slate-100">
              <Td>{id}</Td>
              <Td>
                <span
                  className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                    e.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {e.active ? 'yes' : 'no'}
                </span>
              </Td>
              <Td className="text-slate-500">{e.source ?? '—'}</Td>
              <Td className="font-mono text-xs">{e.productId ?? '—'}</Td>
              <Td className="font-mono tabular-nums text-xs">
                {e.expiresAt ? `${e.expiresAt.slice(0, 10)} (${relativeFromNow(e.expiresAt)})` : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function SubscriptionsCard({ subscriptions }: { subscriptions: SubscriptionInfo[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
        Subscriptions <span className="ml-1 text-xs font-normal text-slate-400">({subscriptions.length})</span>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <Th>productId</Th>
            <Th>status</Th>
            <Th>platform</Th>
            <Th>expiresAt</Th>
            <Th>willRenew</Th>
            <Th>txId</Th>
          </tr>
        </thead>
        <tbody>
          {subscriptions.map((s) => {
            const detailHref = `/dashboard/subscriptions/${encodeURIComponent(s.originalTransactionId)}`;
            return (
              <tr key={s.originalTransactionId} className="border-t border-slate-100 hover:bg-slate-50" title={s.expiresAt}>
                <Td>
                  <Link href={detailHref} className="hover:underline">{s.productId}</Link>
                </Td>
                <Td><StatusBadge status={s.status} /></Td>
                <Td>{s.platform}</Td>
                <Td className="font-mono tabular-nums text-xs">
                  {s.expiresAt.slice(0, 10)} <span className="text-slate-400">({relativeFromNow(s.expiresAt)})</span>
                </Td>
                <Td>{s.willRenew ? 'yes' : 'no'}</Td>
                <Td className="font-mono text-xs text-slate-500">
                  <Link href={detailHref} className="hover:underline">{s.originalTransactionId}</Link>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function PurchasesCard({ purchases, currentUserId }: { purchases: PurchaseInfo[]; currentUserId: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
        Purchases <span className="ml-1 text-xs font-normal text-slate-400">({purchases.length})</span>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <Th>productId</Th>
            <Th>type</Th>
            <Th>platform</Th>
            <Th>quantity</Th>
            <Th>purchasedAt</Th>
            <Th>transactionId</Th>
            <Th>actions</Th>
          </tr>
        </thead>
        <tbody>
          {purchases.map((p) => (
            <tr key={p.transactionId} className="border-t border-slate-100">
              <Td>{p.productId}</Td>
              <Td className="text-xs text-slate-500">{p.type}</Td>
              <Td>{p.platform}</Td>
              <Td className="font-mono tabular-nums">{p.quantity}</Td>
              <Td className="font-mono tabular-nums text-xs">
                {p.purchasedAt.slice(0, 10)} <span className="text-slate-400">({relativeFromNow(p.purchasedAt)})</span>
              </Td>
              <Td className="font-mono text-xs text-slate-500">{p.transactionId}</Td>
              <Td><PurchaseActions purchase={p} currentUserId={currentUserId} /></Td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>;
}
