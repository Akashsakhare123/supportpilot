import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { extractPdfText, fetchPublicPage } from './extract';

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url));

describe('extractPdfText', () => {
  it('extracts the text of every page in order', async () => {
    const text = await extractPdfText(fixture('sample.pdf'));
    expect(text).toContain('lifetime warranty');
    expect(text).toContain('3 to 5 business days');
    expect(text.indexOf('warranty')).toBeLessThan(text.indexOf('Shipping'));
  });

  it('rejects data that is not a PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('not a pdf'))).rejects.toThrow();
  });
});

describe('fetchPublicPage', () => {
  // DNS check stub: anything on internal.test counts as private.
  const checkUrl = async (raw: string) => {
    const url = new URL(raw);
    if (url.hostname.endsWith('internal.test')) throw new Error('Blocked private address');
    return url;
  };
  const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

  it('downloads a page and converts it to text', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      html('<title>FAQ</title><main><h1>FAQ</h1><p>Hello</p></main>'),
    );
    const page = await fetchPublicPage('https://shop.example/faq', { fetchImpl, checkUrl });
    expect(page).toEqual({ title: 'FAQ', text: '# FAQ\n\nHello' });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows safe redirects but blocks a redirect to a private host', async () => {
    const hops = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/old')
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : html('<p>Moved here</p>'),
    );
    await expect(
      fetchPublicPage('https://shop.example/old', { fetchImpl: hops, checkUrl }),
    ).resolves.toMatchObject({
      text: 'Moved here',
    });

    const evil = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://db.internal.test/' } }),
    );
    await expect(
      fetchPublicPage('https://shop.example/x', { fetchImpl: evil, checkUrl }),
    ).rejects.toThrow(/private/);
  });

  it('stops redirect loops', async () => {
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    );
    await expect(
      fetchPublicPage('https://shop.example/', { fetchImpl: loop, checkUrl }),
    ).rejects.toThrow(/Too many redirects/);
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it('rejects non-HTML content, errors and oversized pages', async () => {
    const pdf = vi.fn(
      async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    );
    await expect(
      fetchPublicPage('https://shop.example/a.pdf', { fetchImpl: pdf, checkUrl }),
    ).rejects.toThrow(/Unsupported content type/);
    const missing = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(
      fetchPublicPage('https://shop.example/404', { fetchImpl: missing, checkUrl }),
    ).rejects.toThrow(/HTTP 404/);
    const big = vi.fn(async () => html('x'.repeat(2000)));
    await expect(
      fetchPublicPage('https://shop.example/big', { fetchImpl: big, checkUrl, maxBytes: 1000 }),
    ).rejects.toThrow(/larger/);
  });

  it('returns plain text as-is', async () => {
    const txt = vi.fn(
      async () => new Response(' Just text \n', { headers: { 'content-type': 'text/plain' } }),
    );
    await expect(
      fetchPublicPage('https://shop.example/t.txt', { fetchImpl: txt, checkUrl }),
    ).resolves.toEqual({
      text: 'Just text',
    });
  });
});
