# 合并 upstream/main (d536618) 的遗留待办与验收清单

合并提交：`c0a8379`（`main`，尚未推送）。基线：`upstream/main` = `d536618`。

## 待办 1：三处生图入口未纳入 `scheduleImageGeneration`

这三处直接调用 `requestGeneration` / `requestEdit`，绕过渠道调度，因此不受 `maxConcurrency` 限制、
不参与多渠道轮询、失败时不回退到其他渠道：

- `web/src/pages/canvas/project.tsx:1816` — `maskEditImageNode`（局部重绘）
- `web/src/pages/canvas/project.tsx:1891` — `generateAngleNode`（多角度）
- `web/src/pages/canvas/hooks/use-plugin-host.tsx:56` — 插件 `generateImage` 桥

本次合并按「保持现状」处理：上游没有新增生图入口，这三处的行为与合并前一致，属于既有欠账而非
本次回归。纳管时注意 `maskEditImageNode` 需要把 mask 一起带进 `run` 闭包，且 hydrate 类操作要
留在闭包外，避免每个渠道重复执行。

## 待办 2：派生图片节点重试/多角度会落回全局渠道集合

`cropImageNode`（`project.tsx:1753`）、`splitImageNode`、放大、以及上游新增的 `captureVideoNodeFrame`
产出的都是**已带内容**的派生图片节点，它们统一不写 `imageModelTargets`（只有 `createConnectedNode`
产出的**空**图片节点和 Config 节点会写）。后果是从这类节点再次发起生成时，取不到父节点的渠道勾选，
只能回落到全局配置。

本次合并保持上游 `captureVideoNodeFrame` 原样（含 `origin` 仍为默认 `external`），以便与其真正的
同类保持一致；如要修，应当把这一类节点作为整体一起改，而不是只改抽帧一处。

## 合并后人工验收清单

在 `desktop/release/lotus-canvas-0.1.2-win-x64.exe`（或便携版）上跑，可同时覆盖 B 类桌面端路径。

前置条件：AI 设置里至少配 **2 个图片渠道**且模型不同（多渠道相关项全靠它）；把其中一个渠道的
`maxConcurrency` 设为 1 便于观察排队；画布工具栏的「图片信息」开关对应 `showImageInfo`，
它同时控制渠道角标常驻与 `ImageInfoBar`。

### P0 必测（每项都在验证一处冲突解决）

- [x] **1. 插件内置面板生图 + 组输入 + 多渠道** —— 验证 `project.tsx:2142` 的三方融合

  前置：需已安装声明 `useBuiltinPanel: { mode: "image", writeBackToSelf: true }` 的插件；
  仓库不含本地插件，用插件管理里的官方源或 install from URL。没有则记 N/A。
  操作：创建该插件节点 → 连入一个**组节点**作为输入 → 勾选 ≥2 渠道 → 生成。
  通过：prompt 里带上 `promptPrefix`，组内资源都进了参考图；请求分摊到多个渠道；
  结果写回**该节点自身**；落库图片 `origin` 为 `generated`。
  失败指向：只用到一张图/丢组内容 = hydrate 侧坏了；只发一个渠道 = 调度器被丢；
  同一批里 hydrate 重复执行 = `hydrateNodeGenerationContext` 被误挪进 `run` 闭包。

- [x] **2. 渠道角标在无边框卡片上** —— 验证 `canvas-node.tsx` 的 `group/channel` 保留

  操作：多渠道批量出图 → 展开批次 → 鼠标划过单张卡片 → 再开关工具栏「图片信息」→ 切深浅主题。
  通过：hover 时角标出现、移开消失；开「图片信息」后角标常驻（`channelLabelsPinned`）；
  上游把 `ExpandedImageCard` 改成无 border/shadow 后，角标文字在两种主题下都可读。
  失败指向：hover 完全不显 = `group/channel` 宿主类名丢失。

- [x] **3. 多文本生成合并为单节点** —— 验证 `canvas-node.tsx:456` 的收窄未被回退

  这里说的「多文本」是**一次文本生成产出 N 条候选**，不是多个文本节点、也不是文本生图。
  前置：在文本生成面板的设置浮层里把「生成次数」设为 ≥2 —— 普通节点见
  `canvas-node-prompt-panel.tsx:125`，Config 节点见 `canvas-config-node-panel.tsx:115`，
  两处都写入 `metadata.textCount`。
  操作：选文本模型生成 → 看产出节点 → 展开看各条 → 「设为主文本」→ 节点级重试。
  通过：产出**一个**文本节点内含 N 条（`metadata.texts`，见 `project.tsx:2454-2477`），
  不是 N 个节点、也不是图片节点；展开后每条可见；设主文本生效；重试重跑整批（`project.tsx:2889`）。
  失败指向：节点被错误路由进 `ImageNodeContent` —— 表现为**裂图**（`<img src="正文文本">`），
  正文为空时则卡在「生成中」转圈，**不是**空图片占位。
  注意：文本批次**没有**单条重试/删除，只有展开/收起与「设为主文本」，不要按图片批次的操作去核。

- [x] **4. 组节点 + 多渠道批量生成** —— 验证上游 `getInputSummary` 去重与实际请求数一致

  操作：组内放多个重复/同源资源 → 作为输入 → 勾选 ≥2 渠道 → 生成。
  通过：面板上显示的输入摘要条数与真正发出的请求数、产出图片数对得上，没有少算或重复计。
  已核实（2026-08-24，非缺陷）：全链路去重一律按 **节点 id**（`canvas-node-generation.ts:142`、
  `canvas-resource-references.ts:94`），从不按内容或 `storageKey`。所以同一张图复制成多个节点后编组，
  @ 候选与参考内容都会列成多条。另外两条路径对组的处理**故意不同**：生成用的
  `buildNodeGenerationInputs`（`canvas-node-generation.ts:131-137`）把组保留成 1 条
  `type: "group"` 带 children；@ 提及用的 `buildNodeMentionReferences` 走
  `expandGroupResourceNodes` 把组**摊平**成成员资源。摘要计数取自摊平去重后的
  `referenceImages.length`（`:124`），与实际发出的参考图数一致。

- [x] **5. 渠道多选浮层与参考内容栏共存** —— `canvas-node-prompt-panel.tsx`

  操作：打开节点生成面板 → 展开渠道多选浮层 → 在浮层张开时点参考内容栏的预览/移除。
  通过：浮层层级在参考栏之上、不被裁切；点击不穿透到画布（不触发平移/选中）；关闭后参考栏可正常操作。

### P1 应测

- [x] **6. 视频抽帧** —— 右键视频节点 →「截取首帧 / 尾帧 / 当前帧」（`canvas-context-menu.tsx:33`）

  通过：生成图片节点并提示「已生成图片节点」。
  已知现状（按决定保留，非缺陷）：该图 `origin` 为默认 `external`，且不带 `imageModelTargets`，
  所以从它再发起生成会回落到全局渠道配置 —— 对应上面的待办 2。

- [x] **7. 临时图片 URL 持久化**（上游 #206）—— 生成/导入图片 → 关工程 → 重开。

  通过：图片仍能显示，不出现裂图。

- [x] **8. GPT Image 渠道**（上游 #197）—— 用 gpt-image 系模型出图。

  通过：正常返回；上游已对该系模型省略 `response_format`。

- [x] **9. 本地读取失败不再被放大** —— 验证本次新增的 `ImageReadError`

  前置（关键）：**生成数量必须为 1**。`fallbackOnError` 只在单张生成时为 true
  （`project.tsx:2291`、`:2688`、`image/index.tsx:356`）；数量 ≥2 时每张图本来就是独立 job，
  由调度器分摊到各渠道，「发到多个渠道」是设计行为，不是本项要抓的放大。
  操作：桌面版下，让某张参考图的底层媒体文件失效（从媒体库目录移走）→ 关掉再打开工程（清掉
  `objectUrls` 内存缓存，走冷缓存路径）→ 用它当参考图 → 勾选 ≥2 渠道 → 生成数量填 1 → 生成。
  通过：**只失败一次**并立刻报错「读取图片失败」，不逐个渠道各发一次真实请求；生成日志里只有 1 条。
  失败指向：出现 N 条失败/N 次请求，且文案是 HTTP 状态码或接口返回的消息 = 某条路径没有归类成
  `ImageReadError`。

  首轮人工复核**未通过**，已定位并补修（2026-08-24）。合并时只覆盖了热缓存路径，漏了两条：
  1. 冷缓存下 `resolveImageUrl` 会先探 `hasDesktopMedia`，而索引仍有记录、磁盘文件已丢时桌面端
     媒体路由返回的是 **500 而不是 404**（`desktop/src/media-protocol.js:63` 的 `fsp.stat` 抛
     ENOENT，`:55` 的 catch 只映射了 INVALID_KEY/INVALID_BODY/EMPTY_BODY/INVALID_ORIGIN→400 与
     KEY_CONFLICT→409），于是 `desktop-media-storage.ts:64` 抛出**普通 `Error`**，被调度器当成渠道
     故障、触发逐渠道重试。现改为探测失败即视为「本地不可用」。
  2. 取不到 URL 时 `imageToDataUrl` 原来**静默返回 `""`**，`dataUrlToFile` 把它变成 0 字节 File，
     真实请求照发。现改为抛 `ImageReadError`。

  补修后在重新打包的 0.1.2 桌面版上复测通过。

- [x] **10. @ 提及候选列表** —— `canvas-config-composer.tsx` 冲突

  操作：在配置节点输入框打 `@` → 看候选 → 选一个组节点 → 选一个图片节点。
  通过：主行显示标题、超长截断；副行对组节点显示「N 个节点」，对其他显示文本摘要；插入后成 chip。

- [x] **11. 参考内容栏本身**（上游新功能）—— 预览、移除、点选连线；组引用能展开看到全部内容。

- [x] **12. 无重复下载按钮** —— 批次图片卡片上只有一套操作，没有上游回归回来的下载按钮。

### P2 桌面端专项

- [x] **13. 生成图落库 `origin: "generated"`**，媒体库清理不会误删仍被引用的图。

  `origin` 决定媒体库里的**落盘子目录**：`<媒体库根>/generated/images/YYYY-MM/…` 对
  `<媒体库根>/external/images/…`（`desktop/src/media-library.js:247`），秒传去重也按
  `origin + kind + sha256` 分桶（`:236`）。根目录在设置 →「本地存储」的媒体库分区里显示，
  旁边有「打开」按钮（`config-local-storage.tsx:110`）。
  验证 origin：生成一张图 → 打开媒体库目录 → 应落在 `generated/images/` 下；导入一张图 →
  应落在 `external/images/` 下。
  验证清理：清理**不看 `origin`**，只按 `storageKey` 可达性（`image-storage.ts:102`、
  `file-storage.ts:68`），入口有 5 个，都是延迟到下一个 tick 静默执行、没有 UI 提示：
  删除工程（`canvas-delete-projects-dialog.tsx:17`、`project.tsx:1040`）、删除节点
  （`project.tsx:774`）、清空画布（`project.tsx:844`）、图片/视频页删除素材
  （`use-asset-store.ts:81-86`）。想主动触发就删一个**不相关**的节点，然后确认仍被引用的图还在。
- [x] **14. 更新检查**显示当前版本 0.1.2（`__DESKTOP_BUILD__` 已在本次打包中生效）。

## 已知需要修正的旧文档

`docs/plans/upstream-multichannel-pr-plan.md`：

- §6 第 4 项前提有误——`uploadImage` 在 `web/src/services/image-storage.ts`，不在
`web/src/services/api/image.ts`；fork 从分叉点至今未改过 `services/api/image.ts`
（本次合并新增了 3 行 `ImageReadError` 相关改动，是该文件的首次分叉）。
- §11 的行号全部是合并前的，需按 `c0a8379` 重新取。

