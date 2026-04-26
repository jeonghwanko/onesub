import { LoginForm } from './form';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">onesub</h1>
          <p className="text-sm text-slate-500">
            Operator login — paste the <code className="rounded bg-slate-200 px-1">adminSecret</code> from your server config.
          </p>
        </div>
        <LoginForm />
        <p className="text-xs text-slate-400 text-center">
          The secret is stored in an HTTP-only cookie for this browser session
          and never leaves the dashboard server.
        </p>
      </div>
    </div>
  );
}
