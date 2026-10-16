import { useState } from 'preact/hooks';

export interface AppProps {
  publicKey: string;
}

export function App({ publicKey }: AppProps) {
  const [open, setOpen] = useState(false);

  return (
    <div class="sp-root">
      {open && (
        <div class="sp-panel" role="dialog" aria-label="Support chat">
          <div class="sp-header">Hi! How can we help?</div>
          <div class="sp-body">
            Chat arrives in T08. The widget is running in Shadow DOM, isolated from this page's CSS.
            <div class="sp-key">tenant key: {publicKey}</div>
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
