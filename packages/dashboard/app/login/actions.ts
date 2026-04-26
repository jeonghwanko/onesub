'use server';

import { redirect } from 'next/navigation';
import { verifyAdminSecret, writeAdminSecret } from '../../lib/auth';

export interface LoginState {
  error: string | null;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const secret = formData.get('secret');
  if (typeof secret !== 'string' || secret.length === 0) {
    return { error: 'Admin secret is required.' };
  }

  const result = await verifyAdminSecret(secret);
  if (!result.ok) {
    return { error: result.reason };
  }

  await writeAdminSecret(secret);
  redirect('/dashboard');
}
