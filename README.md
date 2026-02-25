# Zotero Progress

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero 8 plugin that tracks PDF/EPUB reading progress by TOC chapters in the Item Pane.

## Features

- **Chapter-level progress tracking** — check off TOC chapters as you read
- **Progress panel** in Item Pane with progress bar, chapter tree, and timestamps
- **Progress column** in the item list showing `3/7` summary
- **Cascading checkboxes** — marking a parent chapter marks all children
- **Auto-scroll to active chapter** — follows your reading position
- **Click to navigate** — click a chapter title to jump to it in the reader
- Supports both **PDF** and **EPUB** attachments

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/kazusa/zotero-progress/releases)
2. In Zotero: Tools → Add-ons → gear icon → Install Add-on From File → select the `.xpi`

## Build

```bash
npm install
npm run build        # production build → .scaffold/build/
npm run start        # dev mode with hot reload
```

## Data Format

Reading progress is stored in the **parent item's** Extra field:

```
zp-read: Chapter Title Here | 2024-01-15 10:30
zp-read: Another Chapter | 2024-01-16 14:00
```

- One line per read chapter, prefixed with `zp-read: `
- Other Extra field content is preserved
- TOC structure is extracted live from the Zotero Reader (not stored)

## License

AGPL-3.0-or-later
