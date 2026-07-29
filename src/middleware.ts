import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { UserRole } from '@/types';

const ROUTE_PERMISSIONS: { prefix: string; allowedRoles: UserRole[] }[] = [
  { prefix: '/admin', allowedRoles: ['admin'] },
  { prefix: '/campaigns/create', allowedRoles: ['ngo', 'admin'] },
  { prefix: '/beneficiary', allowedRoles: ['beneficiary', 'admin'] },
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const matchedRoute = ROUTE_PERMISSIONS.find((route) =>
    pathname.startsWith(route.prefix)
  );

  if (!matchedRoute) {
    return NextResponse.next();
  }

  const roleCookie = request.cookies.get('auth-role')?.value as UserRole | undefined;

  if (!roleCookie || !matchedRoute.allowedRoles.includes(roleCookie)) {
    const authUrl = new URL('/auth', request.url);
    authUrl.searchParams.set('unauthorized', 'true');
    return NextResponse.redirect(authUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/campaigns/create', '/beneficiary/:path*'],
};
