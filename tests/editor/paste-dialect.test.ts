/**
 * Paste-source routing (smart paste conversion, survey 2026-07-15).
 * The detector must (a) recognize Word and haku.cards clipboard HTML
 * by strong signatures, and (b) refuse everything else — ordinary web
 * copies, Google Docs, CMS-laundered Word remnants, CardMirror's own
 * clipboard — so regular pastes are never routed into a converter.
 *
 * The haku fixtures mirror the production copy builders verbatim
 * (decompiled `buildCardCopyHtml`, verified 2026-07-15): Calibri
 * wrapper div, 13pt bold <h4> tag, cite <p> with a bold 13pt lead
 * span, pt-sized run spans with literal <u>, highlight group spans
 * with `mso-highlight:<named>` + `box-decoration-break:clone`.
 */
import { describe, expect, it } from 'vitest';
import { detectPasteDialect } from '../../src/editor/paste-dialect.js';

// --- Word fixtures -------------------------------------------------

const WORD_MAC = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta name=Generator content="Microsoft Word 15 (filtered)"><style><!-- p.MsoNormal {mso-style-parent:""; font-size:11.0pt;} --></style></head><body><h4 style='mso-style-name:"Heading 4"'>Warming causes extinction</h4><p class=MsoNormal><span class=Style13ptBold>Smith ’23</span></p><p class=MsoNormal><u>Feedback loops accelerate</u></p></body></html>`;

const WORD_WIN = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=ProgId content=Word.Document><meta name=Generator content="Microsoft Word 15"><meta name=Originator content="Microsoft Word 15"></head><body lang=EN-US style='tab-interval:.5in'><!--StartFragment--><p class=MsoNormal>Some evidence text<o:p></o:p></p><!--EndFragment--></body></html>`;

// --- haku fixtures (shape of buildCardCopyHtml output) ---------------

const HAKU_HIGHLIGHTED = `<div style="font-family:Calibri, Candara, Segoe, 'Segoe UI', Optima, Arial, sans-serif"><h4 style="margin:0 0 2px 0;font-weight:700;font-size:13pt;line-height:108%;">Warming causes extinction</h4><p style="font-weight:400;font-size:11pt;line-height:110%;margin:0 0 3px 0;"><span style="font-weight:700;font-size:13pt;line-height:108%;">Smith ’23</span><span> (Jane, Professor, Journal of Things)</span></p><p style="font-weight:400;font-size:11.00pt;line-height:172%;margin:0 0 3px 0"><span style="font-size:8.00pt;">Feedback loops </span><span style="font-weight:400;font-style:normal;background:yellow;mso-highlight:yellow;background-color:#FF0;color:#1b1b1c;font-size:12.00pt;line-height:172%;padding-top:0.055em;padding-bottom:0.055em;padding-left:0.055em;padding-right:0.055em;box-decoration-break:clone;-webkit-box-decoration-break:clone"><u>cause extinction</u></span></p></div>`;

const HAKU_UNHIGHLIGHTED = `<div style="font-family:Calibri, Candara, Segoe, 'Segoe UI', Optima, Arial, sans-serif"><h4 style="margin:0 0 2px 0;font-weight:700;font-size:13pt;line-height:108%;">Warming causes extinction</h4><p style="font-weight:400;font-size:11pt;line-height:110%;margin:0 0 3px 0;"><span style="font-weight:700;font-size:13pt;line-height:108%;">Smith ’23</span></p><p style="font-weight:400;font-size:11.00pt;line-height:172%;margin:0 0 3px 0"><span style="font-size:8.00pt;">Feedback loops </span><span style="font-size:12.00pt;"><u>cause extinction</u></span></p></div>`;

// --- non-matches ----------------------------------------------------

const GOOGLE_DOCS = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-5e6f"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;font-weight:700;">Warming bad</span></p><p dir="ltr"><span style="font-size:11pt;font-family:Arial,sans-serif;text-decoration:underline;">evidence text</span></p></b>`;

const PLAIN_WEB = `<article class="post"><h2>Why the climate matters</h2><p>Some <b>bold</b> text with a <a href="https://example.com">link</a> and <u>an underline</u>.</p><ul><li>a list item</li></ul></article>`;

const CMS_LAUNDERED_WORD = `<div class="entry-content"><p class="MsoNormal" style="mso-margin-top-alt:auto;mso-margin-bottom-alt:auto;">Text a blogger once pasted from Word.</p><p class="MsoNormal"><span style="mso-bidi-font-weight:bold;">More remnants.</span></p></div>`;

const CARDMIRROR_OWN = `<div data-pm-slice="1 1 []"><h4 class="pmd-tag" indent="0">Tag text</h4><p class="pmd-card-body"><span class="pmd-underline">underlined</span></p></div>`;

describe('detectPasteDialect routing', () => {
  it('recognizes the Word document shell (Mac and Windows flavors)', () => {
    expect(detectPasteDialect(WORD_MAC)).toBe('word');
    expect(detectPasteDialect(WORD_WIN)).toBe('word');
  });

  it('recognizes haku card copies — highlighted and unhighlighted', () => {
    expect(detectPasteDialect(HAKU_HIGHLIGHTED)).toBe('haku');
    expect(detectPasteDialect(HAKU_UNHIGHLIGHTED)).toBe('haku');
  });

  it('Word wins over haku markers when the shell is present (haku HTML is Word-targeted, not vice versa)', () => {
    // A Word doc containing text ONCE pasted from haku still has the shell.
    const wordWithHakuInnards = WORD_WIN.replace(
      'Some evidence text',
      '<span style="mso-highlight:yellow;box-decoration-break:clone">hl</span>',
    );
    expect(detectPasteDialect(wordWithHakuInnards)).toBe('word');
  });

  it('never converts ordinary web copies', () => {
    expect(detectPasteDialect(PLAIN_WEB)).toBeNull();
  });

  it('routes Google Docs copies to the Docs converter', () => {
    expect(detectPasteDialect(GOOGLE_DOCS)).toBe('gdocs');
  });

  it('CMS-laundered Word remnants (Mso classes, mso-* inline props, no shell) do not match', () => {
    expect(detectPasteDialect(CMS_LAUNDERED_WORD)).toBeNull();
  });

  it("CardMirror's own clipboard is excluded (schema parse rules own it)", () => {
    expect(detectPasteDialect(CARDMIRROR_OWN)).toBeNull();
  });

  it('empty / absent / whitespace HTML → null', () => {
    expect(detectPasteDialect('')).toBeNull();
    expect(detectPasteDialect(null)).toBeNull();
    expect(detectPasteDialect(undefined)).toBeNull();
    expect(detectPasteDialect('   \n ')).toBeNull();
  });

  it('a single haku-ish trait is not enough (Calibri alone, underlines alone)', () => {
    expect(
      detectPasteDialect('<div style="font-family:Calibri"><p>newsletter text</p></div>'),
    ).toBeNull();
    expect(
      detectPasteDialect('<p><u>underlined web text</u> at <span style="font-size:14px">px sizes</span></p>'),
    ).toBeNull();
  });

  it('haku case exports (26pt h1 pockets / 22pt h2 hats) count toward the fingerprint', () => {
    const caseExport = `<div style="font-family:Calibri, sans-serif"><h1 style="font-weight:700;font-size:26pt;">Case Neg</h1><h2 style="font-weight:700;font-size:22pt;text-decoration:underline;">Framing</h2><p style="font-size:11pt;"><u>text</u></p></div>`;
    expect(detectPasteDialect(caseExport)).toBe('haku');
  });
});
