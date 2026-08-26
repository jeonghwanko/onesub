import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME } from './lib/session-constants';

/**
 * Optimistic proxy guard — bounces unauthenticated `/dashboard/*` requests to
 * /login before any server component runs. Avoids a flicker of skeleton UI for
 * users whose session expired.
 *
 * The cookie is treated as "present = authenticated" here; authenticated
 * decryption happens in `requireSession()`, and pages that fetch upstream clear
 * stale sessions on a 401. The proxy deliberately cannot decrypt the Node.js
 * session envelope, so this first layer stays cheap and full validation remains
 * server-side.
 */
export function proxy(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith('/dashboard')) {
    const cookie = req.cookies.get(COOKIE_NAME);
    if (!cookie) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
