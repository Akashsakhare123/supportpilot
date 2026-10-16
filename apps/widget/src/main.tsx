import { render } from 'preact';
import { App } from './App';
import css from './styles.css?inline';

const HOST_ID = 'supportpilot-widget';

/** The embedding script tag: <script src=".../widget.js" data-supportpilot data-key="pk_..."></script> */
function findScriptTag(): HTMLScriptElement | null {
  return (
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-supportpilot]')
  );
}

function mount(): void {
  if (document.getElementById(HOST_ID)) return; // already mounted (script included twice)
  const publicKey = findScriptTag()?.dataset.key;
  if (!publicKey) {
    console.warn('[SupportPilot] Missing data-key on the widget script tag.');
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);

  // Shadow DOM keeps host-page CSS out of the widget and widget CSS out of the page.
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const root = document.createElement('div');
  shadow.appendChild(root);

  render(<App publicKey={publicKey} />, root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
