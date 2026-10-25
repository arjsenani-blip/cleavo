// @vitest-environment jsdom
/**
 * Create PF Cite: page metadata → a full NSDA-style cite, qualifications
 * from the byline/bio, the read-aloud "Lastname Date" tokens, and the
 * cutter signature.
 */

import { describe, expect, it } from 'vitest';
import {
  citeIsComplete,
  citeLead,
  extractPageMetadata,
  findQualifications,
  findUrl,
  formatPfCite,
  contextTie,
  parseSearchResults,
  rankAuthorResults,
  topicWords,
  qualificationsFor,
  resultQualifications,
  shortDate,
  splitAuthors,
} from '../../src/editor/ai/pf-cite.js';
import { withCiteSignature } from '../../src/editor/ai/cite-creator.js';

const NOW = new Date(2026, 9, 23);
const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, '');

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
      'Smith 24 [Jane Smith, Senior Fellow at the Brookings Institution and a former State Department official, "Why Sanctions Fail", 03/14/2024, Foreign Affairs, https://www.foreignaffairs.com/why-sanctions-fail, Accessed 10/23/2026]',
    );
    expect(r.tokens).toEqual(['Smith 24']);
  });

  it('marks missing qualifications and is incomplete', () => {
    const meta = extractPageMetadata(ARTICLE.replace(/<p class="author-bio">.*?<\/p>/, ''), 'https://x.com/a');
    const quals = qualificationsFor(meta);
    expect(citeIsComplete(meta, quals)).toBe(false);
    expect(formatPfCite(meta, NOW, quals).cite).toContain('[qualifications]');
    expect(formatPfCite(meta, NOW, quals).cite.endsWith('Accessed 10/23/2026]')).toBe(true);
  });

  it('two authors: "Lastname and Lastname YY" lead, both names in the bracket', () => {
    const meta = extractPageMetadata(
      ARTICLE.replace('content="Jane Smith"', 'content="Laura Weiss and John Bresnahan"'),
      'https://punchbowl.news/x',
    );
    expect(meta.authors.slice(0, 2)).toEqual(['Laura Weiss', 'John Bresnahan']);
    const two = { ...meta, authors: ['Laura Weiss', 'John Bresnahan'] };
    const r = formatPfCite(two, NOW, ['Congressional reporter at Punchbowl News', 'Co-founder of Punchbowl News']);
    expect(r.tokens).toEqual(['Weiss and Bresnahan 24']);
    expect(r.cite.startsWith('Weiss and Bresnahan 24 [Laura Weiss and John Bresnahan, Laura is congressional reporter')).toBe(true);
    expect(citeLead(['A One', 'B Two', 'C Three'], '', '21')).toBe('One et al. 21');
    // An author whose credentials weren't found keeps a visible slot.
    const gap = formatPfCite(two, NOW, ['Co-host of Planet Money', '']);
    expect(gap.cite).toContain('Laura is co-host of Planet Money; John is [qualifications]');
    expect(citeLead([], 'Brookings Institution', '24')).toBe('Brookings Institution 24');
  });

  it('short dates are two-digit years', () => {
    expect(shortDate(new Date(2026, 9, 1), NOW)).toBe('26');
    expect(shortDate(new Date(2021, 5, 9), NOW)).toBe('21');
    expect(shortDate(new Date(2009, 1, 1), NOW)).toBe('09');
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
    const r = withCiteSignature({ cite: 'Smith 24 [x]', tokens: ['Smith 24'] }, '// arjun 🦡');
    expect(r.cite).toBe('Smith 24 [x] // arjun 🦡');
    expect(withCiteSignature(r, '// arjun 🦡').cite).toBe(r.cite);
  });

  it('author search: unwraps result links and ranks the right namesake first', () => {
    const r = (href: string, title: string, snippet: string) =>
      `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(href)}&rut=x">${title}</a><a class="result__snippet">${snippet}</a></div>`;
    const html = `<html><body>
      ${r('https://www.linkedin.com/in/someone', 'Ann Lee - Accountant | LinkedIn', 'Ann Lee is an accountant at Acme Corp.')}
      ${r('https://example.org/ann-lee', 'Ann Lee', 'Ann Lee likes hiking.')}
      ${r('https://www.brookings.edu/people/ann-lee/', 'Ann Lee | Brookings', 'Ann Lee is a senior fellow at the Brookings Institution.')}
    </body></html>`;
    const results = parseSearchResults(html);
    expect(results.map((x) => x.url)).toEqual([
      'https://www.linkedin.com/in/someone',
      'https://example.org/ann-lee',
      'https://www.brookings.edu/people/ann-lee/',
    ]);
    const meta = {
      url: 'https://www.brookings.edu/articles/x/', title: 'X', publication: 'Brookings Institution',
      authors: ['Ann Lee'], published: '2024', description: '', bylineText: '', excerpt: '', authorLinks: [], bioText: '',
    };
    const ranked = rankAuthorResults(results, 'Ann Lee', meta);
    // The article's own site first; namesakes with no tie to it dropped.
    expect(ranked.map((x) => x.url)).toEqual(['https://www.brookings.edu/people/ann-lee/']);
    expect(findQualifications('Ann Lee', ranked[0]!.snippet)).toBe('Senior fellow at the Brookings Institution');
  });

  it('author search: the article\'s subject and co-authors tell namesakes apart', () => {
    const meta = {
      url: 'https://www.foreignaffairs.com/tariffs-and-the-trade-war', title: 'How Tariffs Escalate a Trade War',
      publication: 'Foreign Affairs', authors: ['Mike Ross', 'Dana Kim'], published: '2025',
      description: 'Protectionism and retaliation in global supply chains.', bylineText: '', excerpt: '', authorLinks: [], bioText: '',
    };
    expect(topicWords(meta)).toEqual(expect.arrayContaining(['tariffs', 'escalate', 'trade', 'protectionism']));
    const results = [
      { url: 'https://chefs.example/mike-ross', title: 'Mike Ross, Chef', snippet: 'Mike Ross is a pastry chef in Columbus, Ohio.' },
      { url: 'https://econ.example.edu/people/ross', title: 'Mike Ross | Economics', snippet: 'Mike Ross is a professor of economics who studies tariffs and trade policy, often with Dana Kim.' },
    ];
    const ranked = rankAuthorResults(results, 'Mike Ross', meta, ['Dana Kim']);
    expect(ranked.map((r) => r.url)).toEqual(['https://econ.example.edu/people/ross']);
    expect(findQualifications('Mike Ross', ranked[0]!.snippet, ['Dana Kim'])).toBe(
      'Professor of economics who studies tariffs and trade policy',
    );
    // No tie at all → zero, so the chef is never used.
    expect(contextTie(results[0]!.snippet, 'chefs.example', meta, ['Dana Kim'])).toBe(0);
  });

  it('author search: an old bio with no tie to the outlet loses to the current profile', () => {
    const meta = {
      url: 'https://www.npr.org/2026/10/23/x/surveillance-new-york-city-nypd-police-security', title: 'How surveillance crept up on us',
      publication: 'NPR', authors: ['Amanda Aronczyk', 'Vito Emanuel'], published: '2026',
      description: 'Cameras, police and the city.', bylineText: '', excerpt: '', authorLinks: [], bioText: '',
    };
    const results = [
      { url: 'https://www.linkedin.com/in/vitoemanuel', title: 'Vito Emanuel - Assistant Producer @ NPR | LinkedIn',
        snippet: "Assistant Producer @ NPR · I'm an assistant producer on NPR's Planet Money and a recent graduate of Columbia Journalism School. In my past life…" },
      { url: 'https://www.npr.org/people/nx-s1-63544/vito-emanuel', title: 'Vito Emanuel - NPR', snippet: 'NPR stories by Vito Emanuel. Iranians walk amid shops…' },
      { url: 'https://dailybruin.com/2020/04/24/columns', title: 'Columns from Quarantine: Everyday memories loom largest for seniors',
        snippet: 'Vito Emanuel is a fourth-year political science and English student from Simi Valley, California, and a news reporter for the Daily Bruin.' },
    ];
    const ranked = rankAuthorResults(results, 'Vito Emanuel', meta, ['Amanda Aronczyk']);
    expect(ranked.map((r) => hostOf(r.url))).toEqual(['npr.org', 'linkedin.com']);
    const quals = ranked.map((r) => resultQualifications('Vito Emanuel', r, ['Amanda Aronczyk'])).find(Boolean);
    expect(quals).toBe("Assistant producer on NPR's Planet Money and a recent graduate of Columbia Journalism School");
    // Topic words alone never make a match.
    expect(contextTie('Mike Ross writes about police surveillance cameras.', 'blog.example', meta, [])).toBe(0);
  });
});
