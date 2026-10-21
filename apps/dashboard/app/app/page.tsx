'use client';

import { roleAtLeast } from '@supportpilot/shared';
import Link from 'next/link';
import { EmbedSnippet } from '@/components/tenant/embed-snippet';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useTenantSettings } from '@/lib/tenant';

function InstallCard() {
  const { settings } = useTenantSettings();
  if (!settings) return null;
  return (
    <Card className="space-y-3 md:col-span-2">
      <div>
        <CardTitle>Install your widget</CardTitle>
        <CardDescription>
          Paste this on your website. Branding and allowed domains are in{' '}
          <Link href="/app/settings" className="text-brand hover:underline">
            Settings
          </Link>
          .
        </CardDescription>
      </div>
      <EmbedSnippet publicKey={settings.publicKey} />
    </Card>
  );
}

const ROLE_SUMMARY = {
  owner: 'Full access: team, settings, knowledge base, billing and the inbox.',
  admin: 'Manage the team (invite agents), settings, knowledge base and the inbox.',
  agent: 'Answer customers in the inbox when the AI hands a conversation over.',
} as const;

export default function OverviewPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome, {user.name.split(' ')[0]}</h1>
        <p className="mt-1 text-slate-500">
          {user.tenant.name} · signed in as <strong>{user.role}</strong>
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Your access</CardTitle>
          <CardDescription>{ROLE_SUMMARY[user.role]}</CardDescription>
        </Card>
        {roleAtLeast(user.role, 'admin') && (
          <Card>
            <CardTitle>Next up</CardTitle>
            <CardDescription>
              Check{' '}
              <Link href="/app/analytics" className="text-brand hover:underline">
                Analytics
              </Link>{' '}
              for questions the AI could not answer, and add a help article for each one.
            </CardDescription>
          </Card>
        )}
        {roleAtLeast(user.role, 'admin') && <InstallCard />}
      </div>
    </div>
  );
}
