import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import {
  parseProgress,
  readExtra,
  markChaptersRead,
  markChaptersUnread,
  sanitizeTitle,
  resolveItems,
  type ItemPair,
} from "./progress-store";
import {
  getOutlineWithRetry,
  flattenOutline,
  getCurrentPageIndex,
  findActiveChapterIndex,
  navigateToLocation,
  type OutlineItem,
  type FlatOutlineItem,
} from "./toc-extractor";

// In-memory TOC cache: attachmentItemID -> flat outline (for progress calc)
const tocCache = new Map<number, FlatOutlineItem[]>();
// Nested outline cache: attachmentItemID -> nested outline (for tree rendering)
const tocTreeCache = new Map<number, OutlineItem[]>();
// Expanded state: attachmentItemID -> set of expanded chapter titles
const expandedState = new Map<number, Set<string>>();
// Manually toggled: attachmentItemID -> set of titles user manually toggled
const manuallyToggled = new Map<number, Set<string>>();
// Last known page index per attachment, for change detection
const lastPageIndex = new Map<number, number>();
// Last known active chapter title, for change detection
let lastActiveTitle: string | null = null;
// Position polling timer
let positionPollTimer: ReturnType<typeof setInterval> | null = null;
// Active render context for polling updates
let activeRenderContext: {
  body: HTMLElement;
  pair: ItemPair;
  setSectionSummary?: (summary: string) => void;
} | null = null;
// Flag to suppress re-render triggered by our own save
let selfSaveInProgress = false;

/**
 * Compute the set of titles that should be expanded to reveal the active chapter.
 */
function computeAncestorTitles(
  chapters: FlatOutlineItem[],
  activeIndex: number,
): Set<string> {
  const result = new Set<string>();
  if (activeIndex < 0) return result;

  let targetDepth = chapters[activeIndex].depth;
  for (let i = activeIndex - 1; i >= 0; i--) {
    if (chapters[i].depth < targetDepth) {
      result.add(chapters[i].title);
      targetDepth = chapters[i].depth;
      if (targetDepth === 0) break;
    }
  }
  const active = chapters[activeIndex];
  if (active.descendantTitles.length > 0) {
    result.add(active.title);
  }
  return result;
}

function startPositionPolling(attachmentID: number) {
  stopPositionPolling();
  positionPollTimer = setInterval(() => {
    const pageIdx = getCurrentPageIndex(attachmentID);
    if (pageIdx === null) return;

    const prev = lastPageIndex.get(attachmentID);
    if (prev === pageIdx) return;

    lastPageIndex.set(attachmentID, pageIdx);

    const chapters = tocCache.get(attachmentID);
    if (!chapters || chapters.length === 0) return;

    const activeIdx = findActiveChapterIndex(chapters, pageIdx);
    const newActiveTitle = activeIdx >= 0 ? chapters[activeIdx].title : null;

    if (newActiveTitle !== lastActiveTitle) {
      lastActiveTitle = newActiveTitle;

      // Recompute expanded state: keep only manually toggled + new ancestors
      if (activeIdx >= 0) {
        const ancestorTitles = computeAncestorTitles(chapters, activeIdx);
        const manual = manuallyToggled.get(attachmentID) || new Set<string>();
        const newExpanded = new Set<string>();

        // Keep manually expanded nodes
        const oldExpanded = expandedState.get(attachmentID) || new Set<string>();
        for (const title of oldExpanded) {
          if (manual.has(title)) {
            newExpanded.add(title);
          }
        }
        // Add ancestors of current chapter
        for (const title of ancestorTitles) {
          newExpanded.add(title);
        }
        expandedState.set(attachmentID, newExpanded);
      }

      if (activeRenderContext && activeRenderContext.body.isConnected) {
        renderSectionContent(
          activeRenderContext.body,
          activeRenderContext.pair,
          activeRenderContext.setSectionSummary,
        );
      }
    }
  }, 3000);
}

function stopPositionPolling() {
  if (positionPollTimer !== null) {
    clearInterval(positionPollTimer);
    positionPollTimer = null;
  }
}

/**
 * Update progress bar and summary text in-place (no DOM rebuild).
 */
function updateProgressDisplay(
  body: HTMLElement,
  pair: ItemPair,
  setSectionSummary?: (summary: string) => void,
) {
  const chapters = tocCache.get(pair.attachment.id);
  if (!chapters) return;

  const extra = readExtra(pair.parent);
  const progress = parseProgress(extra);
  const readCount = chapters.filter((c) => progress.has(c.title)).length;
  const total = chapters.length;
  const pct = total > 0 ? Math.round((readCount / total) * 100) : 0;
  const summaryText = `${readCount}/${total} (${pct}%)`;

  const container = body.querySelector(".zp-progress-container");
  if (!container) return;

  const fill = container.querySelector(".zp-progress-fill") as HTMLElement | null;
  if (fill) fill.style.width = `${pct}%`;

  const text = container.querySelector(".zp-progress-text");
  if (text) text.textContent = summaryText;

  if (setSectionSummary) setSectionSummary(summaryText);
}

export function registerProgressSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "zotero-progress",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("progress-section-head"),
      icon: `chrome://${config.addonRef}/content/icons/progress-16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("progress-section-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/progress-20.svg`,
    },
    sectionButtons: [
      {
        type: "markAllRead",
        icon: "chrome://zotero/skin/16/universal/check.svg",
        l10nID: getLocaleID("progress-btn-mark-all"),
        onClick: async ({ body, item }) => {
          try {
            const pair = resolveItems(item);
            if (!pair) return;
            const cached = tocCache.get(pair.attachment.id);
            if (!cached || cached.length === 0) return;
            const titles = cached.map((c) => c.title);
            selfSaveInProgress = true;
            await markChaptersRead(pair.parent, titles);
            selfSaveInProgress = false;
            renderSectionContent(body, pair);
          } catch (e) {
            selfSaveInProgress = false;
            ztoolkit.log("Error marking all read", e);
          }
        },
      },
      {
        type: "refreshToc",
        icon: "chrome://zotero/skin/16/universal/sync.svg",
        l10nID: getLocaleID("progress-btn-refresh"),
        onClick: async ({ body, item }) => {
          try {
            const pair = resolveItems(item);
            if (!pair) return;
            tocCache.delete(pair.attachment.id);
            tocTreeCache.delete(pair.attachment.id);
            expandedState.delete(pair.attachment.id);
            manuallyToggled.delete(pair.attachment.id);
            const outline = await getOutlineWithRetry(pair.attachment.id);
            if (outline && outline.length > 0) {
              tocTreeCache.set(pair.attachment.id, outline);
              tocCache.set(pair.attachment.id, flattenOutline(outline));
            }
            renderSectionContent(body, pair);
          } catch (e) {
            ztoolkit.log("Error refreshing TOC", e);
          }
        },
      },
    ],
    onItemChange: ({ item, setEnabled }) => {
      const pair = resolveItems(item);
      setEnabled(pair !== null);
      if (selfSaveInProgress) return false;
      return true;
    },
    onRender: ({ body }) => {
      body.replaceChildren();
      const container = body.ownerDocument!.createElement("div");
      container.className = "zp-progress-container";
      body.append(container);
    },
    onAsyncRender: async ({ body, item, setSectionSummary }) => {
      const pair = resolveItems(item);
      if (!pair) return;

      if (
        !tocCache.has(pair.attachment.id) ||
        !tocTreeCache.has(pair.attachment.id)
      ) {
        const outline = await getOutlineWithRetry(pair.attachment.id, 15);
        if (outline && outline.length > 0) {
          tocTreeCache.set(pair.attachment.id, outline);
          tocCache.set(pair.attachment.id, flattenOutline(outline));
        }
      }

      // Compute initial expanded state from reading position
      const chapters = tocCache.get(pair.attachment.id);
      if (chapters && chapters.length > 0) {
        const pageIdx = getCurrentPageIndex(pair.attachment.id);
        if (pageIdx !== null) {
          lastPageIndex.set(pair.attachment.id, pageIdx);
          const activeIdx = findActiveChapterIndex(chapters, pageIdx);
          if (activeIdx >= 0) {
            const ancestorTitles = computeAncestorTitles(chapters, activeIdx);
            if (!expandedState.has(pair.attachment.id)) {
              expandedState.set(pair.attachment.id, ancestorTitles);
            } else {
              const expanded = expandedState.get(pair.attachment.id)!;
              const manual =
                manuallyToggled.get(pair.attachment.id) || new Set<string>();
              for (const title of ancestorTitles) {
                if (!manual.has(title)) {
                  expanded.add(title);
                }
              }
            }
          }
        }
      }

      activeRenderContext = { body, pair, setSectionSummary };
      renderSectionContent(body, pair, setSectionSummary);
      startPositionPolling(pair.attachment.id);
    },
  });
}

function renderSectionContent(
  body: HTMLElement,
  pair: ItemPair,
  setSectionSummary?: (summary: string) => void,
) {
  if (!body.isConnected) return;

  const doc = body.ownerDocument!;
  let container = body.querySelector(
    ".zp-progress-container",
  ) as HTMLElement | null;
  if (!container) {
    container = doc.createElement("div");
    container.className = "zp-progress-container";
    body.replaceChildren(container);
  }
  container.replaceChildren();

  const chapters = tocCache.get(pair.attachment.id);
  const treeItems = tocTreeCache.get(pair.attachment.id);
  const extra = readExtra(pair.parent);
  const progress = parseProgress(extra);

  if (!chapters || chapters.length === 0) {
    const hint = doc.createElement("div");
    hint.className = "zp-no-toc";
    hint.textContent = getString("progress-no-toc");
    container.append(hint);
    if (setSectionSummary) setSectionSummary("");
    return;
  }

  const readCount = chapters.filter((c) => progress.has(c.title)).length;
  const total = chapters.length;
  const pct = total > 0 ? Math.round((readCount / total) * 100) : 0;
  const summaryText = `${readCount}/${total} (${pct}%)`;

  if (setSectionSummary) {
    setSectionSummary(summaryText);
  }

  // Determine active chapter
  let activeTitle: string | null = null;
  const pageIdx = getCurrentPageIndex(pair.attachment.id);
  if (pageIdx !== null) {
    const activeIdx = findActiveChapterIndex(chapters, pageIdx);
    if (activeIdx >= 0) {
      activeTitle = chapters[activeIdx].title;
    }
  }

  // Progress bar
  const headerDiv = doc.createElement("div");
  headerDiv.className = "zp-progress-header";

  const progressBar = doc.createElement("div");
  progressBar.className = "zp-progress-bar";
  const progressFill = doc.createElement("div");
  progressFill.className = "zp-progress-fill";
  progressFill.style.width = `${pct}%`;
  progressBar.append(progressFill);

  const progressText = doc.createElement("div");
  progressText.className = "zp-progress-text";
  progressText.textContent = summaryText;

  headerDiv.append(progressBar, progressText);
  container.append(headerDiv);

  // Chapter list — tree rendering
  const list = doc.createElement("div");
  list.className = "zp-chapter-list";

  const expanded = expandedState.get(pair.attachment.id) || new Set<string>();
  const items = treeItems || [];

  renderTree(
    doc,
    list,
    items,
    0,
    pair,
    progress,
    expanded,
    activeTitle,
    body,
    setSectionSummary,
  );

  container.append(list);
}

function renderTree(
  doc: Document,
  parentEl: HTMLElement,
  items: OutlineItem[],
  depth: number,
  pair: ItemPair,
  progress: Map<string, string>,
  expanded: Set<string>,
  activeTitle: string | null,
  body: HTMLElement,
  setSectionSummary?: (summary: string) => void,
) {
  for (const item of items) {
    const hasChildren = item.items && item.items.length > 0;
    const title = sanitizeTitle(item.title);
    const isRead = progress.has(title);
    const readAt = progress.get(title) || null;
    const isExpanded = expanded.has(title);
    const isActive = title === activeTitle;

    const row = doc.createElement("div");
    row.className = "zp-chapter-row";
    row.dataset.title = title;
    if (isRead) row.classList.add("zp-read");
    if (isActive) row.classList.add("zp-active");
    row.style.paddingLeft = `${depth * 14 + 4}px`;

    // Toggle arrow or spacer
    const toggle = doc.createElement("span");
    toggle.className = "zp-toggle";
    if (hasChildren) {
      toggle.textContent = isExpanded ? "\u25BC" : "\u25B6";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const exp =
          expandedState.get(pair.attachment.id) || new Set<string>();
        const manual =
          manuallyToggled.get(pair.attachment.id) || new Set<string>();
        if (exp.has(title)) {
          exp.delete(title);
        } else {
          exp.add(title);
        }
        manual.add(title);
        expandedState.set(pair.attachment.id, exp);
        manuallyToggled.set(pair.attachment.id, manual);

        const childContainer = row.nextElementSibling;
        if (
          childContainer &&
          childContainer.classList.contains("zp-children")
        ) {
          childContainer.classList.toggle("zp-collapsed");
          toggle.textContent = exp.has(title) ? "\u25BC" : "\u25B6";
        }
      });
    }
    row.append(toggle);

    // Checkbox
    const flatChapter = findFlatChapter(pair.attachment.id, title);
    const checkbox = doc.createElement("input") as HTMLInputElement;
    checkbox.type = "checkbox";
    checkbox.checked = isRead;
    checkbox.className = "zp-chapter-checkbox";
    checkbox.addEventListener("change", () => {
      if (flatChapter) {
        onCheckboxChange(body, pair, flatChapter, checkbox.checked, setSectionSummary);
      }
    });
    row.append(checkbox);

    // Title — click to navigate
    const titleSpan = doc.createElement("span");
    titleSpan.className = "zp-chapter-title";
    titleSpan.textContent = title;
    titleSpan.addEventListener("click", () => {
      if (item.location) {
        navigateToLocation(pair.attachment.id, item.location);
      }
    });
    row.append(titleSpan);

    // Timestamp
    if (readAt) {
      const timeSpan = doc.createElement("span");
      timeSpan.className = "zp-chapter-time";
      timeSpan.textContent = readAt;
      row.append(timeSpan);
    }

    parentEl.append(row);

    // Children container
    if (hasChildren) {
      const childContainer = doc.createElement("div");
      childContainer.className = "zp-children";
      if (!isExpanded) {
        childContainer.classList.add("zp-collapsed");
      }
      renderTree(
        doc,
        childContainer,
        item.items!,
        depth + 1,
        pair,
        progress,
        expanded,
        activeTitle,
        body,
        setSectionSummary,
      );
      parentEl.append(childContainer);
    }
  }
}

function findFlatChapter(
  attachmentID: number,
  title: string,
): FlatOutlineItem | undefined {
  const chapters = tocCache.get(attachmentID);
  if (!chapters) return undefined;
  return chapters.find((c) => c.title === title);
}

/**
 * Handle checkbox change with in-place DOM update (no full re-render).
 * `nowChecked` reflects the NEW state of the checkbox that was clicked.
 */
async function onCheckboxChange(
  body: HTMLElement,
  pair: ItemPair,
  chapter: FlatOutlineItem,
  nowChecked: boolean,
  setSectionSummary?: (summary: string) => void,
) {
  try {
    const titles = [chapter.title, ...chapter.descendantTitles];
    const titlesSet = new Set(titles);

    // 1. In-place DOM update — immediate, no layout shift
    const container = body.querySelector(".zp-progress-container");
    if (container) {
      const rows = container.querySelectorAll<HTMLElement>(".zp-chapter-row");
      for (const row of rows) {
        const rowTitle = row.dataset.title;
        if (!rowTitle || !titlesSet.has(rowTitle)) continue;

        const cb = row.querySelector(".zp-chapter-checkbox") as HTMLInputElement | null;
        if (nowChecked) {
          row.classList.add("zp-read");
          if (cb) cb.checked = true;
        } else {
          row.classList.remove("zp-read");
          if (cb) cb.checked = false;
          const timeSpan = row.querySelector(".zp-chapter-time");
          if (timeSpan) timeSpan.remove();
        }
      }
    }

    // 2. Save to Extra in background
    selfSaveInProgress = true;
    if (nowChecked) {
      await markChaptersRead(pair.parent, titles);
    } else {
      await markChaptersUnread(pair.parent, titles);
    }
    selfSaveInProgress = false;

    // 3. Update progress bar in-place
    updateProgressDisplay(body, pair, setSectionSummary);
  } catch (e) {
    selfSaveInProgress = false;
    ztoolkit.log("Error toggling chapter read status", e);
  }
}

export function unregisterProgressSection() {
  stopPositionPolling();
  activeRenderContext = null;
  Zotero.ItemPaneManager.unregisterSection("zotero-progress");
  tocCache.clear();
  tocTreeCache.clear();
  expandedState.clear();
  manuallyToggled.clear();
  lastPageIndex.clear();
}
