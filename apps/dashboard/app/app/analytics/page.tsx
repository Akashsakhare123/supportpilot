'use client';

import {
  addDays,
  type AnalyticsExport,
  type AnalyticsOverview,
  dateInZone,
  roleAtLeast,
  UNANSWERED_REASON_LABELS,
  unansweredReasons,
} from '@supportpilot/shared';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { readError, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/** Categorical slots 1 and 2 of the validated chart palette (blue, orange). */
const SERIES = { first: '#2a78d6', second: '#eb6834' } as const;
const GRID = '#e2e8f0';
const AXIS = '#64748b';

const PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

const percent = (rate: number | null) => (rate === null ? '-' : `${Math.round(rate * 100)}%`);

function duration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function Kpi({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </Card>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
      <div className="mt-4 h-64">{children}</div>
    </Card>
  );
}

/** Analytics: KPIs, daily charts, top questions and the unanswered-questions report (T12). */
export default function AnalyticsPage() {
  const { user, apiFetch } = useAuth();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const today = useMemo(() => dateInZone(new Date(), tz), [tz]);
  const [range, setRange] = useState({ from: addDays(today, -29), to: today });
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const query = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({ from: range.from, to: range.to, tz, ...extra }).toString(),
    [range, tz],
  );

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/analytics?${query(fresh ? { fresh: '1' } : {})}`);
        if (!res.ok) {
          setError(await readError(res));
          return;
        }
        setData((await res.json()) as AnalyticsOverview);
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function download(report: AnalyticsExport) {
    setError(null);
    const res = await apiFetch(`/analytics/export?${query({ report })}`);
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `supportpilot-${report}-${range.from}-to-${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (user && !roleAtLeast(user.role, 'admin')) {
    return <Alert>Only admins and owners can see analytics.</Alert>;
  }

  const kpis = data?.kpis;
  const activePreset = PRESETS.find(
    (p) => range.to === today && range.from === addDays(today, -(p.days - 1)),
  );
  const daily = data?.daily.map((d) => ({ ...d, label: shortDate(d.date) })) ?? [];

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="mt-1 text-slate-500">
            How much the AI handles on its own, and which questions it still cannot answer.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.days}
              variant={activePreset?.days === p.days ? 'default' : 'outline'}
              onClick={() => setRange({ from: addDays(today, -(p.days - 1)), to: today })}
            >
              {p.label}
            </Button>
          ))}
          <label className="sr-only" htmlFor="from">
            From
          </label>
          <Input
            id="from"
            type="date"
            className="w-38"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
          />
          <span className="text-sm text-slate-500">to</span>
          <label className="sr-only" htmlFor="to">
            To
          </label>
          <Input
            id="to"
            type="date"
            className="w-38"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
          />
          <Button variant="ghost" disabled={loading} onClick={() => void load(true)}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}
      {!data && !error && <p className="text-sm text-slate-500">Loading...</p>}

      {kpis && data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Conversations"
              value={kpis.conversations.toLocaleString()}
              detail={`${kpis.aiAnswers.toLocaleString()} AI answers`}
            />
            <Kpi
              label="AI-resolved"
              value={percent(kpis.aiResolvedRate)}
              detail={`${kpis.aiResolved} chats without a person · ${percent(kpis.handoffRate)} handed off`}
            />
            <Kpi
              label="Avg first response"
              value={duration(kpis.avgFirstResponseMs)}
              detail={`Agents after a hand-off: ${duration(kpis.avgAgentResponseMs)}`}
            />
            <Kpi
              label="Rating"
              value={percent(kpis.satisfactionRate)}
              detail={`${kpis.thumbsUp} helpful · ${kpis.thumbsDown} not helpful`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Conversations per day"
              description="Resolved by the AI alone vs handed off to a person."
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: AXIS, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={16}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: AXIS, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: AXIS }} />
                  <Bar
                    dataKey="aiResolved"
                    name="AI-resolved"
                    stackId="c"
                    fill={SERIES.first}
                    stroke="#fff"
                    strokeWidth={1}
                  />
                  <Bar
                    dataKey="handedOff"
                    name="Handed off"
                    stackId="c"
                    fill={SERIES.second}
                    stroke="#fff"
                    strokeWidth={1}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard
              title="Customer ratings per day"
              description="Thumbs up and down on AI answers in the widget."
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: AXIS, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={16}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: AXIS, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: AXIS }} />
                  <Bar
                    dataKey="thumbsUp"
                    name="Helpful"
                    fill={SERIES.first}
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="thumbsDown"
                    name="Not helpful"
                    fill={SERIES.second}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button variant="outline" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide daily table' : 'Show daily table'}
            </Button>
            <span className="ml-auto text-slate-500">Export CSV:</span>
            <Button variant="outline" onClick={() => void download('daily')}>
              Daily numbers
            </Button>
            <Button variant="outline" onClick={() => void download('questions')}>
              Top questions
            </Button>
            <Button variant="outline" onClick={() => void download('unanswered')}>
              Unanswered
            </Button>
          </div>

          {showTable && (
            <Card className="max-h-80 overflow-auto p-0">
              <table className="w-full text-left text-sm tabular-nums">
                <thead className="sticky top-0 border-b border-slate-200 bg-white text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Conversations</th>
                    <th className="px-4 py-2 font-medium">AI-resolved</th>
                    <th className="px-4 py-2 font-medium">Handed off</th>
                    <th className="px-4 py-2 font-medium">Helpful</th>
                    <th className="px-4 py-2 font-medium">Not helpful</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.daily.map((d) => (
                    <tr key={d.date}>
                      <td className="px-4 py-1.5">{d.date}</td>
                      <td className="px-4 py-1.5">{d.conversations}</td>
                      <td className="px-4 py-1.5">{d.aiResolved}</td>
                      <td className="px-4 py-1.5">{d.handedOff}</td>
                      <td className="px-4 py-1.5">{d.thumbsUp}</td>
                      <td className="px-4 py-1.5">{d.thumbsDown}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card className="p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pt-5">
              <div>
                <CardTitle>Unanswered questions</CardTitle>
                <CardDescription>
                  Questions the AI was unsure about, could not find, or that customers rated not
                  helpful, grouped by meaning. Each one is a help article worth writing.
                </CardDescription>
              </div>
            </div>
            {data.unanswered.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-slate-500">
                Nothing here: the AI answered every question in this period.
              </p>
            ) : (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="border-y border-slate-200 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-6 py-2 font-medium">Question</th>
                    <th className="px-4 py-2 font-medium">Asked</th>
                    <th className="px-4 py-2 font-medium">Why</th>
                    <th className="px-4 py-2 font-medium">Last asked</th>
                    <th className="px-6 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.unanswered.map((q) => (
                    <tr key={q.question} className="align-top">
                      <td className="max-w-md px-6 py-3">
                        <p className="font-medium text-slate-900">{q.question}</p>
                        {q.examples.length > 0 && (
                          <p className="mt-0.5 text-xs text-slate-500">
                            Also asked as: {q.examples.map((e) => `"${e}"`).join(', ')}
                          </p>
                        )}
                        <p className="mt-1 flex flex-wrap gap-2 text-xs">
                          {q.conversationIds.map((id, i) => (
                            <Link
                              key={id}
                              href={`/app/inbox?c=${id}`}
                              className="text-brand hover:underline"
                            >
                              View chat {i + 1}
                            </Link>
                          ))}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-semibold tabular-nums">{q.count}x</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          {unansweredReasons
                            .filter((r) => q.reasons[r] > 0)
                            .map((r) => (
                              <span
                                key={r}
                                className={cn(
                                  'w-fit rounded-full px-2 py-0.5 text-xs font-medium',
                                  r === 'thumbs_down'
                                    ? 'bg-slate-100 text-slate-700'
                                    : 'bg-rose-100 text-rose-800',
                                )}
                              >
                                {UNANSWERED_REASON_LABELS[r]} · {q.reasons[r]}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                        {new Date(q.lastAskedAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <Link
                          href={`/app/knowledge?topic=${encodeURIComponent(q.question)}`}
                          className="inline-flex h-9 items-center rounded-md bg-brand px-4 text-sm font-medium whitespace-nowrap text-white hover:bg-brand/90"
                        >
                          Add doc
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="p-0">
            <div className="px-6 pt-5">
              <CardTitle>Top questions</CardTitle>
              <CardDescription>
                What customers ask most, with similar wordings grouped together.
              </CardDescription>
            </div>
            {data.topQuestions.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-slate-500">
                No customer questions in this period yet.
              </p>
            ) : (
              <ol className="mt-4 divide-y divide-slate-100 border-t border-slate-200">
                {data.topQuestions.map((q, i) => {
                  const max = data.topQuestions[0]!.count;
                  return (
                    <li key={q.question} className="flex items-center gap-4 px-6 py-3 text-sm">
                      <span className="w-5 text-right text-slate-400 tabular-nums">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-900">{q.question}</p>
                        <div className="mt-1.5 h-1.5 rounded-full bg-slate-100">
                          <div
                            className="h-1.5 rounded-full"
                            style={{
                              width: `${Math.max(4, (q.count / max) * 100)}%`,
                              background: SERIES.first,
                            }}
                          />
                        </div>
                      </div>
                      <span className="w-14 text-right font-semibold tabular-nums">{q.count}x</span>
                      <span
                        className={cn(
                          'w-28 text-right text-xs',
                          q.unanswered ? 'text-rose-700' : 'text-emerald-700',
                        )}
                      >
                        {q.unanswered ? `${q.unanswered} unanswered` : 'All answered'}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <p className="text-xs text-slate-500">
            {data.questionsAnalysed.toLocaleString()} customer questions analysed · grouped with{' '}
            {data.embeddingModel} · {data.cached ? 'cached' : 'calculated'}{' '}
            {new Date(data.generatedAt).toLocaleTimeString()} (refreshes every 5 minutes) · dates in{' '}
            {data.range.tz}. Test-assistant chats are not counted.
          </p>
        </>
      )}
    </div>
  );
}
