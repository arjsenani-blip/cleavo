// @vitest-environment jsdom
/**
 * Google Docs clipboard HTML → CardMirror. Docs wraps every copy in
 * <b style="font-weight:normal" id="docs-internal-guid-…"> and writes
 * each run as a span with inline styles; highlights are
 * background-color, underlines text-decoration, bold font-weight:700.
 */
import { describe, expect, it } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { convertGoogleDocsHtml } from '../../src/import/html-paste.js';

const RUN = 'font-family:Arial,sans-serif;color:#000000;font-style:normal;font-variant:normal;vertical-align:baseline;white-space:pre;white-space:pre-wrap;';
const span = (text: string, extra: string) => `<span style="font-size:11pt;${RUN}font-weight:400;text-decoration:none;${extra}">${text}</span>`;
const wrap = (inner: string) => `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-5e6f">${inner}</b>`;

const CARD = wrap(
  `<h4 dir="ltr" style="line-height:1.38;margin-top:14pt;margin-bottom:4pt;"><span style="font-size:13pt;${RUN}font-weight:700;">Warming causes extinction</span></h4>` +
    `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:13pt;${RUN}font-weight:700;">Smith 23</span>${span(' [Jane Smith, Professor of Things]', '')}</p>` +
    `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">${span('Feedback loops ', 'font-size:8pt;')}${span('cause extinction', 'text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;background-color:#ffff00;')}${span(' and ', '')}${span('nothing stops them', 'font-weight:700;text-decoration:underline;background-color:#00ffff;')}</p>`,
);

function marksOf(doc: PMNode): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  doc.descendants((n) => {
    if (n.isText) out.push([n.text!, n.marks.map((m) => (m.type.name === 'highlight' ? `highlight:${m.attrs['color']}` : m.type.name)).sort()]);
    return true;
  });
  return out;
}

function blocksOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isTextblock) {
      out.push(n.type.name);
      return false;
    }
    return true;
  });
  return out;
}

describe('Google Docs paste', () => {
  it('keeps tag, cite, underlines, highlights and bold-underline emphasis', () => {
    const doc = convertGoogleDocsHtml(CARD)!;
    expect(doc).not.toBeNull();
    expect(blocksOf(doc)).toEqual(['tag', 'cite_paragraph', 'card_body']);
    const m = new Map(marksOf(doc));
    expect(m.get('Smith 23')).toContain('cite_mark');
    expect(m.get('Warming causes extinction')).toEqual([]);
    expect(m.get('cause extinction')).toEqual(['highlight:yellow', 'underline_mark']);
    expect(m.get('nothing stops them')).toEqual(['emphasis_mark', 'highlight:cyan']);
    expect(m.get('Feedback loops ')).toEqual(['font_size']);
  });

  it('a few lines with no card structure still keep their formatting', () => {
    const doc = convertGoogleDocsHtml(
      wrap(`<p dir="ltr">${span('plain ', '')}${span('underlined and lit', 'text-decoration:underline;background-color:#ffff00;')}</p>`),
    )!;
    expect(doc).not.toBeNull();
    expect(new Map(marksOf(doc)).get('underlined and lit')).toEqual(['highlight:yellow', 'underline_mark']);
  });

  it('a copy from inside one paragraph (spans, no <p>) becomes one paragraph', () => {
    const doc = convertGoogleDocsHtml(wrap(`${span('just ', '')}${span('this bit', 'text-decoration:underline;')}`))!;
    expect(doc).not.toBeNull();
    expect(doc.textContent).toBe('just this bit');
    expect(new Map(marksOf(doc)).get('this bit')).toEqual(['underline_mark']);
  });
});
