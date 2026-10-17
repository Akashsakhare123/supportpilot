'use client';

import { normalizeDomain } from '@supportpilot/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Edit the list of websites allowed to load the widget. */
export function DomainsEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange(next: string[]): void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const domain = normalizeDomain(draft);
    if (!domain) {
      setError(`"${draft}" is not a valid domain`);
      return;
    }
    if (!value.includes(domain)) onChange([...value, domain]);
    setDraft('');
    setError(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          aria-label="Add a domain"
          placeholder="www.yourshop.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-rose-700">{error}</p>}
      {value.length === 0 ? (
        <p className="text-sm text-slate-500">
          No domains yet: the widget works on any website. Add your domain before going live.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {value.map((domain) => (
            <li
              key={domain}
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-1 pr-1 pl-3 text-sm"
            >
              {domain}
              <button
                type="button"
                aria-label={`Remove ${domain}`}
                onClick={() => onChange(value.filter((d) => d !== domain))}
                className="grid h-5 w-5 place-items-center rounded-full text-slate-500 hover:bg-slate-200"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">
        Subdomains are included: shop.com also allows www.shop.com.
      </p>
    </div>
  );
}
