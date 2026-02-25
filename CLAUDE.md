# zotero-progress

Zotero 8 插件：在 Item Pane 中按 TOC 章节追踪 PDF/EPUB 阅读进度。

## 构建

```bash
npm install
npm run build        # 生产构建，输出到 .scaffold/build/
npm run start        # 开发模式（热重载）
```

基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 脚手架，使用 `zotero-plugin-scaffold` 构建。

## 项目结构

```
src/
  index.ts                    # 入口（模板提供）
  addon.ts                    # Addon 类（模板提供）
  hooks.ts                    # 生命周期钩子：注册/注销所有模块
  modules/
    progress-store.ts         # 数据层：Extra 字段读写、进度 CRUD、resolveItems
    toc-extractor.ts          # TOC 提取：从 Reader 内部状态获取 outline
    progress-section.ts       # UI：Item Pane 自定义面板
    progress-column.ts        # UI：条目列表自定义列
  utils/
    locale.ts                 # 本地化工具
    ztoolkit.ts               # ZToolkit 初始化
    prefs.ts                  # 偏好设置工具
    window.ts                 # 窗口工具
addon/
  manifest.json               # 插件清单
  bootstrap.js                # 模板提供
  content/
    icons/                    # 插件图标
    zotero-progress.css       # 进度面板样式
  locale/
    en-US/addon.ftl           # 英文本地化
    en-US/mainWindow.ftl
    zh-CN/addon.ftl           # 中文本地化
    zh-CN/mainWindow.ftl
```

## 技术方案

### 数据存储（progress-store.ts）

在**父条目**（regular parent item）的 Extra 字段中，以每行一条的格式存储已读章节：

```
zp-read: Chapter Title Here | 2024-01-15 10:30
zp-read: Another Chapter | 2024-01-16 14:00
```

- **重要**：Zotero 8 中 attachment 类型条目不支持 `getField('extra')`，必须存储在父条目上
- 只存储已读章节（未读的不存储）
- 格式：`zp-read: {章节标题} | {YYYY-MM-DD HH:mm}`
- 写入时保留 Extra 字段中非 `zp-read:` 开头的其他内容
- `resolveItems(item)` 负责解析：给定任意条目（父条目或附件），返回 `{ parent, attachment }` 对
- 导出的进度 API：`markChaptersRead`、`markChaptersUnread`

### TOC 提取（toc-extractor.ts）

通过 Zotero Reader 内部状态获取：

```
reader._iframeWindow.wrappedJSObject._reader._state.outline
```

- `getReaderInternal(itemID)` 遍历 `Zotero.Reader._readers` 匹配 `reader.itemID`，返回内部 reader 对象
- `getOutline()` 和 `getCurrentPageIndex()` 均通过 `getReaderInternal()` 获取 reader
- Reader 打开时提取并缓存到内存（`tocCache: Map<itemID, FlatOutlineItem[]>`）
- outline 可能是 `null`（加载中）或 `[]`（无 TOC），使用重试机制（最多 10 次，间隔 800ms）
- `flattenOutline()` 将嵌套结构扁平化，保留 `depth`（层级深度）和 `descendantTitles`（所有后代标题）

### UI：Item Pane 自定义面板（progress-section.ts）

通过 `Zotero.ItemPaneManager.registerSection()` 注册，paneID 为 `zotero-progress`：

- **进度条**：顶部显示进度条 + `3/7 (43%)` 文字
- **章节列表**：每行 = 勾选框 + 章节标题（按 depth 缩进） + 已读时间戳
- **头部按钮**：「全部标记已读」「刷新 TOC」
- **级联勾选**：勾选父级章节时，自动标记所有子级为已读；取消勾选只取消当前章节
- 仅对包含 PDF/EPUB 附件的条目显示（`onItemChange` 中通过 `setEnabled` 控制）

### UI：条目列表自定义列（progress-column.ts）

通过 `Zotero.ItemTreeManager.registerColumns()` 注册，dataKey 为 `zp-progress`：

- 显示 `3/7` 格式的进度摘要
- Reader 未打开时显示 `3/?`

### 生命周期（hooks.ts）

- `onStartup`：等待 Zotero 初始化 → initLocale → 注册 section 和 column
- `onMainWindowLoad`：加载 FTL 和 CSS
- `onMainWindowUnload`：ztoolkit.unregisterAll()
- `onShutdown`：注销 section、column，清理资源

## 插件配置

```json
{
  "addonName": "Zotero Progress",
  "addonID": "zotero-progress@kazusa",
  "addonRef": "zoteroprogress",
  "addonInstance": "ZoteroProgress"
}
```

## 调试

- 数据存储在**父条目**（非附件）的 Extra 字段，选中父条目后可在 Info 面板查看 Extra 内容
- 打开 Zotero Error Console（Help → Debug Output Logging → View Output），搜索 `Zotero Progress` 查看插件日志
- 勾选章节后日志会打印更新后的 Extra 字段内容
