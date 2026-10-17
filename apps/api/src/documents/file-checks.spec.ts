import { checkUpload, titleFromFileName } from './file-checks';

describe('checkUpload', () => {
  it('accepts a real PDF and markdown/text', () => {
    expect(checkUpload('guide.PDF', Buffer.from('%PDF-1.7 ...'))).toMatchObject({
      sourceType: 'pdf',
    });
    expect(checkUpload('faq.md', Buffer.from('# FAQ\nHello'))).toMatchObject({
      sourceType: 'text',
    });
    expect(checkUpload('notes.txt', Buffer.from('plain'))).toMatchObject({
      mimeType: 'text/plain',
    });
  });

  it('rejects disguised, empty, oversized and unsupported files', () => {
    expect(checkUpload('fake.pdf', Buffer.from('MZ\x90\x00 not a pdf'))).toMatch(/not a valid PDF/);
    expect(checkUpload('binary.txt', Buffer.from([0x41, 0x00, 0x42]))).toMatch(/text file/);
    expect(checkUpload('latin1.txt', Buffer.from([0xe9, 0x74, 0xe9]))).toMatch(/UTF-8/);
    expect(checkUpload('empty.md', Buffer.alloc(0))).toMatch(/empty/);
    expect(checkUpload('big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))).toMatch(/10 MB/);
    expect(checkUpload('virus.exe', Buffer.from('MZ'))).toMatch(/Only PDF/);
  });
});

describe('titleFromFileName', () => {
  it('makes a readable title', () => {
    expect(titleFromFileName('shipping_and-returns.md')).toBe('shipping and returns');
    expect(titleFromFileName('.md')).toBe('Untitled document');
  });
});
