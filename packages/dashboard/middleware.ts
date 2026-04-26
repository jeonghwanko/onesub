import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME } from './lib/auth';

/**
 * Edge middleware — bounces unauthenticated `/dashboard/*` requests to /login
 * before any server component runs. Avoids a flicker of skeleton UI for users
 * whose session expired.
 *
 * The cookie is treated as "present = authenticated" here; full validation
 * (probe the onesub server) happens in `requireClient()` on the server
 * component side, which then re-redirects on 401. Edge middleware doesn't get
 * to do upstream HTTP, so this two-layer guard is intentional.
 */
export function middleware(req: NextRequest): NextResponse {
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
