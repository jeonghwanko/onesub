import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white px-4 py-6">
        <Link href="/dashboard" className="block text-lg font-semibold tracking-tight">
          onesub
        </Link>
        <nav className="mt-8 space-y-1 text-sm">
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Overview
          </Link>
          <Link
            href="/dashboard/subscriptions"
            className="block rounded-md px-3 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Subscriptions
          </Link>
          <Link
            href="/dashboard/customers"
            className="block rounded-md px-3 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Customers
          </Link>
        </nav>
        <form action="/api/logout" method="post" className="mt-12">
          <button
            type="submit"
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            Sign out
          </button>
        </form>
      </aside>
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
