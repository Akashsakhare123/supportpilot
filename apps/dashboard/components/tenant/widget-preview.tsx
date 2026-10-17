import type { TenantBranding } from '@supportpilot/shared';

/** Static mock of the chat widget, so admins see their branding before installing it. */
export function WidgetPreview({
  branding,
  companyName,
}: {
  branding: Required<TenantBranding>;
  companyName: string;
}) {
  const side = branding.position === 'left' ? { left: 16 } : { right: 16 };
  return (
    <div
      className="relative h-80 overflow-hidden rounded-xl border border-slate-200 bg-[linear-gradient(135deg,#f8fafc,#e2e8f0)]"
      aria-label="Widget preview"
    >
      <div className="p-4 text-xs text-slate-400">Your website</div>
      <div
        className="absolute bottom-20 w-64 overflow-hidden rounded-xl bg-white shadow-lg"
        style={side}
      >
        <div
          className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-white"
          style={{ background: branding.primaryColor }}
        >
          {branding.logoUrl ? (
            <img
              src={branding.logoUrl}
              alt=""
              className="h-6 w-6 rounded bg-white object-contain"
            />
          ) : null}
          <span className="truncate">{companyName}</span>
        </div>
        <div className="space-y-2 p-4 text-sm text-slate-700">
          <p className="rounded-lg bg-slate-100 px-3 py-2">{branding.greeting}</p>
          <p
            className="ml-auto w-fit rounded-lg px-3 py-2 text-white"
            style={{ background: branding.primaryColor }}
          >
            Do you ship to Canada?
          </p>
        </div>
      </div>
      <div
        className="absolute bottom-4 grid h-12 w-12 place-items-center rounded-full text-xl text-white shadow-lg"
        style={{ ...side, background: branding.primaryColor }}
      >
        💬
      </div>
    </div>
  );
}
