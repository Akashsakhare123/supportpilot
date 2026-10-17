'use client';

import {
  type DocumentStatus,
  type DocumentSummary,
  fileExtension,
  roleAtLeast,
  UPLOAD_LIMITS,
} from '@supportpilot/shared';
import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { readError, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<DocumentStatus, string> = {
  queued: 'bg-slate-100 text-slate-700',
  processing: 'bg-amber-100 text-amber-800',
  ready: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
};

const STATUS_LABEL: Record<DocumentStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ACCEPT = Object.keys(UPLOAD_LIMITS.extensions).join(',');

export default function KnowledgePage() {
  const { user, apiFetch } = useAuth();
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/documents');
    if (res.ok) setDocs((await res.json()) as DocumentSummary[]);
    else setError(await readError(res));
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  // While anything is waiting for the ingestion worker, refresh every 5 seconds.
  const pending = docs?.some((d) => d.status === 'queued' || d.status === 'processing') ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pending, load]);

  if (user && !roleAtLeast(user.role, 'admin')) {
    return <Alert>Only admins and owners can manage the knowledge base.</Alert>;
  }

  async function uploadFiles(files: FileList | File[]) {
    setError(null);
    setNotice(null);
    setUploading(true);
    let added = 0;
    try {
      for (const file of Array.from(files)) {
        if (!UPLOAD_LIMITS.extensions[fileExtension(file.name)]) {
          setError(`${file.name}: only PDF, .txt and .md files are supported`);
          continue;
        }
        if (file.size > UPLOAD_LIMITS.maxBytes) {
          setError(`${file.name}: files can be at most 10 MB`);
          continue;
        }
        const form = new FormData();
        form.append('file', file);
        const res = await apiFetch('/documents', { method: 'POST', body: form });
        if (!res.ok) {
          setError(`${file.name}: ${await readError(res)}`);
          continue;
        }
        added += 1;
      }
      if (added > 0)
        setNotice(`${added} file${added > 1 ? 's' : ''} uploaded and queued for processing.`);
      await load();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function addUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const res = await apiFetch('/documents/url', { method: 'POST', body: JSON.stringify({ url }) });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setUrl('');
    setNotice('Web page queued for import.');
    await load();
  }

  async function action(doc: DocumentSummary, kind: 'reindex' | 'delete') {
    setError(null);
    const res =
      kind === 'delete'
        ? await apiFetch(`/documents/${doc.id}`, { method: 'DELETE' })
        : await apiFetch(`/documents/${doc.id}/reindex`, { method: 'POST' });
    if (!res.ok) setError(await readError(res));
    await load();
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Knowledge base</h1>
        <p className="mt-1 text-slate-500">
          The AI answers customers only from what you add here: help articles, FAQs, policies.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Upload files</CardTitle>
          <CardDescription>PDF, .txt or .md, up to 10 MB each.</CardDescription>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'mt-4 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm',
              dragging ? 'border-brand bg-brand-soft' : 'border-slate-300 bg-slate-50',
            )}
          >
            <p className="text-slate-600">Drag files here or</p>
            <Button
              variant="outline"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? 'Uploading...' : 'Choose files'}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
            />
          </div>
        </Card>

        <Card>
          <CardTitle>Import a web page</CardTitle>
          <CardDescription>A public page such as your FAQ or returns policy.</CardDescription>
          <form method="post" onSubmit={addUrl} className="mt-4 flex gap-2">
            <Input
              type="url"
              required
              placeholder="https://yourshop.com/faq"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Page URL"
            />
            <Button type="submit" disabled={!url.trim()}>
              Add
            </Button>
          </form>
          <p className="mt-3 text-xs text-slate-500">
            Private and local network addresses are blocked for security.
          </p>
        </Card>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-6 py-3 font-medium">Document</th>
              <th className="px-6 py-3 font-medium">Type</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium">Chunks</th>
              <th className="px-6 py-3 font-medium">Added</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {docs?.map((doc) => (
              <tr key={doc.id}>
                <td className="max-w-xs px-6 py-3">
                  <p className="truncate font-medium">{doc.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {doc.source} {doc.sizeBytes !== null && `· ${formatBytes(doc.sizeBytes)}`}
                  </p>
                  {doc.error && <p className="mt-1 text-xs text-rose-700">{doc.error}</p>}
                </td>
                <td className="px-6 py-3 uppercase text-slate-600">{doc.sourceType}</td>
                <td className="px-6 py-3">
                  <span
                    className={cn(
                      'rounded-full px-2.5 py-0.5 text-xs font-medium',
                      STATUS_STYLE[doc.status],
                    )}
                  >
                    {STATUS_LABEL[doc.status]}
                  </span>
                </td>
                <td className="px-6 py-3 text-slate-600">{doc.chunkCount}</td>
                <td className="px-6 py-3 text-slate-500">
                  {new Date(doc.createdAt).toLocaleDateString()}
                </td>
                <td className="px-6 py-3 text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => void action(doc, 'reindex')}>
                    Re-index
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-rose-700"
                    onClick={() => void action(doc, 'delete')}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {docs?.length === 0 && (
          <p className="px-6 py-8 text-center text-sm text-slate-500">
            No documents yet. Upload your FAQ or help articles to get started.
          </p>
        )}
        {!docs && !error && <p className="px-6 py-4 text-sm text-slate-500">Loading...</p>}
      </Card>

      {pending && (
        <p className="text-xs text-slate-500">
          Queued documents are processed by the ingestion worker (chunking and embeddings arrive in
          T05-T06).
        </p>
      )}
    </div>
  );
}
