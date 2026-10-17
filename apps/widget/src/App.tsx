import type { WidgetConfig } from '@supportpilot/shared';
import { useEffect, useState } from 'preact/hooks';

export interface AppProps {
  publicKey: string;
  apiUrl: string;
}

type Load = { state: 'loading' } | { state: 'ready'; config: WidgetConfig } | { state: 'off' };

export function App({ publicKey, apiUrl }: AppProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    fetch(`${apiUrl}/widget/config?key=${encodeURIComponent(publicKey)}`)
      .then(async (res) => {
        if (!res.ok) {
          // 403: this website is not in the tenant's allowed domains. 404: unknown or rotated key.
          console.warn(
            `[SupportPilot] Widget disabled (${res.status}). Check the key and allowed domains.`,
          );
          setLoad({ state: 'off' });
          return;
        }
        setLoad({ state: 'ready', config: (await res.json()) as WidgetConfig });
      })
      .catch(() => {
        console.warn('[SupportPilot] Could not reach the SupportPilot API.');
        setLoad({ state: 'off' });
      });
  }, [apiUrl, publicKey]);

  if (load.state !== 'ready') return null;
  const { branding, tenantName } = load.config;

  return (
    <div
      class={`sp-root ${branding.position === 'left' ? 'sp-left' : ''}`}
      style={{ '--sp-brand': branding.primaryColor }}
    >
      {open && (
        <div class="sp-panel" role="dialog" aria-label={`${tenantName} support chat`}>
          <div class="sp-header">
            {branding.logoUrl && <img class="sp-logo" src={branding.logoUrl} alt="" />}
            <span>{tenantName}</span>
          </div>
          <div class="sp-body">
            <p class="sp-bubble">{branding.greeting}</p>
            <p class="sp-note">Live chat arrives in T07-T08.</p>
          </div>
        </div>
      )}
      <button
        class="sp-launcher"
        type="button"
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        onClick={() => setOpen(!open)}
      >
        {open ? '×' : '💬'}
      </button>
    </div>
  );
}
