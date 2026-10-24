// @vitest-environment jsdom
/**
 * Create PF Cite: page metadata → a full NSDA-style cite, qualifications
 * from the byline/bio, the read-aloud "Lastname Date" tokens, and the
 * cutter signature.
 */

import { describe, expect, it } from 'vitest';
import {
  citeIsComplete,
  extractPageMetadata,
  findQualifications,
  findUrl,
  formatPfCite,
  qualificationsFor,
  shortDate,
  splitAuthors,
} from '../../src/editor/ai/pf-cite.js';
import { withCiteSignature } from '../../src/editor/ai/cite-creator.js';

const NOW = new Date(2026, 9, 23);

const ARTICLE = `<!doctype html><html><head>
<title>Why Sanctions Fail | Foreign Affairs</title>
<meta property="og:title" content="Why Sanctions Fail">
<meta property="og:site_name" content="Foreign Affairs">
<meta name="author" content="Jane Smith">
<meta property="article:published_time" content="2024-03-14T09:00:00Z">
</head><body><article>
<p class="byline">By <a rel="author" href="/authors/jane-smith">Jane Smith</a></p>
<p>Sanctions rarely change regimes.</p>
<p class="author-bio">Jane Smith is a Senior Fellow at the Brookings Institution and a former State Department official.</p>
</article></body></html>`;

describe('pf cite', () => {
  it('reads metadata and writes a complete cite without AI', () => {
    const meta = extractPageMetadata(ARTICLE, 'https://www.foreignaffairs.com/why-sanctions-fail');
    expect(meta.authors).toEqual(['Jane Smith']);
    expect(meta.title).toBe('Why Sanctions Fail');
    expect(meta.publication).toBe('Foreign Affairs');
    expect(meta.authorLinks).toEqual(['https://www.foreignaffairs.com/authors/jane-smith']);
    const quals = qualificationsFor(meta);
    expect(quals[0]).toMatch(/^Senior Fellow at the Brookings Institution/);
    expect(citeIsComplete(meta, quals)).toBe(true);
    const r = formatPfCite(meta, NOW, quals);
    expect(r.cite).toBe(
      'Jane Smith 24, Senior Fellow at the Brookings Institution and a former State Department official, "Why Sanctions Fail," Foreign Affairs, 3/14/2024, https://www.foreignaffairs.com/why-sanctions-fail, accessed 10/23/2026',
    );
    expect(r.tokens).toEqual(['Smith 24']);
  });

  it('marks missing qualifications and is incomplete', () => {
    const meta = extractPageMetadata(ARTICLE.replace(/<p class="author-bio">.*?<\/p>/, ''), 'https://x.com/a');
    const quals = qualificationsFor(meta);
    expect(citeIsComplete(meta, quals)).toBe(false);
    expect(formatPfCite(meta, NOW, quals).cite).toContain('[qualifications]');
  });

  it('two authors and the "Lastname & " token convention', () => {
    const meta = extractPageMetadata(
      ARTICLE.replace('content="Jane Smith"', 'content="Laura Weiss and John Bresnahan"'),
      'https://punchbowl.news/x',
    );
    expect(meta.authors.slice(0, 2)).toEqual(['Laura Weiss', 'John Bresnahan']);
  });

  it('short dates follow the cite convention', () => {
    expect(shortDate(new Date(2026, 9, 1), NOW)).toBe('10/1');
    expect(shortDate(new Date(2009, 1, 1), NOW)).toBe('9');
    expect(shortDate(new Date(1931, 1, 1), NOW)).toBe('1931');
  });

  it('helpers', () => {
    expect(findUrl('see https://example.com/a-b?c=1. thanks')).toBe('https://example.com/a-b?c=1');
    expect(splitAuthors('By Ann Lee, Bo Kim & Cy Diaz')).toEqual(['Ann Lee', 'Bo Kim', 'Cy Diaz']);
    expect(findQualifications('Ann Lee', 'Ann Lee, professor of economics at MIT, said')).toBe(
      'Professor of economics at MIT',
    );
    expect(findQualifications('Ann Lee', 'Ann Lee went to the store.')).toBe('');
  });

  it('signature is appended once', () => {
    const r = withCiteSignature({ cite: 'Smith 24, x', tokens: ['Smith 24'] }, '// arjun 🦡');
    expect(r.cite).toBe('Smith 24, x // arjun 🦡');
    expect(withCiteSignature(r, '// arjun 🦡').cite).toBe(r.cite);
  });
});
