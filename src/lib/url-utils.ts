/**
 * Utilities for spotting and dissecting malformed "concatenated" URLs — single
 * crawled addresses that actually contain several URLs mashed together, the
 * classic symptom of a broken <a href> in page markup (missing quote, template
 * bug, or copy-paste error). Screaming Frog crawls the whole blob as one
 * Address, it 404s, and without this handling the report shows one giant
 * unreadable cell instead of a precise finding.
 *
 * A second `https?://` inside a URL is only treated as malformed when it sits
 * in path context. URLs passed as query-param values (`?url=https://…`,
 * `&next=https://…`, `?https://…`) are legitimate and left alone.
 */

const SCHEME_RE = /https?:\/\//gi;

/** Positions (index > 0) where another scheme starts in *path* context. */
function embeddedSchemeCuts(url: string): number[] {
  const cuts: number[] = [];
  SCHEME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCHEME_RE.exec(url))) {
    if (m.index === 0) continue;
    const prev = url[m.index - 1];
    if (prev === "=" || prev === "?" || prev === "&") continue; // query-param value — legitimate
    cuts.push(m.index);
  }
  return cuts;
}

/** True when the address contains multiple URLs concatenated together. */
export function isConcatenatedUrl(url: string): boolean {
  return embeddedSchemeCuts(url).length > 0;
}

/**
 * Split a concatenated address into its constituent URLs.
 * Returns `[url]` unchanged when the address is clean.
 * Trailing separator junk (`%20`, whitespace, stray `:` / `,` / `;`) left at
 * the seam between two URLs is trimmed from each piece.
 */
export function splitConcatenatedUrls(url: string): string[] {
  const cuts = embeddedSchemeCuts(url);
  if (cuts.length === 0) return [url];
  const parts: string[] = [];
  let start = 0;
  for (const cut of [...cuts, url.length]) {
    const piece = url
      .slice(start, cut)
      .replace(/(?:%20|\s)+$/gi, "")
      .replace(/[,;:]+$/g, "");
    if (piece) parts.push(piece);
    start = cut;
  }
  return parts.length > 1 ? parts : [url];
}
