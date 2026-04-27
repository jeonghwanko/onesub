import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Sidebar — horizontal nav strip on mobile (top), vertical rail on lg+. */}
      <aside className="border-b border-slate-200 bg-white lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 lg:block lg:px-4 lg:py-6">
          <Link href="/dashboard" className="block text-lg font-semibold tracking-tight">
            onesub
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm lg:mt-8 lg:flex-col lg:gap-0 lg:space-y-1">
            <NavLink href="/dashboard">Overview</NavLink>
            <NavLink href="/dashboard/subscriptions">Subscriptions</NavLink>
            <NavLink href="/dashboard/customers">Customers</NavLink>
          </nav>
          <form action="/api/logout" method="post" className="ml-auto lg:ml-0 lg:mt-12">
            <button
              type="submit"
              className="block rounded-md px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:w-full lg:text-left"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 font-medium text-slate-700 hover:bg-slate-100"
    >
      {children}
    </Link>
  );
}
