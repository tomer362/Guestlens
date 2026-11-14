/** Pure feed-merge logic for the album (unit-tested in tests/feed.test.ts). */
export interface FeedItem { id: string; at: string }

const older = (a: FeedItem, b: FeedItem) => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * Merge a freshly fetched first page (newest first) into what the client already shows.
 * - new items appear on top, hidden ones inside the first page disappear
 * - older items the client already paged in are kept
 * - if the whole page is new there may be a gap below it: reset to the page (the caller then
 *   uses the page's own `nextBefore` for "load more")
 */
export function mergeFirstPage<T extends FeedItem>(prev: T[], page: T[], pageFull: boolean): { items: T[]; added: number; reset: boolean } {
  if (!prev.length) return { items: page, added: 0, reset: true };
  const prevIds = new Set(prev.map((p) => p.id));
  const added = page.filter((p) => !prevIds.has(p.id)).length;
  if (pageFull && added === page.length) return { items: page, added, reset: true };
  const pageIds = new Set(page.map((p) => p.id));
  const oldest = page[page.length - 1];
  const rest = oldest ? prev.filter((p) => !pageIds.has(p.id) && older(p, oldest)) : [];
  return { items: [...page, ...rest], added, reset: false };
}
