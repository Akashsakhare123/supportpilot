'use client';

import { embedSnippet } from '@supportpilot/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { WIDGET_URL } from '@/lib/config';

export function EmbedSnippet({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState(false);
  const snippet = embedSnippet(WIDGET_URL, publicKey);
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
        <code>{snippet}</code>
      </pre>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? 'Copied' : 'Copy snippet'}
        </Button>
        <p className="text-xs text-slate-500">Paste it just before &lt;/body&gt; on every page.</p>
      </div>
    </div>
  );
}
