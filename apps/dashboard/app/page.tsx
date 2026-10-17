import Link from 'next/link';
import { API_URL, getHealth } from '@/lib/api';

export const dynamic = 'force-dynamic';

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`}
    />
  );
}

export default async function Home() {
  const health = await getHealth();
  const rows = [
    { label: 'API', ok: health !== null, detail: health ? API_URL : `offline (${API_URL})` },
    { label: 'PostgreSQL', ok: health?.db === 'ok', detail: health?.db ?? 'unknown' },
    {
      label: 'pgvector',
      ok: Boolean(health?.pgvector),
      detail: health?.pgvector ? `v${health.pgvector}` : 'run pnpm db:migrate',
    },
    { label: 'Redis', ok: health?.redis === 'ok', detail: health?.redis ?? 'unknown' },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-sm font-semibold tracking-wide text-brand uppercase">SupportPilot</p>
        <h1 className="mt-2 text-3xl font-bold">
          AI customer support with real-time human handoff
        </h1>
        <p className="mt-3 text-slate-600">
          Upload your docs, embed one script tag, and let AI answer your customers. Low-confidence
          chats are handed to your team in real time.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex h-9 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand/90"
        >
          Log in
        </Link>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">System status</h2>
        <ul className="mt-4 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between py-2.5 text-sm">
              <span className="flex items-center gap-2.5 font-medium">
                <Dot ok={row.ok} />
                {row.label}
              </span>
              <span className="text-slate-500">{row.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
