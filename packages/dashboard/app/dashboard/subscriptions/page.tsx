import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ListSubscriptionsQuery, SubscriptionInfo } from '@onesub/shared';
import { requireClient, clearAdminSecret } from '../../../lib/auth';
import { OneSubFetchError } from '../../../lib/onesub-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const STATUSES = [
  '', 'active', 'grace_period', 'on_hold', 'paused', 'expired', 'canceled',
] as const;

const PLATFORMS = ['', 'apple', 'google'] as const;

interface PageProps {
  searchParams: Promise<{
    userId?: string;
    status?: string;
    productId?: string;
    platform?: string;
    offset?: string;
  }>;
}

function parseQuery(raw: Awaited<PageProps['searchParams']>): ListSubscriptionsQuery {
  const out: ListSubscriptionsQuery = { limit: PAGE_SIZE };
  if (raw.userId)    out.userId = raw.userId;
  if (raw.productId) out.productId = raw.productId;
  // status / platform are validated server-side; we just pass them through.
  if (raw.status && raw.status !== '')   out.status = raw.status as ListSubscriptionsQuery['status'];
  if (raw.platform && raw.platform !== '') out.platform = raw.platform as ListSubscriptionsQuery['platform'];
  if (raw.offset) {
    const n = parseInt(raw.offset, 10);
    if (Number.isFinite(n) && n >= 0) out.offset = n;
  }
  return out;
}

function formatExpiry(iso: string): string {
  // Compact YYYY-MM-DD for table cells; the full ISO string lives in the row's
  // title attribute so operators can hover for the precise instant.
  return iso.slice(0, 10);
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

export default async function SubscriptionsPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const query = parseQuery(raw);

  const client = await requireClient();
  let result;
  try {
    result = await client.listSubscriptions(query);
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 401) {
      await clearAdminSecret();
      redirect('/login');
    }
    throw err;
  }

  const offset = query.offset ?? 0;
  const limit = query.limit ?? PAGE_SIZE;
  const hasPrev = offset > 0;
  const hasNext = offset + limit < result.total;
  const start = result.total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, result.total);

  function pageHref(targetOffset: number): string {
    const params = new URLSearchParams();
    if (query.userId)    params.set('userId', query.userId);
    if (query.status)    params.set('status', query.status);
    if (query.productId) params.set('productId', query.productId);
    if (query.platform)  params.set('platform', query.platform);
    if (targetOffset > 0) params.set('offset', String(targetOffset));
    const qs = params.toString();
    return qs ? `/dashboard/subscriptions?${qs}` : '/dashboard/subscriptions';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <p className="mt-1 text-sm text-slate-500">
          All subscription records. Filters and pagination sync with URL params.
        </p>
      </div>

      {/* GET form — submits as URL params, page re-renders server-side */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <FilterInput name="userId" label="userId" defaultValue={query.userId} />
        <FilterSelect name="status" label="status" options={STATUSES} defaultValue={query.status ?? ''} />
        <FilterInput name="productId" label="productId" defaultValue={query.productId} />
        <FilterSelect name="platform" label="platform" options={PLATFORMS} defaultValue={query.platform ?? ''} />
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          Apply
        </button>
        {(query.userId || query.status || query.productId || query.platform) ? (
          <Link
            href="/dashboard/subscriptions"
            className="text-sm text-slate-500 underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <Th>userId</Th>
              <Th>productId</Th>
              <Th>status</Th>
              <Th>platform</Th>
              <Th>expiresAt</Th>
              <Th>willRenew</Th>
              <Th>originalTransactionId</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-8 text-center text-slate-400">
                  No subscriptions match the current filters.
                </td>
              </tr>
            ) : (
              result.items.map((s) => {
                const detailHref = `/dashboard/subscriptions/${encodeURIComponent(s.originalTransactionId)}`;
                const customerHref = `/dashboard/customers/${encodeURIComponent(s.userId)}`;
                return (
                  <tr
                    key={s.originalTransactionId}
                    className="border-t border-slate-100 hover:bg-slate-50"
                    title={s.expiresAt}
                  >
                    {/* userId points at the per-user view; productId / txId stay on the
                        per-subscription detail. Lets operators pivot to either drill-down. */}
                    <Td className="font-mono text-xs">
                      <Link href={customerHref} className="hover:underline">{s.userId}</Link>
                    </Td>
                    <Td><Link href={detailHref} className="hover:underline">{s.productId}</Link></Td>
                    <Td><StatusBadge status={s.status} /></Td>
                    <Td>{s.platform}</Td>
                    <Td className="font-mono tabular-nums">{formatExpiry(s.expiresAt)}</Td>
                    <Td>{s.willRenew ? 'yes' : 'no'}</Td>
                    <Td className="font-mono text-xs text-slate-500">
                      <Link href={detailHref} className="hover:underline">{s.originalTransactionId}</Link>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <div>
          {result.total === 0 ? '0 results' : `${start.toLocaleString()}–${end.toLocaleString()} of ${result.total.toLocaleString()}`}
        </div>
        <div className="flex gap-2">
          <PageLink href={pageHref(Math.max(0, offset - limit))} disabled={!hasPrev}>← Prev</PageLink>
          <PageLink href={pageHref(offset + limit)} disabled={!hasNext}>Next →</PageLink>
        </div>
      </div>
    </div>
  );
}

// ─── small UI bits ──────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>;
}

interface FilterInputProps {
  name: string;
  label: string;
  defaultValue?: string;
}
function FilterInput({ name, label, defaultValue }: FilterInputProps) {
  return (
    <label className="flex flex-col text-xs font-medium text-slate-600">
      <span>{label}</span>
      <input
        type="text"
        name={name}
        defaultValue={defaultValue ?? ''}
        autoComplete="off"
        className="mt-1 block w-44 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
      />
    </label>
  );
}

interface FilterSelectProps {
  name: string;
  label: string;
  options: readonly string[];
  defaultValue: string;
}
function FilterSelect({ name, label, options, defaultValue }: FilterSelectProps) {
  return (
    <label className="flex flex-col text-xs font-medium text-slate-600">
      <span>{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block w-36 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt === '' ? 'any' : opt}</option>
        ))}
      </select>
    </label>
  );
}

interface PageLinkProps {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}
function PageLink({ href, disabled, children }: PageLinkProps) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-md border border-slate-200 bg-white px-3 py-1.5 text-slate-300">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-slate-700 shadow-sm hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
