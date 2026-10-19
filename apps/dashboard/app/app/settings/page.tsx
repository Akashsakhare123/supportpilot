'use client';

import { HANDOFF_THRESHOLD, roleAtLeast, type TenantBranding } from '@supportpilot/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { BrandingForm } from '@/components/tenant/branding-form';
import { DomainsEditor } from '@/components/tenant/domains-editor';
import { EmbedSnippet } from '@/components/tenant/embed-snippet';
import { WidgetPreview } from '@/components/tenant/widget-preview';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { useTenantSettings } from '@/lib/tenant';

type Status = { tone: 'success' | 'error'; text: string } | null;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      {children}
    </Card>
  );
}

export default function SettingsPage() {
  const { user, reloadUser } = useAuth();
  const { settings, error, update, rotateKey } = useTenantSettings();
  const [name, setName] = useState('');
  const [branding, setBranding] = useState<Required<TenantBranding> | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [threshold, setThreshold] = useState<number>(HANDOFF_THRESHOLD.default);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [confirmRotate, setConfirmRotate] = useState(false);

  useEffect(() => {
    if (settings && branding === null) {
      setName(settings.name);
      setBranding(settings.branding);
      setDomains(settings.allowedDomains);
      setThreshold(settings.handoffThreshold);
    }
  }, [settings, branding]);

  if (user && !roleAtLeast(user.role, 'admin'))
    return <Alert>Only admins and owners can change settings.</Alert>;
  if (error) return <Alert>{error}</Alert>;
  if (!settings || !branding) return <p className="text-sm text-slate-500">Loading...</p>;

  async function run(section: string, action: () => Promise<unknown>, done: string) {
    setStatus((s) => ({ ...s, [section]: null }));
    try {
      await action();
      setStatus((s) => ({ ...s, [section]: { tone: 'success', text: done } }));
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [section]: { tone: 'error', text: err instanceof Error ? err.message : 'Could not save' },
      }));
    }
  }

  const note = (section: string) => {
    const s = status[section];
    return s ? <Alert tone={s.tone}>{s.text}</Alert> : null;
  };

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Section title="Company" description="Shown in the widget header and to your team.">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="company">Company name</Label>
            <Input
              id="company"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </div>
          <Button
            onClick={() =>
              run(
                'company',
                async () => {
                  await update({ name });
                  await reloadUser();
                },
                'Saved',
              )
            }
          >
            Save
          </Button>
        </div>
        {note('company')}
      </Section>

      <Section
        title="Widget branding"
        description="Colours, greeting and position of the chat widget on your site."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <BrandingForm value={branding} onChange={setBranding} />
          <WidgetPreview branding={branding} companyName={name} />
        </div>
        <Button onClick={() => run('branding', () => update({ branding }), 'Branding saved')}>
          Save branding
        </Button>
        {note('branding')}
      </Section>

      <Section
        title="Allowed domains"
        description="Only these websites can load your widget. Requests from other sites are refused."
      >
        <DomainsEditor value={domains} onChange={setDomains} />
        <Button
          onClick={() => run('domains', () => update({ allowedDomains: domains }), 'Domains saved')}
        >
          Save domains
        </Button>
        {note('domains')}
      </Section>

      <Section
        title="Hand-off to your team"
        description="Answers below this confidence are flagged for a person; two in a row (or a customer asking for a person) move the chat to your inbox."
      >
        <div className="flex flex-wrap items-center gap-4">
          <input
            type="range"
            aria-label="Confidence threshold"
            min={HANDOFF_THRESHOLD.min}
            max={HANDOFF_THRESHOLD.max}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-64 accent-brand"
          />
          <span className="w-14 text-sm font-semibold">{Math.round(threshold * 100)}%</span>
          <Button
            onClick={() =>
              run('handoff', () => update({ handoffThreshold: threshold }), 'Threshold saved')
            }
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          Lower = the AI answers more on its own. Higher = your team sees more conversations.
          Default {Math.round(HANDOFF_THRESHOLD.default * 100)}%.
        </p>
        {note('handoff')}
      </Section>

      <Section
        title="Install the widget"
        description="Your public widget key identifies your workspace. It is safe to put in your website's HTML."
      >
        <p className="text-sm">
          Widget key:{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5">{settings.publicKey}</code>
        </p>
        <EmbedSnippet publicKey={settings.publicKey} />
        {!confirmRotate ? (
          <Button variant="outline" onClick={() => setConfirmRotate(true)}>
            Rotate key
          </Button>
        ) : (
          <Alert tone="info" className="space-y-3">
            <p>
              The current key stops working immediately. Every website using the old snippet must be
              updated.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  run(
                    'key',
                    async () => {
                      await rotateKey();
                      setConfirmRotate(false);
                    },
                    'New key created. Update the snippet on your website.',
                  )
                }
              >
                Rotate now
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRotate(false)}>
                Cancel
              </Button>
            </div>
          </Alert>
        )}
        {note('key')}
      </Section>
    </div>
  );
}
