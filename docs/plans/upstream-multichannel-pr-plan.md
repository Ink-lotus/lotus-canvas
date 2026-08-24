# 多渠道生图能力上游 PR 剥离计划

> 目标仓库：`basketikun/infinite-canvas`（upstream）
> **前置条件**：fork `main` 已合并 `upstream/main`（`d536618` 或更新）。截至本文编写时合并尚未执行，以下所有步骤都建立在该前置条件之上。
> 校验前置条件：`git merge-base --is-ancestor upstream/main main`（退出码 0 即已同步）
> 编写日期：2026-08-24
> **行号说明**：文中行号取自合并前的 fork `b8fbc4c`，合并后会整体偏移，仅作定位参照——开工前按 §11 刷新。

## 0. 结论摘要

合并完成后，剥离由**双变量降为单变量**：多渠道代码已在合并中适配上游新结构（reference bar、分组节点输入、多文本合并单节点），PR 分支的 base 与 fork `main` 的上游侧完全一致，**不存在上游演进冲突**。剩下的唯一工作是从 `main` 摘出 A 类改动、剔掉 B（桌面端）与 C（无关私有功能）。

两条关键结论：

1. **不要 cherry-pick fork 的历史提交**。`40e09e5 feat: add desktop media library and multi-channel generation` 把桌面媒体库与多渠道混在同一个 33 文件提交里，且合并后代码形态已与当时不同——应以合并后的 `main` 为唯一取用源。
2. **9 个纯 A 文件可整文件 `git checkout main -- <path>`**，只有 9 个混合文件需要逐 hunk 甄别（见 §3）。这是合并带来的最大简化。

## 1. 现状盘点

### 基线

| 项 | 值 |
| --- | --- |
| 上游侧基线 | `upstream/main` = `d536618`（2026-08-24） |
| 合并前分叉点 | `9414048`（2026-08-18，由 `83dbe03` 引入） |
| 合并前 fork HEAD | `b8fbc4c` |
| 合并后取用源 | fork `main`（含 merge commit） |

### 多渠道相关的 7 个 fork 提交（归属判断依据）

| 提交 | 主题 | 处理 |
| --- | --- | --- |
| `40e09e5` | 桌面媒体库 + 多渠道（混合，33 文件） | 仅取多渠道部分 |
| `88308bb` | 渠道弹层交互修复 | 全取 |
| `b67de06` | 调度优先级与失败切换 | 全取 |
| `8a3ef8e` | 生图结果渠道角标 | 全取 |
| `850b2c8` | 统一模型名 alias | 全取 |
| `71a3de0` | 4 处 TypeScript 修复 | 按文件甄别（含桌面端部分） |
| `a1d8864` | 勾选继承 + 默认模型联动 | 全取 |

必须排除的 fork 提交：所有桌面端相关（`e1c165f`、`822eda1`、`dfdc046`、`16d9505`、`0813e8f`、`9580155`、`61da473` 等）、`3d8e013`（资产与引用名称）、`dea1331`（默认反推提示词）、`657af42`（移除图片下载按钮，是为桌面端 `DesktopMediaActions` 让位）。

复核单个文件的归属：`git log --oneline upstream/main..main -- <path>`。

### 文件分类

以 `git diff --numstat upstream/main..main -- web/src` 为准。合并前的规模为 37 个文件，分三类。

**A-纯：可整文件取用（9 个）**

| 文件 | 说明 |
| --- | --- |
| `components/image-model-target-picker.tsx` | 新增，101 行 |
| `services/api/image-generation-scheduler.ts` | 新增，151 行 |
| `components/image-channel-badge.tsx` | 新增，39 行 |
| `components/layout/channel-editor-drawer.tsx` | alias + 最大并发输入 |
| `components/canvas/canvas-config-node-panel.tsx` | 换 picker + `buildNodeConfig` |
| `components/canvas/canvas-node-prompt-panel.tsx` | 同上（含上游 +8/−1） |
| `lib/canvas/canvas-node-factory.ts` | 单行 `imageModelTargets` |
| `lib/agent/agent-site-tools.ts` | 4 处 |
| `types/canvas.ts` | 2 行（含上游 +9） |

**A-混合：需逐 hunk 甄别（9 个）**

| 文件 | 混入类别 |
| --- | --- |
| `stores/use-config-store.ts` | A + C |
| `components/layout/app-config-modal.tsx` | A + C |
| `components/canvas/canvas-node-hover-toolbar.tsx` | A + B 各半 |
| `components/canvas/canvas-node.tsx` | A + B |
| `lib/canvas/canvas-generation-helpers.ts` | A + C |
| `pages/canvas/project.tsx` | A + B + C |
| `pages/image/index.tsx` | A + B 深度交织（同 hunk 内） |
| `i18n/locales/zh-CN.ts` | A + B + C，按 key 切 |
| `i18n/locales/en-US.ts` | 同上 |

**B 类 — 排除（14 个）**：`components/desktop-media-actions.tsx`、`services/desktop-media-storage.ts`、`services/file-storage.ts`、`services/image-storage.ts`、`components/layout/config-local-storage.tsx`、`components/layout/version-release-modal.tsx`、`hooks/use-version-check.ts`、`constant/env.ts`、`vite-env.d.ts`、`pages/assets/index.tsx`、`pages/video/index.tsx`、`components/agent/local-agent-panel.tsx`、`services/api/audio.ts`、`services/api/video.ts`。

**C 类 — 排除（5 个）**：`canvas-config-composer.tsx`、`canvas-prompt-chip-input.tsx`、`canvas-resource-mention-textarea.tsx`、`canvas-side-panel.tsx`、`services/config-file.ts`。

### 冲突面

**合并后为 0。** PR 分支 base 与 `main` 的上游侧一致，原先 fork 与 upstream 同时改动的 6 个文件（`project.tsx`、`canvas-node.tsx`、`canvas-node-prompt-panel.tsx`、`canvas-generation-helpers.ts`、`types/canvas.ts`、`i18n/locales/*`）已在合并中解决。

## 2. 分支准备

用 worktree 隔离，避免污染 `main`（纯本地操作）：

```powershell
git fetch upstream
git worktree add ../lotus-canvas-upstream-pr -b feature/multi-channel-image-generation upstream/main
```

取用源统一为本地 `main`：整文件用 `git checkout main -- <path>`，逐 hunk 参照 `git diff upstream/main..main -- <path>` 与 `git show main:<path>`。

## 3. 移植清单

### 第一步：9 个纯 A 文件整文件取用

先逐个复核确实无 B/C 痕迹（合并可能引入新交织）：

```powershell
$pureA = @(
  "web/src/components/image-model-target-picker.tsx",
  "web/src/services/api/image-generation-scheduler.ts",
  "web/src/components/image-channel-badge.tsx",
  "web/src/components/layout/channel-editor-drawer.tsx",
  "web/src/components/canvas/canvas-config-node-panel.tsx",
  "web/src/components/canvas/canvas-node-prompt-panel.tsx",
  "web/src/lib/canvas/canvas-node-factory.ts",
  "web/src/lib/agent/agent-site-tools.ts",
  "web/src/types/canvas.ts"
)
foreach ($f in $pureA) { "=== $f ==="; git --no-pager diff upstream/main..main -- $f }
git checkout main -- $pureA
```

这些文件在 `main` 里已是「上游最新 + A」形态，PR 分支 base 也含上游最新，因此直接取用即正确。

### 第二步：9 个混合文件逐 hunk

行号为合并前参照，按 §11 刷新后使用。

**`stores/use-config-store.ts`（数据模型基座，先做）**

- 取：`:15-16` `ChannelModel.alias?`；`:27` `ModelChannel.maxConcurrency`；`:39` `AiConfig.imageModelTargets`；`:89`/`:100` 默认值；`:138` `setImageModelTargets` 签名；`:164-169` `findChannelModel` 支持 alias 反查；`:220-224` `setImageModelTargets`；`:248`/`:258-259` merge 归一化；`:292-297` `normalizeChannelModels` 带 alias；`:333-352` `modelOptionAlias`/`modelOptionLabel`/`modelOptionChannelName`；`:363-370` `normalizeModelOptionValue` alias 回退；`:378-389` `resolveModelRequestConfig` 用 alias 反查真实模型名；`:392-409` `normalizeImageModelTargets`；`:411-413` `normalizeChannelConcurrency`。
- **剔除 C**：`:52` `reversePrompt`、`:75` `DEFAULT_REVERSE_PROMPT`、`:113`、`:272`。

**`app-config-modal.tsx`**

取 `:16` import、`:62` `setImageModelTargets` selector、`:200` 渠道行并发展示、`:224-233` ModelPicker onChange 联动、`:382-386` `withChannels` 返回 `imageModelTargets`。**剔除 C** `:271-273` `preferences.reversePrompt` 表单项。

**`canvas-node-hover-toolbar.tsx`**

只取 `:12` import、`:222-227` 取 config/channels 与 `imageModel`/`imageChannel`、`:274-283` InfoRow 渠道/模型/逐张 `imageIndex`。**剔除 B**：`:10` `DesktopMediaActions` import、`:118-119` `primaryBatchImage`/`mediaStorageKey`、`:199` 工具栏挂载。

**`canvas-node.tsx`**

只取 `:16` 及 `showImageInfo`/`onShowImageInfoChange` 全链路（`:674`、`:688`、`:712`、`:764`）与角标渲染。**剔除 B**：`:15`/`:753` `DesktopMediaActions`；**不要复现 `657af42`**——上游的图片下载按钮必须原样保留。

**`canvas-generation-helpers.ts`**

只取 `:1` import 与 `:95-100` `buildGenerationConfig` 注入。**剔除 C**：`:46-57` `hydrateCanvasImages` 的局部变量重构。

**`pages/canvas/project.tsx`（最重）**

- 取 A：`:9`/`:12` imports；`:186-198` `lastImageTargetsRef` + `nextImageModelTargets` + `nextImageConfigMetadata`；`:521-527`/`:541`、`:689-697`/`:715`、`:2630` 新建节点带 targets；`:1046` `handleNodeSelectCapture` 忽略 `.ant-popover`；`:1498`、`:1528-1529`、`:1547` 记住本画布勾选；`:1709`/`:2449` 多目标就绪校验；`:2049-2061`、`:2181-2193`/`:2212`、`:2525-2537`/`:2550`/`:2555-2556` 三处生成/批量/重试改走 scheduler；`:2882`/`:2984` `onShowImageInfoChange`。
- **剔除 B**：九处 `uploadImage(…, { origin: "generated" })` 的 `origin` 参数（`:1645`、`:1679`、`:1739`、`:1759`、`:1821`、`:2059`、`:2191`、`:2539`、`:2651`）——上游签名是 `uploadImage(blob)`；以及 `downloadBatchImage` 的删除与 `onDownloadBatchImage` 移除，必须保留上游原逻辑。
- **剔除 C**：`:1613-1615`/`:1639` `effectiveConfig.reversePrompt`。
- 合并已把 scheduler 的三处包裹点落到上游新结构（reference bar、分组节点输入、多文本合并单节点）中，直接照搬 `main` 的形态，不需要再推断插入点。

**`pages/image/index.tsx`（A/B 同 hunk 交织，逐行摘）**

- 取 A：`:9`/`:10`/`:16`/`:21` imports；`:38` `GeneratedImage.model`；`:68` `GenerationLogConfig.imageModelTargets`；`:104` `channelLabelsPinned`；`:112-113`；`:324-325` 日志回放；`:337-343` snapshot 加 `targets`/`outputCount` 与就绪校验；`:349-360` `scheduleImageGeneration`；`:519`/`:582`/`:602` 换 `ImageModelTargetPicker`；`:541`/`:614`/`:622`/`:634` `ImageChannelBadge`；`:893` `model: item.model || …`。
- **剔除 B**：`:11`/`:22` imports、`:629` `isDesktopMediaLibrary()` 文案切换、`:645` `<DesktopMediaActions>`、`:88`/`:296`/`:303` 的 `cleanupImages`（须回退为上游 `deleteStoredImages`）、`:202`/`:207-208`/`:255`/`:263`/`:379` 的 `origin: "generated"`。

## 4. i18n key 取舍

zh-CN.ts 与 en-US.ts 结构一致。**只取 A 的 key**：

- 新增：`imageChannelPicker.summary/.concurrency/.empty`、`imageChannelBadge.showAlways/.autoHide`、`config.channels.concurrency`、`config.channelEditor.maxConcurrency/.maxConcurrencyDescription`、`config.channelEditor.alias/.aliasPlaceholder`、`canvas.nodeToolbar.channel/.model/.imageIndex/.imageIndexPrimary`（后者需在上游同一长单行内**行内追加**）。
- 文案改写（非新增）：`config.channels.description`、`config.channelEditor.modelDescription`。
- **剔除**：`common.exportCopy/.showInFolder/.copyPath/.pathCopied/.fileActions/.mediaActionFailed`（B）、`config.localStorage.library.*`（B，单行对象）、`version.installNow/…`（B）、`config.preferences.reversePrompt*`（C）。
- 需要行内局部编辑的只有 `canvas.nodeToolbar.*`（A）和 `config.localStorage.library`（B）两处单行对象，互不污染——A 只碰前者。

## 5. 剥离自检

fork 内共 4 个桌面检测入口，PR 分支上一个都不能出现：

1. `window.location.protocol === "app:"`（`services/desktop-media-storage.ts` 的 `isDesktopMediaLibrary()`）
2. 编译期常量 `__DESKTOP_BUILD__` / `IS_DESKTOP_BUILD`（`vite-env.d.ts`、`constant/env.ts`，仅 `use-version-check.ts` 使用）
3. preload 全局 `window.lotusDesktop`（`LotusDesktopApi`）
4. 本地路由前缀 `/__lotus_media__` 与 `X-Lotus-File-Name` / `X-Lotus-Media-Origin` 请求头

三条校验命令：

```powershell
# 1) 正向：PR 分支不含任何桌面端痕迹（应无命中）
git --no-pager grep -n -i -e "lotusDesktop" -e "__DESKTOP_BUILD__" -e "IS_DESKTOP_BUILD" -e "__lotus_media__" -e "X-Lotus-" -e "isDesktopMediaLibrary" -e "DesktopMediaActions" -e "desktop-media-storage" -e "lotus-canvas" -- web/src

# 2) 范围：PR 只动 A 类文件（应只列出 §1 的 9 + 9 个文件）
git --no-pager diff upstream/main...HEAD --name-only

# 3) 反向：PR 分支与 main 的差异应恰好等于 B + C 的集合
git --no-pager diff HEAD..main --stat -- web/src
```

第 3 条是最强的校验：结果应只包含 B 类 14 个文件、C 类 5 个文件，以及 9 个混合文件中被剔除的部分；若出现纯 A 文件，说明抄漏了。

同时确认 PR 不含 `desktop/**`、`.github/workflows/desktop-*.yml`、`VERSION`、`docs/content/docs/progress/pending-test*.mdx`、`docs/plans/**`。

## 6. 提 PR 前的必修项

1. **scheduler 中文硬编码**：`image-generation-scheduler.ts` 中两处 `"没有可用的图片生成渠道"` 未接 i18n。上游默认英文，需改为可翻译或英文错误信息。
2. **必填字段兼容性**：`ModelChannel.maxConcurrency` 与 `AiConfig.imageModelTargets` 在 fork 里是**必填**，靠 `persist` 的 `merge` + `normalize*` 兜旧配置。提 PR 时建议改为可选，降低上游存量配置风险与 review 阻力。
3. **prettier**：fork 现存文件本身 `prettier --check` 就不通过（历史遗留）。只按上游现有风格写新增行，**不要**跑 `prettier --write` 造成大面积无关格式变更；3 个新文件应能通过检查。
4. **`GeneratedImage.model` 落地**：上游 `d536618` 改了 `services/api/image.ts` + `image-storage.ts` 的临时 URL 持久化。合并时应已处理，PR 前复核实际渠道名写入结果记录的路径仍成立。

## 7. PR 拆分

**首个 PR 不碰画布层**，收「配置层 + 调度层 + 图片工作台」：`use-config-store.ts`、`channel-editor-drawer.tsx`、`app-config-modal.tsx`、`image-model-target-picker.tsx`、`image-generation-scheduler.ts`、`pages/image/index.tsx`、`agent-site-tools.ts`、i18n。

理由：体积可控、避开 A/B 交织最重的 `project.tsx`（九处 `origin` 参数 + `downloadBatchImage`），且基础层进入上游后，第二个 PR 的画布改动可以直接建立在上游已有的 store/scheduler 之上。

内部拆为 3 个原子提交：

1. `feat(config): add unified model alias and per-channel concurrency limit` — store + channel-editor
2. `feat(api): add image generation scheduler with multi-channel dispatch` — scheduler（含 i18n 错误文案）
3. `feat(image): allow selecting multiple channels sharing one model` — picker + `pages/image` + app-config-modal 联动 + agent 工具

第二个 PR（画布层，待首个合并后）：types/factory/helpers/两个面板/`project.tsx` + `image-channel-badge.tsx` + `canvas-node.tsx`/hover-toolbar 的 `showImageInfo` 链路。

CHANGELOG 可加 2~3 行（沿用上游 `## Unreleased` 格式），`pending-test` 不带。

## 8. 验证方案

功能行为已在 fork 合并后的环境里实际运行验证过（真实渠道配置 + 桌面端），PR 分支只需确认剥离没有破坏自洽性：

```powershell
cd web
npm run typecheck
npm run build
npx prettier --check src/components/image-model-target-picker.tsx src/components/image-channel-badge.tsx src/services/api/image-generation-scheduler.ts
```

`web/` 无测试框架也无 lint 脚本。PR 描述里附手工清单（取自 `pending-test.zh-CN.mdx` 第 64/65/66 条，去掉桌面端字样）便于上游作者复验：

- 仅勾选一个渠道时始终使用该渠道；
- 多渠道单图先等默认渠道，失败后按负载逐个回退；
- 多图首个任务给默认渠道、其余按可用容量分配，单个多图任务失败不跨渠道重试；
- 渠道弹层点击不穿透到下方图片/文本节点，点击外部关闭；
- 偏好设置切换默认生图模型后，画布弹层、实际请求渠道与图片工作台立即改用新模型的渠道；只换同一模型的默认渠道时保留原多渠道勾选；
- 同一画布内新建生成配置/图片节点沿用最近一次勾选，刷新后回落到全局勾选；
- 渠道角标默认隐藏、悬停或聚焦显示、点击切换常驻，浅色与深色主题均清晰。

## 9. 风险与待上游确认

- 上游是否接受 `alias`（统一模型名）这一概念及命名，可能希望放在渠道级或改名。
- 上游 `aa3208d`（多文本生成合并为单节点）与 fork 的多图节点语义相近，`imageModelTargets` 命名需与上游既有约定对齐。
- 剔除 B 后代码必须仍自洽：`uploadImage`/`deleteStoredImages` 签名要回退到上游形态，`canvas-node.tsx` 的下载按钮要恢复——这两处是最容易留下编译期通过、运行时行为缺失的地方。
- 上游无自动化测试，回归只能靠人工，故 §8 手工清单要随 PR 提交。
- 向 `origin` 推送分支、在 upstream 开 PR 属于改变远程状态的操作，执行前需单独授权。

## 10. Task List

1. 校验前置条件：`git merge-base --is-ancestor upstream/main main`
2. 按 §11 刷新行号与文件清单
3. 建 worktree 分支（§2）
4. 复核并整文件取用 9 个纯 A 文件（§3 第一步）→ typecheck
5. 逐 hunk 移植 `use-config-store.ts`（剔 C）→ typecheck
6. 逐 hunk 移植 `app-config-modal.tsx`（剔 C）→ typecheck
7. 合入 A 类 i18n key（含 `canvas.nodeToolbar.*` 行内追加）
8. scheduler 错误文案接 i18n（§6 第 1 条）
9. 逐行移植 `pages/image/index.tsx`（剔 B）→ typecheck + build
10. 跑 §5 三条自检 + §8 验证
11. 按 §7 重排为 3 个原子提交，写 PR 描述（附手工清单与数据模型说明）
12. 请求授权 → 推分支 → 开首个 PR
13. 首个 PR 合并后，按同样流程处理画布层（`canvas-generation-helpers.ts`、`canvas-node-hover-toolbar.tsx`、`canvas-node.tsx`、`project.tsx`）

## 11. 开工前刷新数据

合并会改变全部行号，且可能引入新的 A/B 交织。开工前重跑：

```powershell
# 文件清单与规模（复核三分类是否仍然成立）
git --no-pager diff --numstat upstream/main..main -- web/src

# 逐文件归属提交
git --no-pager diff --name-only upstream/main..main -- web/src | ForEach-Object { "=== $_ ==="; git --no-pager log --oneline upstream/main..main -- $_ }

# 混合文件的完整 diff（据此重新标注 §3 的取/剔行号）
git --no-pager diff upstream/main..main -- web/src/stores/use-config-store.ts web/src/components/layout/app-config-modal.tsx web/src/components/canvas/canvas-node-hover-toolbar.tsx web/src/components/canvas/canvas-node.tsx web/src/lib/canvas/canvas-generation-helpers.ts web/src/pages/canvas/project.tsx web/src/pages/image/index.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
```

分类结论（A/B/C 归属、9+9 的文件划分、剥离策略、PR 拆分）不随行号变化；若第 1 条命令显示文件数与 37 差异较大，说明合并期间引入了新改动，需要重新甄别。





