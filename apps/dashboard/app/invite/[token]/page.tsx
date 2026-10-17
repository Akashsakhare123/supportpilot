'use client';

import type { InvitePreview, LoginResponse } from '@supportpilot/shared';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readError, useAuth } from '@/lib/auth';

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const { setSession } = useAuth();
  const router = useRouter();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch(`/api/auth/invites/${encodeURIComponent(token)}`)
      .then(async (res) =>
        res.ok
          ? setInvite((await res.json()) as InvitePreview)
          : setLoadError(await readError(res)),
      )
      .catch(() => setLoadError('Could not reach the server'));
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirm')) {
      setError('Passwords do not match');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: form.get('name'), password: form.get('password') }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSession((await res.json()) as LoginResponse);
      router.replace('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invite');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <p className="text-sm font-semibold tracking-wide text-brand uppercase">SupportPilot</p>
        {loadError && <Alert className="mt-4">{loadError}</Alert>}
        {!invite && !loadError && (
          <p className="mt-4 text-sm text-slate-500">Checking your invite...</p>
        )}
        {invite && (
          <>
            <h1 className="mt-1 text-xl font-bold">Join {invite.tenantName}</h1>
            <p className="mt-1 text-sm text-slate-500">
              You were invited as <strong>{invite.role}</strong> ({invite.email}).
            </p>
            <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password (8+ characters)</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </div>
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? 'Creating account...' : 'Create account'}
              </Button>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}
