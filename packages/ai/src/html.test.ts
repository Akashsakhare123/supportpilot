import { describe, expect, it } from 'vitest';
import { htmlToText } from './html';

describe('htmlToText', () => {
  it('keeps the main content, headings and list items; drops boilerplate', () => {
    const { title, text } =
      htmlToText(`<!doctype html><html><head><title>Returns &amp; Refunds</title>
      <style>.x{color:red}</style><script>alert(1)</script></head><body>
      <header>Site header</header><nav><a href="/">Home</a></nav>
      <main><h1>Returns</h1><p>You can return a bike within <b>30&nbsp;days</b>.</p>
      <h2>Exceptions</h2><ul><li>Custom builds</li><li>Used parts</li></ul></main>
      <footer>Copyright</footer></body></html>`);
    expect(title).toBe('Returns & Refunds');
    expect(text).toContain('# Returns');
    expect(text).toContain('## Exceptions');
    expect(text).toContain('You can return a bike within 30 days.');
    expect(text).toMatch(/Custom builds/);
    for (const junk of ['Site header', 'Home', 'Copyright', 'alert', 'color:red']) {
      expect(text).not.toContain(junk);
    }
  });

  it('decodes numeric entities and works without <main>', () => {
    const { title, text } = htmlToText('<body><p>Caf&#233; &#x2014; open</p></body>');
    expect(title).toBe('');
    expect(text).toBe('Café — open');
  });
});
