import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireClient } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ userId?: string }>;
}

// Server action: GET form posts here, we redirect to the detail page.
// (Form `method="get"` bakes userId into the URL — but we want a clean
// /dashboard/customers/{userId} path, so handle the redirect server-side.)
async function navigateToCustomer(formData: FormData): Promise<void> {
  'use server';
  const raw = formData.get('userId');
  if (typeof raw !== 'string') return;
  const userId = raw.trim();
  if (!userId) return;
  redirect(`/dashboard/customers/${encodeURIComponent(userId)}`);
}

export default async function CustomersPage({ searchParams }: PageProps) {
  // Cookie probe — bounces to /login if not authenticated. The client itself
  // isn't used on this page (no fetch needed for the empty search view).
  await requireClient();

  const { userId } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-slate-500">
          userId로 검색해 그 유저의 모든 구독·구매·entitlement을 한 화면에 봅니다.
        </p>
      </div>

      <form action={navigateToCustomer} className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="flex flex-col text-xs font-medium text-slate-600">
          <span>userId</span>
          <input
            type="text"
            name="userId"
            defaultValue={userId ?? ''}
            autoComplete="off"
            autoFocus
            placeholder="device id / user id"
            className="mt-1 block w-80 rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          Open
        </button>
      </form>

      <div className="rounded-lg border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        검색해 사용자 상세를 열어주세요. <br />
        <Link href="/dashboard/subscriptions" className="mt-2 inline-block text-slate-500 underline-offset-2 hover:underline">
          또는 구독 리스트에서 userId 클릭
        </Link>
      </div>
    </div>
  );
}
