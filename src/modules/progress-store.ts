const ZP_PREFIX = "zp-read: ";

/**
 * Sanitize a chapter title for safe storage (remove newlines, trim whitespace).
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Parse zp-read lines from Extra field.
 * Returns a Map of title -> readAt timestamp.
 */
export function parseProgress(extra: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!extra) return result;
  for (const line of extra.split("\n")) {
    if (line.startsWith(ZP_PREFIX)) {
      const rest = line.slice(ZP_PREFIX.length);
      const sepIndex = rest.lastIndexOf(" | ");
      if (sepIndex !== -1) {
        const title = rest.slice(0, sepIndex);
        const readAt = rest.slice(sepIndex + 3);
        result.set(title, readAt);
      }
    }
  }
  return result;
}

/**
 * Read Extra field from a regular (non-attachment) item.
 */
export function readExtra(item: Zotero.Item): string {
  return (item.getField("extra") as string) || "";
}

/**
 * Write read chapters back to Extra field, preserving other content.
 * `item` must be a regular (parent) item, NOT an attachment.
 */
async function writeProgress(
  item: Zotero.Item,
  readChapters: Map<string, string>,
): Promise<void> {
  const extra = readExtra(item);
  const otherLines = extra
    .split("\n")
    .filter((line) => !line.startsWith(ZP_PREFIX));
  const zpLines: string[] = [];
  for (const [title, readAt] of readChapters) {
    zpLines.push(`${ZP_PREFIX}${title} | ${readAt}`);
  }
  const newExtra = [...otherLines, ...zpLines].filter(Boolean).join("\n");
  item.setField("extra", newExtra);
  await item.saveTx();
}

export function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Mark given chapters as read (does not unmark others).
 */
export async function markChaptersRead(
  item: Zotero.Item,
  titles: string[],
): Promise<void> {
  const progress = parseProgress(readExtra(item));
  const now = formatTimestamp(new Date());
  for (const title of titles) {
    if (!progress.has(title)) {
      progress.set(title, now);
    }
  }
  await writeProgress(item, progress);
}

/**
 * Mark multiple chapters as unread.
 */
export async function markChaptersUnread(
  item: Zotero.Item,
  titles: string[],
): Promise<void> {
  const progress = parseProgress(readExtra(item));
  for (const title of titles) {
    progress.delete(title);
  }
  await writeProgress(item, progress);
}

export interface ItemPair {
  parent: Zotero.Item;
  attachment: Zotero.Item;
}

/**
 * Given any item (parent or attachment), resolve to a { parent, attachment } pair.
 * Returns null if no suitable PDF/EPUB attachment is found.
 */
export function resolveItems(item: Zotero.Item): ItemPair | null {
  if (item.isAttachment()) {
    const contentType = item.attachmentContentType;
    if (
      contentType !== "application/pdf" &&
      contentType !== "application/epub+zip"
    ) {
      return null;
    }
    const parent = item.parentItem;
    if (!parent) return null;
    return { parent, attachment: item };
  }

  if (!item.isRegularItem()) return null;

  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const att = Zotero.Items.get(id);
    if (att) {
      const contentType = att.attachmentContentType;
      if (
        contentType === "application/pdf" ||
        contentType === "application/epub+zip"
      ) {
        return { parent: item, attachment: att };
      }
    }
  }
  return null;
}
