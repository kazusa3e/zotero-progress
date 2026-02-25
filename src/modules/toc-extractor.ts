import { sanitizeTitle } from "./progress-store";

export interface OutlineItem {
  title: string;
  location: any;
  items?: OutlineItem[];
}

export interface FlatOutlineItem {
  title: string;
  depth: number;
  location: any;
  descendantTitles: string[];
}

/**
 * Get the outline from an active Reader instance by item ID.
 */
export function getOutline(itemID: number): OutlineItem[] | null {
  const internal = getReaderInternal(itemID);
  if (!internal) return null;
  try {
    const outline = internal._state?.outline;
    if (outline === null || outline === undefined) return null;
    return outline as OutlineItem[];
  } catch (e) {
    ztoolkit.log("Failed to get outline from reader", e);
    return null;
  }
}

/**
 * Try to get outline with retries (it may still be loading).
 */
export async function getOutlineWithRetry(
  itemID: number,
  maxRetries = 10,
): Promise<OutlineItem[] | null> {
  for (let i = 0; i < maxRetries; i++) {
    const outline = getOutline(itemID);
    if (outline !== null && outline.length > 0) return outline;
    await Zotero.Promise.delay(800);
  }
  return getOutline(itemID);
}

/**
 * Collect all titles from nested outline items.
 */
function collectTitles(items: OutlineItem[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    result.push(sanitizeTitle(item.title));
    if (item.items && item.items.length > 0) {
      result.push(...collectTitles(item.items));
    }
  }
  return result;
}

/**
 * Flatten nested outline into a flat list with depth and descendant info.
 */
export function flattenOutline(
  items: OutlineItem[],
  depth = 0,
): FlatOutlineItem[] {
  const result: FlatOutlineItem[] = [];
  for (const item of items) {
    const descendantTitles =
      item.items && item.items.length > 0 ? collectTitles(item.items) : [];
    result.push({
      title: sanitizeTitle(item.title),
      depth,
      location: item.location,
      descendantTitles,
    });
    if (item.items && item.items.length > 0) {
      result.push(...flattenOutline(item.items, depth + 1));
    }
  }
  return result;
}

/**
 * Get the Zotero Reader internal reader object for a given item ID.
 */
function getReaderInternal(itemID: number): any | null {
  const readers = Zotero.Reader._readers;
  if (!readers) return null;
  for (const reader of readers) {
    if (reader.itemID === itemID) {
      try {
        return reader._iframeWindow?.wrappedJSObject?._reader ?? null;
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

/**
 * Extract a numeric page index from a location object.
 * Handles various Zotero Reader location formats.
 */
function extractPageIndex(location: any): number | null {
  if (!location) return null;
  // Direct pageIndex
  if (typeof location.pageIndex === "number") return location.pageIndex;
  // Nested in position
  if (location.position && typeof location.position.pageIndex === "number") {
    return location.position.pageIndex;
  }
  return null;
}

/**
 * Get the current reading location from an active Reader instance.
 * Returns a numeric page index comparable to outline location.pageIndex.
 */
export function getCurrentPageIndex(itemID: number): number | null {
  const internal = getReaderInternal(itemID);
  if (!internal) return null;
  try {
    const state = internal._state;
    if (!state) return null;
    // Try primaryViewState first
    const pvs = state.primaryViewState;
    if (pvs) {
      if (typeof pvs.pageIndex === "number") return pvs.pageIndex;
      if (typeof pvs.currentPageIndex === "number") return pvs.currentPageIndex;
    }
    // Try top-level pageIndex
    if (typeof state.pageIndex === "number") return state.pageIndex;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Find the index of the active chapter based on current page index.
 * Returns the index of the last chapter whose location pageIndex <= pageIndex.
 */
export function findActiveChapterIndex(
  chapters: FlatOutlineItem[],
  pageIndex: number,
): number {
  let activeIndex = -1;
  for (let i = 0; i < chapters.length; i++) {
    const pi = extractPageIndex(chapters[i].location);
    if (pi !== null && pi <= pageIndex) {
      activeIndex = i;
    }
  }
  return activeIndex;
}

/**
 * Navigate the reader to a given outline location.
 */
export function navigateToLocation(itemID: number, location: any): void {
  const internal = getReaderInternal(itemID);
  if (!internal) return;
  try {
    if (typeof internal.navigate === "function") {
      internal.navigate(location);
    }
  } catch (e) {
    ztoolkit.log("Failed to navigate reader", e);
  }
}
