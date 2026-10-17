const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Readable text from an HTML page, keeping headings as markdown so the chunker can use them.
 * Drops scripts, styles, navigation, headers and footers (boilerplate that hurts retrieval).
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/\s+/g, ' ').trim()) : '';
  const main =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  let body = main ? main[1]! : (/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html);

  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|svg|nav|header|footer|aside|form|template)\b[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      const textOnly = inner
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return textOnly ? `\n\n${'#'.repeat(Number(level))} ${textOnly}\n\n` : '\n';
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|ul|ol|table|tr|blockquote|pre|dd|dt)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    // Inline tags join words (`<b>30</b> days`); block-ish leftovers become spaces.
    .replace(/<\/?(a|b|i|u|em|strong|span|code|small|mark|abbr|sub|sup)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
