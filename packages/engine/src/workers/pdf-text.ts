/**
 * HTML reduced to the text the PDF draws, with headings marked as
 * `__H<level>__…__END__` lines. Its own module so it can be tested: importing the
 * worker itself assigns `self.onmessage`, which keeps a test process alive.
 *
 * The heading pass runs before closing heading tags are turned into blank
 * lines: it ran after, found no `</hN>` left to pair, and every heading was
 * drawn as body text.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(
        /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
        (_: string, level: string, content: string) =>
          `\n__H${level}__${content.replace(/<[^>]+>/g, '')}__END__\n`,
      )
      // Headings the line above could not pair (content spanning lines) still
      // end their paragraph.
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      // These four decoded the entities an HTML template carries. They had been
      // flattened to `.replace(/&/g, '&')` — pattern and replacement identical,
      // four no-ops in a row — so `Smith &amp; Co` printed as `Smith &amp; Co` in
      // the PDF. `&amp;` goes LAST: decoding it first would turn `&amp;lt;` into a
      // `<`, which is the classic double-decode.
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
