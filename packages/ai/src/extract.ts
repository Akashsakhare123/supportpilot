import { assertPublicUrl } from '@supportpilot/shared/node';
import { htmlToText } from './html';

export interface ExtractedText {
  text: string;
  /** Title found in the source (HTML <title>), if any. */
  title?: string;
}

/** Text of a PDF (all pages, in order). */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages
    .map((page) => page.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

export interface FetchPageOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Override the DNS check (tests). */
  checkUrl?: (url: string) => Promise<URL>;
}

/**
 * Download a public web page safely: every hop (including redirects) passes the SSRF guard,
 * only HTML / plain text is accepted, and size and time are limited.
 */
export async function fetchPublicPage(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<ExtractedText> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const checkUrl = options.checkUrl ?? ((u: string) => assertPublicUrl(u));
  let url = await checkUrl(rawUrl);

  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    const res = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        'User-Agent': 'SupportPilotBot/1.0 (+knowledge-base import)',
        Accept: 'text/html,text/plain',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`Redirect without a location (${res.status})`);
      url = await checkUrl(new URL(location, url).href);
      continue;
    }
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new Error(`Unsupported content type: ${type || 'unknown'}`);
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > maxBytes) throw new Error('The page is larger than 2 MB');
    const body = await res.text();
    if (body.length > maxBytes) throw new Error('The page is larger than 2 MB');
    if (/text\/plain/i.test(type)) return { text: body.trim() };
    return htmlToText(body);
  }
  throw new Error('Too many redirects');
}
