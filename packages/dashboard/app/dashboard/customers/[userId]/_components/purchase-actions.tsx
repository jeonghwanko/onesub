'use client';

import { useActionState, useState } from 'react';
import type { PurchaseInfo } from '@onesub/shared';
import {
  deletePurchasesAction,
  transferPurchaseAction,
  type ActionResult,
} from '../../../../../lib/admin-actions';
import { ResultBanner, SubmitButton } from './grant-form';

interface PurchaseActionsProps {
  purchase: PurchaseInfo;
  /** Current page's userId — used to redirect/revalidate the right path. */
  currentUserId: string;
}

export function PurchaseActions({ purchase, currentUserId }: PurchaseActionsProps) {
  const [open, setOpen] = useState<'transfer' | 'delete' | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(open === 'transfer' ? null : 'transfer')}
        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        Transfer
      </button>
      <button
        type="button"
        onClick={() => setOpen(open === 'delete' ? null : 'delete')}
        className="rounded border border-rose-300 bg-white px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50"
      >
        Delete
      </button>

      {open === 'transfer' ? (
        <TransferDialog purchase={purchase} currentUserId={currentUserId} onClose={() => setOpen(null)} />
      ) : null}
      {open === 'delete' ? (
        <DeleteDialog purchase={purchase} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function TransferDialog({
  purchase,
  currentUserId,
  onClose,
}: {
  purchase: PurchaseInfo;
  currentUserId: string;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(transferPurchaseAction, null);

  return (
    <Backdrop onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Transfer purchase</h2>
      <p className="mt-1 text-xs text-slate-500">
        디바이스 마이그레이션 / 계정 병합 시 transactionId의 소유자를 다른 userId로 이전.
      </p>
      <dl className="mt-3 space-y-1 text-xs text-slate-600">
        <Pair label="transactionId" value={purchase.transactionId} />
        <Pair label="productId" value={purchase.productId} />
        <Pair label="현재 owner" value={purchase.userId} />
      </dl>
      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="transactionId" value={purchase.transactionId} />
        <input type="hidden" name="fromUserId" value={currentUserId} />
        <label className="block text-xs font-medium text-slate-600">
          <span>새 userId</span>
          <input
            type="text"
            name="newUserId"
            required
            autoFocus
            autoComplete="off"
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs shadow-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
        </label>
        <ResultBanner state={state} successMessage="transfer 완료 — 페이지가 갱신됩니다" />
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <SubmitButton label="Transfer" />
        </div>
      </form>
    </Backdrop>
  );
}

function DeleteDialog({ purchase, onClose }: { purchase: PurchaseInfo; onClose: () => void }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(deletePurchasesAction, null);

  return (
    <Backdrop onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Delete purchases</h2>
      <p className="mt-1 text-xs text-slate-500">
        이 user의 <strong className="text-slate-700">{purchase.productId}</strong> 모든 purchase row가 삭제됩니다 (non-consumable 재테스트용).
      </p>
      <dl className="mt-3 space-y-1 text-xs text-slate-600">
        <Pair label="userId" value={purchase.userId} />
        <Pair label="productId" value={purchase.productId} />
      </dl>
      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="userId" value={purchase.userId} />
        <input type="hidden" name="productId" value={purchase.productId} />
        <ResultBanner state={state} successMessage="삭제 완료 — 페이지가 갱신됩니다" />
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <SubmitButton label="Delete" danger />
        </div>
      </form>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      // Click-outside to close — onClose is the user's intent. The inner panel
      // stops propagation so clicking inside doesn't dismiss.
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-800">{value}</dd>
    </div>
  );
}
