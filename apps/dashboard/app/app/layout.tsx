'use client';

import { type Role, roleAtLeast } from '@supportpilot/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { RealtimeProvider, useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

const NAV: { href: string; label: string; minRole: Role }[] = [
  { href: '/app', label: 'Overview', minRole: 'agent' },
  { href: '/app/inbox', label: 'Inbox', minRole: 'agent' },
  { href: '/app/analytics', label: 'Analytics', minRole: 'admin' },
  { href: '/app/knowledge', label: 'Knowledge base', minRole: 'admin' },
  { href: '/app/playground', label: 'Test assistant', minRole: 'agent' },
  { href: '/app/team', label: 'Team', minRole: 'admin' },
  { href: '/app/settings', label: 'Settings', minRole: 'admin' },
  { href: '/app/billing', label: 'Billing', minRole: 'owner' },
];

/** Signed-in shell. Navigation is filtered by role; the API enforces the same rules. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  // Owners/admins of a new workspace finish the onboarding wizard first.
  const needsOnboarding =
    user !== null && !user.tenant.onboarded && roleAtLeast(user.role, 'admin');
  useEffect(() => {
    if (needsOnboarding && pathname !== '/app/onboarding') router.replace('/app/onboarding');
  }, [needsOnboarding, pathname, router]);

  if (status !== 'authenticated' || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading...
      </div>
    );
  }

  const items = NAV.filter((item) => roleAtLeast(user.role, item.minRole));

  return (
    <RealtimeProvider>
      <div className="flex min-h-screen">
        <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="px-5 py-5">
            <p className="text-sm font-bold tracking-wide text-brand uppercase">SupportPilot</p>
            <p className="mt-0.5 truncate text-xs text-slate-500">{user.tenant.name}</p>
          </div>
          <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
            {items.map((item) => {
              const active =
                item.href === '/app' ? pathname === '/app' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-3 py-2 text-sm font-medium',
                    active ? 'bg-brand-soft text-brand' : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-slate-200 p-4">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-slate-500">
              {user.email} · {user.role}
            </p>
            <PresenceToggle />
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={async () => {
                await logout();
                router.replace('/login');
              }}
            >
              Log out
            </Button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
      </div>
    </RealtimeProvider>
  );
}

/** Online / Away switch: away agents get no live hand-offs (customers are offered email). */
function PresenceToggle() {
  const { connected, myPresence, setMyPresence } = useRealtime();
  const options = [
    { value: 'online', label: 'Online', dot: 'bg-emerald-500' },
    { value: 'away', label: 'Away', dot: 'bg-amber-400' },
  ] as const;
  return (
    <div className="mt-3" role="radiogroup" aria-label="Your status">
      <div className="flex rounded-md border border-slate-200 p-0.5 text-xs">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={myPresence === o.value}
            onClick={() => setMyPresence(o.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 font-medium',
              myPresence === o.value ? 'bg-slate-100 text-slate-900' : 'text-slate-500',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', o.dot)} />
            {o.label}
          </button>
        ))}
      </div>
      {!connected && <p className="mt-1 text-[11px] text-amber-700">Connecting...</p>}
    </div>
  );
}
