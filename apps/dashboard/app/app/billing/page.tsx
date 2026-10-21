'use client';

import {
  type BillingOverview,
  type BillingRedirect,
  LIMIT_LABELS,
  limitKinds,
  type PaidPlanId,
  type Plan,
  roleAtLeast,
  type UsageMeter,
} from '@supportpilot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { readError, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment failed, retrying',
  unpaid: 'Unpaid',
  canceled: 'Cancelled',
  incomplete: 'Waiting for payment',
  incomplete_expired: 'Payment not completed',
  paused: 'Paused',
};

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

function Meter({ label, meter, note }: { label: string; meter: UsageMeter; note?: string }) {
  const ratio = meter.limit > 0 ? meter.used / meter.limit : 1;
  const full = meter.used >= meter.limit;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span
          className={cn('tabular-nums', full ? 'font-semibold text-rose-700' : 'text-slate-600')}
        >
          {meter.used.toLocaleString()} / {meter.limit.toLocaleString()}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit}
        aria-valuenow={Math.min(meter.used, meter.limit)}
      >
        <div
          className={cn(
            'h-full rounded-full',
            full ? 'bg-rose-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-brand',
          )}
          style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
        />
      </div>
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
    </div>
  );
}

/** Billing (owners): current plan, usage meters, upgrades through Stripe Checkout (T13). */
export default function BillingPage() {
  const { user, apiFetch } = useAuth();
  const [data, setData] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const waiting = useRef(false);

  const load = useCallback(async (): Promise<BillingOverview | null> => {
    const res = await apiFetch('/billing');
    if (!res.ok) {
      setError(await readError(res));
      return null;
    }
    const overview = (await res.json()) as BillingOverview;
    setData(overview);
    return overview;
  }, [apiFetch]);

  useEffect(() => {
    if (user && !roleAtLeast(user.role, 'owner')) return;
    // Back from Stripe Checkout: the plan changes when Stripe's webhook arrives, so poll briefly.
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result) window.history.replaceState(null, '', window.location.pathname);
    if (result === 'cancelled') {
      setNotice({ tone: 'info', text: 'Checkout cancelled. Nothing was charged.' });
    }
    void load().then(async (first) => {
      if (result !== 'success' || !first) return;
      setNotice({
        tone: 'info',
        text: 'Payment received. Confirming your new plan with Stripe...',
      });
      waiting.current = true;
      for (let i = 0; i < 15 && waiting.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const next = await load();
        if (next && next.plan !== 'free') {
          setNotice({
            tone: 'success',
            text: `You're on the ${next.plans.find((p) => p.id === next.plan)?.name} plan. Thank you!`,
          });
          return;
        }
      }
      if (waiting.current) {
        setNotice({
          tone: 'info',
          text: 'Stripe has not confirmed the payment yet. Refresh this page in a minute.',
        });
      }
    });
    return () => {
      waiting.current = false;
    };
  }, [load, user]);

  async function go(path: string, body?: object) {
    setBusy(path);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: 'POST',
        ...(body
          ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
          : {}),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      window.location.assign(((await res.json()) as BillingRedirect).url);
    } finally {
      setBusy(null);
    }
  }

  if (user && !roleAtLeast(user.role, 'owner')) {
    return <Alert>Only the workspace owner can manage billing.</Alert>;
  }

  const current = data?.plans.find((p) => p.id === data.plan);
  const subscribed =
    data?.status === 'active' || data?.status === 'trialing' || data?.status === 'past_due';

  function planAction(plan: Plan) {
    if (!data) return null;
    if (plan.id === data.plan) {
      return (
        <Button variant="outline" disabled className="w-full">
          Current plan
        </Button>
      );
    }
    if (plan.id === 'free') {
      return subscribed && data.canManage ? (
        <Button
          variant="ghost"
          className="w-full"
          disabled={busy !== null}
          onClick={() => void go('/billing/portal')}
        >
          Cancel in Manage billing
        </Button>
      ) : null;
    }
    if (subscribed) {
      return (
        <Button
          variant="outline"
          className="w-full"
          disabled={busy !== null || !data.canManage}
          onClick={() => void go('/billing/portal')}
        >
          Switch in Manage billing
        </Button>
      );
    }
    return (
      <Button
        className="w-full"
        disabled={busy !== null || !data.configured}
        onClick={() => void go('/billing/checkout', { plan: plan.id as PaidPlanId })}
      >
        {busy === '/billing/checkout' ? 'Opening Stripe...' : `Upgrade to ${plan.name}`}
      </Button>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="mt-1 text-slate-500">
          Your plan, what you have used this month, and upgrades. Payments are handled by Stripe.
        </p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {data?.paymentFailed && (
        <Alert>
          Your last payment failed. Stripe will try again; update your card in Manage billing to
          keep your {current?.name} plan.
        </Alert>
      )}
      {data && !data.configured && (
        <Alert tone="info">
          Upgrades are switched off on this server. Set STRIPE_SECRET_KEY, STRIPE_PRICE_PRO and
          STRIPE_PRICE_BUSINESS in .env to enable Stripe Checkout (see the README).
        </Alert>
      )}

      {!data && !error && <p className="text-sm text-slate-500">Loading...</p>}

      {data && current && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <Card>
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Current plan
            </p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{current.name}</p>
            <p className="mt-1 text-sm text-slate-600">
              {current.priceMonthly === 0 ? 'Free forever' : `$${current.priceMonthly} a month`}
              {data.status && ` · ${STATUS_LABELS[data.status] ?? data.status}`}
            </p>
            {data.currentPeriodEnd && subscribed && (
              <p className="mt-3 text-sm text-slate-600">
                {data.cancelAtPeriodEnd
                  ? `Cancelled: stays ${current.name} until ${longDate(data.currentPeriodEnd)}, then moves to Free.`
                  : `Renews on ${longDate(data.currentPeriodEnd)}.`}
              </p>
            )}
            {data.canManage && (
              <Button
                variant="outline"
                className="mt-4"
                disabled={busy !== null}
                onClick={() => void go('/billing/portal')}
              >
                {busy === '/billing/portal' ? 'Opening Stripe...' : 'Manage billing'}
              </Button>
            )}
            {data.canManage && (
              <p className="mt-2 text-xs text-slate-500">
                Change plan, update your card, download invoices or cancel.
              </p>
            )}
          </Card>

          <Card className="space-y-4">
            <div>
              <CardTitle>Usage</CardTitle>
              <CardDescription>
                At the AI-answer limit, new chats go straight to your team instead of the AI.
              </CardDescription>
            </div>
            {limitKinds.map((kind) => (
              <Meter
                key={kind}
                label={LIMIT_LABELS[kind].label}
                meter={data.usage[kind]}
                note={
                  kind === 'aiAnswers'
                    ? `Resets on ${longDate(data.period.end)}.`
                    : kind === 'agents'
                      ? 'Team members other than the owner, including pending invites.'
                      : undefined
                }
              />
            ))}
          </Card>
        </div>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-3">
          {data.plans.map((plan) => (
            <Card
              key={plan.id}
              className={cn(
                'flex flex-col',
                plan.id === data.plan && 'border-brand ring-1 ring-brand',
              )}
            >
              <CardTitle>{plan.name}</CardTitle>
              <p className="mt-2">
                <span className="text-3xl font-bold">${plan.priceMonthly}</span>
                <span className="text-sm text-slate-500"> / month</span>
              </p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span aria-hidden="true" className="text-brand">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-5">{planAction(plan)}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
