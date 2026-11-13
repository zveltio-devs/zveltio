import { describe, expect, it } from 'vitest';
import {
  FRAME_CSP,
  FRAME_SANDBOX,
  htmlText,
  restoreBlocked,
  safeUntrustedHtml,
  untrustedDocument,
} from './untrusted-html';

/**
 * A `richtext` value is untrusted (ADR 0042 decision 10). These run DOMPurify
 * for real (jsdom): every payload below is what anyone who can send a user an
 * email can put in front of them.
 */
const HOSTILE = [
  '<script>alert(1)</script>',
  '<script src="https://evil.test/x.js"></script>',
  '<img src=x onerror="alert(document.cookie)">',
  '<svg onload=alert(1)><circle /></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">d</a>',
  '<details open ontoggle=alert(1)>x</details>',
  '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
  '<form action="https://evil.test/"><input name=p></form>',
  '<base href="https://evil.test/">',
  '<style>body{background:url(https://evil.test/css)}</style>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/e">',
  '<p style="background:url(https://evil.test/pixel.gif)">styled</p>',
  '<img src="https://evil.test/track.gif?u=1" alt="pixel">',
  '<img srcset="https://evil.test/a.png 1x">',
  '<table background="https://evil.test/bg.png"><tr><td>t</td></tr></table>',
  // CSS that loads without spelling `url(`.
  `<p style="background-image:image-set('https://evil.test/set.png' 1x)">set</p>`,
  '<p style="background:\\75 rl(https://evil.test/esc.png)">esc</p>',
  '<p style="background:-webkit-image-set(\'https://evil.test/wk.png\' 1x)">wk</p>',
  // Remote forms that do not start with `//` or `https://`.
  '<img src="https:\\\\evil.test/bs.png">',
  '<img src="https:evil.test/noslash.png">',
  '<img src="//evil.test/proto.png">',
  '<img src="/relative/evil.test.png">',
  '<img srcset="data:image/png;base64,AAAA 1x, https://evil.test/second.png 2x">',
].join('\n');

describe('untrusted rich text', () => {
  it('nothing in a hostile message can run, navigate, or fetch', () => {
    const out = safeUntrustedHtml(HOSTILE).toLowerCase();
    for (const bad of [
      '<script',
      '<svg',
      '<iframe',
      '<object',
      '<embed',
      '<form',
      '<input',
      '<meta',
      '<base',
      '<style',
      '<details',
      'onerror',
      'onload',
      'ontoggle',
      'javascript:',
      'data:text/html',
    ]) {
      expect(out).not.toContain(bad);
    }
    // Every remote reference is moved out of reach: none is left where a
    // browser would load it (a read receipt for the sender).
    const root = document.createElement('div');
    root.innerHTML = safeUntrustedHtml(HOSTILE);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of ['src', 'srcset', 'background', 'poster']) {
        expect(el.getAttribute(attr) ?? '').not.toMatch(/evil\.test/);
      }
      expect(el.getAttribute('style') ?? '').not.toMatch(/url\(|evil\.test|\\/i);
    }
    expect(root.querySelector('img[data-blocked-src]')?.getAttribute('data-blocked-src')).toBe(
      'https://evil.test/track.gif?u=1',
    );
  });

  it('keeps what a mail client needs, and links open away with no opener', () => {
    // A plain colour function is kept: real mail is full of them.
    expect(
      safeUntrustedHtml('<p style="color:rgb(1, 2, 3);background:hsla(0,0%,50%,.5)">c</p>'),
    ).toContain('style="color:rgb(1, 2, 3);background:hsla(0,0%,50%,.5)"');
    const out = safeUntrustedHtml(
      '<table width="600"><tr><td bgcolor="#eee" align="center"><font color="red">Hi</font> <a href="https://x.test/">x</a> <img src="cid:logo"></td></tr></table>',
    );
    expect(out).toContain('<table width="600">');
    expect(out).toContain('align="center"');
    expect(out).toContain('<font color="red">Hi</font>');
    expect(out).toContain('src="cid:logo"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it('is drawn in a frame that runs nothing and loads nothing', () => {
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-scripts');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-forms');
    expect(FRAME_CSP).toMatch(/^default-src 'none';/);
    expect(FRAME_CSP).not.toMatch(/script-src|https?:/);
    const doc = untrustedDocument(HOSTILE, 'rgb(1, 2, 3)');
    expect(doc).toContain(`content="${FRAME_CSP}"`);
    expect(doc).toContain('color:rgb(1, 2, 3)');
    expect(doc.toLowerCase()).not.toContain('<script');
    // A colour that is not one is not spliced into the frame's style.
    expect(untrustedDocument('x', 'red;}</style><script>alert(1)</script>')).not.toContain(
      '<script',
    );
  });

  it('an editor stores what it blocked; a cell shows only text', () => {
    const root = document.createElement('div');
    root.innerHTML = safeUntrustedHtml('<p>a <img src="https://img.test/a.png"></p>');
    expect(root.innerHTML).not.toContain(' src=');
    expect(restoreBlocked(root)).toBe('<p>a <img src="https://img.test/a.png"></p>');
    expect(htmlText('<p>Hello <img src=x onerror=alert(1)><b>world</b></p>')).toBe('Hello world');
  });
});
