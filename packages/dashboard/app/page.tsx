import { redirect } from 'next/navigation';
import { readAdminSession } from '../lib/auth';

/**
 * Root entry — bounce to /dashboard if a session exists, /login otherwise.
 * Lets bookmark-the-domain users land in the right place.
 */
export default async function Home() {
  const session = await readAdminSession();
  redirect(session ? '/dashboard' : '/login');
}
