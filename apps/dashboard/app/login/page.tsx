'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';

/** Only redirect inside the app after login (prevents open redirects via ?next=). */
function safeNext(value: string | null): string {
  return value && value.startsWith('/app') && !value.startsWith('//') ? value : '/app';
}

function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await login(String(form.get('email')), String(form.get('password')));
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <p className="text-sm font-semibold tracking-wide text-brand uppercase">SupportPilot</p>
      <h1 className="mt-1 text-xl font-bold">Log in to your dashboard</h1>
      <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Logging in...' : 'Log in'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        New to SupportPilot?{' '}
        <Link href="/signup" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
      {process.env.NODE_ENV !== 'production' && (
        <Alert tone="info" className="mt-6">
          Demo (after <code>pnpm db:seed</code>): owner@acme.test, admin@acme.test or
          agent@acme.test, password <code>Password123!</code>
        </Alert>
      )}
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
