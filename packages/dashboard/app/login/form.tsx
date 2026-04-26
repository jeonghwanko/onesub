'use client';

import { useActionState } from 'react';
import { login, type LoginState } from './actions';

const initialState: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="secret" className="text-sm font-medium text-slate-700">
          Admin secret
        </label>
        <input
          id="secret"
          name="secret"
          type="password"
          autoComplete="off"
          autoFocus
          required
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      </div>
      {state.error ? (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {pending ? 'Verifying…' : 'Sign in'}
      </button>
    </form>
  );
}
