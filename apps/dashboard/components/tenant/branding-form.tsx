'use client';

import type { TenantBranding } from '@supportpilot/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Branding = Required<TenantBranding>;

/** Controlled branding fields; the parent owns the value and saves it. */
export function BrandingForm({
  value,
  onChange,
}: {
  value: Branding;
  onChange(next: Branding): void;
}) {
  const set = <K extends keyof Branding>(key: K, v: Branding[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="brand-color">Brand colour</Label>
        <div className="flex items-center gap-3">
          <input
            id="brand-color"
            type="color"
            value={value.primaryColor}
            onChange={(e) => set('primaryColor', e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white"
          />
          <Input
            aria-label="Brand colour hex"
            value={value.primaryColor}
            onChange={(e) => set('primaryColor', e.target.value)}
            className="w-32 font-mono"
            maxLength={7}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="brand-greeting">Greeting</Label>
        <textarea
          id="brand-greeting"
          value={value.greeting}
          onChange={(e) => set('greeting', e.target.value)}
          maxLength={140}
          rows={2}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-brand/30"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="brand-logo">Logo URL (optional)</Label>
        <Input
          id="brand-logo"
          type="url"
          placeholder="https://example.com/logo.png"
          value={value.logoUrl}
          onChange={(e) => set('logoUrl', e.target.value)}
        />
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-slate-700">Launcher position</legend>
        <div className="flex gap-4 text-sm">
          {(['right', 'left'] as const).map((side) => (
            <label key={side} className="flex items-center gap-2">
              <input
                type="radio"
                name="brand-position"
                checked={value.position === side}
                onChange={() => set('position', side)}
              />
              Bottom {side}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
