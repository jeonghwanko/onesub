'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { grantPurchaseAction, type ActionResult } from '../../../../../lib/admin-actions';

interface GrantFormProps {
  userId: string;
}

export function GrantForm({ userId }: GrantFormProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(grantPurchaseAction, null);

  return (
    <details className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
        Grant non-consumable purchase
        <span className="ml-2 text-xs font-normal text-slate-400">
          영수증 검증 우회. 환불 보상 / 굿윌 / 베타 지급용
        </span>
      </summary>
      <form action={formAction} className="space-y-3 border-t border-slate-100 px-5 py-4">
        <input type="hidden" name="userId" value={userId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="productId" name="productId" placeholder="lifetime_pass" required />
          <Field label="platform">
            <select
              name="platform"
              required
              defaultValue="apple"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            >
              <option value="apple">apple</option>
              <option value="google">google</option>
            </select>
          </Field>
          <Field label="type">
            <select
              name="type"
              defaultValue="non_consumable"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            >
              <option value="non_consumable">non_consumable</option>
              <option value="consumable">consumable</option>
            </select>
          </Field>
          <Field
            label="transactionId (optional)"
            name="transactionId"
            placeholder="비우면 admin_grant_<랜덤> 생성"
          />
        </div>
        <ResultBanner state={state} successMessage="grant 완료 — 페이지가 갱신됩니다" />
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">
            ⚠ 영수증 없이 entitlement을 부여합니다. CS 결정 후에만 사용.
          </span>
          <SubmitButton label="Grant" />
        </div>
      </form>
    </details>
  );
}

interface FieldProps {
  label: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  children?: React.ReactNode;
}
function Field({ label, name, placeholder, required, children }: FieldProps) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      <span>{label}</span>
      {children ?? (
        <input
          type="text"
          name={name}
          placeholder={placeholder}
          required={required}
          autoComplete="off"
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
      )}
    </label>
  );
}

export function ResultBanner({ state, successMessage }: { state: ActionResult | null; successMessage: string }) {
  if (!state) return null;
  if (state.ok) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        ✓ {successMessage}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
      ✕ {state.error ?? '실패'}
    </div>
  );
}

export function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const tone = danger
    ? 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300'
    : 'bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300';
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md ${tone} px-4 py-1.5 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed`}
    >
      {pending ? '처리 중…' : label}
    </button>
  );
}
