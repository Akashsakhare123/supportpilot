'use client';

import type { TenantBranding } from '@supportpilot/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandingForm } from '@/components/tenant/branding-form';
import { DomainsEditor } from '@/components/tenant/domains-editor';
import { EmbedSnippet } from '@/components/tenant/embed-snippet';
import { WidgetPreview } from '@/components/tenant/widget-preview';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { useTenantSettings } from '@/lib/tenant';
import { cn } from '@/lib/utils';

const STEPS = ['Company', 'Branding', 'Install'] as const;

/** First-run wizard: company name -> widget branding -> allowed domains + embed snippet. */
export default function OnboardingPage() {
  const { reloadUser } = useAuth();
  const router = useRouter();
  const { settings, error: loadError, update } = useTenantSettings();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [branding, setBranding] = useState<Required<TenantBranding> | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (settings && branding === null) {
      setName(settings.name);
      setBranding(settings.branding);
      setDomains(settings.allowedDomains);
    }
  }, [settings, branding]);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!settings || !branding) return <p className="text-sm text-slate-500">Loading...</p>;

  async function save(patch: Parameters<typeof update>[0], next: () => void | Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await update(patch);
      await next();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Set up your support widget</h1>
        <p className="mt-1 text-slate-500">
          Three quick steps. You can change everything later in Settings.
        </p>
      </div>

      <ol className="flex gap-2" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'flex-1 rounded-md border px-3 py-2 text-sm font-medium',
              i === step && 'border-brand bg-brand-soft text-brand',
              i < step && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              i > step && 'border-slate-200 text-slate-400',
            )}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {error && <Alert>{error}</Alert>}

      {step === 0 && (
        <Card className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="company">Company name, shown in the widget header</Label>
            <Input
              id="company"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </div>
          <div className="flex justify-end">
            <Button
              disabled={pending || name.trim().length < 2}
              onClick={() => save({ name }, () => setStep(1))}
            >
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <BrandingForm value={branding} onChange={setBranding} />
          </Card>
          <div className="space-y-4">
            <WidgetPreview branding={branding} companyName={name} />
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button disabled={pending} onClick={() => save({ branding }, () => setStep(2))}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <Card className="space-y-6">
          <section className="space-y-2">
            <h2 className="font-semibold">Where will you use the widget?</h2>
            <DomainsEditor value={domains} onChange={setDomains} />
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Add this snippet to your website</h2>
            <EmbedSnippet publicKey={settings.publicKey} />
          </section>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                save({ allowedDomains: domains, onboardingCompleted: true }, async () => {
                  await reloadUser();
                  router.replace('/app');
                })
              }
            >
              Finish setup
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
