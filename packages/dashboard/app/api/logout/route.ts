import { type NextRequest, NextResponse } from 'next/server';
import { clearAdminSecret } from '../../../lib/auth';

/**
 * Sign out — clear the cookie + bounce to /login. Uses the incoming request
 * URL as origin so the redirect works behind any reverse proxy / on any port
 * without hardcoding the dashboard's public hostname.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  await clearAdminSecret();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}
