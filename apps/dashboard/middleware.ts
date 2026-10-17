import { REFRESH_COOKIE } from '@supportpilot/shared';
import { type NextRequest, NextResponse } from 'next/server';

/** Signed-out visitors of /app are sent to /login (the API still checks every request). */
export function middleware(request: NextRequest) {
  if (request.cookies.has(REFRESH_COOKIE)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/app/:path*'] };
