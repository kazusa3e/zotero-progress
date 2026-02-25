import { config } from "../../package.json";
import { parseProgress, readExtra, resolveItems } from "./progress-store";
import { flattenOutline, getOutline } from "./toc-extractor";

export async function registerProgressColumn() {
  await Zotero.ItemTreeManager.registerColumns({
    pluginID: config.addonID,
    dataKey: "zp-progress",
    label: "Progress",
    dataProvider: (item: Zotero.Item, _dataKey: string) => {
      return getProgressString(item);
    },
  });
}

function getProgressString(item: Zotero.Item): string {
  const pair = resolveItems(item);
  if (!pair) return "";

  const extra = readExtra(pair.parent);
  const progress = parseProgress(extra);
  if (progress.size === 0) return "";

  const outline = getOutline(pair.attachment.id);
  if (outline && outline.length > 0) {
    const flat = flattenOutline(outline);
    return `${progress.size}/${flat.length}`;
  }

  return `${progress.size}/?`;
}

export function unregisterProgressColumn() {
  // Column unregistration is handled by ztoolkit.unregisterAll()
}
