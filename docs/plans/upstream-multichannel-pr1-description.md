# PR 1 描述草稿（多渠道生图 · 配置层 + 调度层 + 图片工作台）

> 本地草稿，**未推送、未提 PR**。分支：`feature/multi-channel-image-generation`（worktree `../lotus-canvas-upstream-pr`，base `upstream/main` = `a4aaf24`）。
> 正文按上游 commit / 代码注释的语言习惯用英文书写，CHANGELOG 行沿用上游中文格式。

---

## Title

```
feat(image): allow one image model to be served by multiple providers
```

## Body

### What

Today an image generation task is bound to exactly one provider entry. This PR lets one logical
image model be backed by several providers and dispatches a batch across them, respecting a
per-provider concurrency limit.

Three commits, in dependency order:

1. `feat(config): add unified model alias and per-channel concurrency limit`
   - `ChannelModel.alias` — an optional logical name. Providers exposing the same model under
     different identifiers share one alias; `resolveModelRequestConfig` still sends the real `name`.
   - `ModelChannel.maxConcurrency` — optional, defaults to 1, capped at 20.
   - `AiConfig.imageModelTargets` — optional list of channel-qualified image models, plus
     `normalizeImageModelTargets` as the shared primitive.
2. `feat(api): add image generation scheduler with multi-channel dispatch`
   - `scheduleImageGeneration(config, targets, run, options)` queues requests and keeps each
     provider inside its own limit.
   - A job may pin a `preferredTarget`: it waits for that provider instead of jumping to a free
     one, so a single-image request still honours the user's default.
   - Unpinned jobs pick the lowest load ratio, with a round-robin cursor breaking ties.
   - `fallbackOnError` retries the remaining providers after a real request failure.
3. `feat(image): allow selecting multiple providers sharing one model`
   - `ImageModelTargetPicker` replaces `ModelPicker` in the image workbench: a multi-select
     grouped by alias, showing each provider's concurrency.
   - `ImageChannelBadge` marks which provider produced each result (hidden until hover/focus,
     click to keep visible).
   - History entries store `imageModelTargets` and restore the selection on replay.
   - Changing the default image model in preferences rewrites the selection.

### Data model / compatibility

- All three new fields are **optional**. Stored configurations load unchanged; `normalizeChannelModels`,
  `normalizeChannelConcurrency` and `normalizeImageModelTargets` fill the gaps in `persist.merge`.
- `normalizeImageModelTargets` keeps only targets sharing one alias and falls back to the primary
  model, so a stale or cross-model selection can never reach a request.
- Selection is stored per config (global), not per node — no canvas-layer change in this PR.

### One behaviour change outside the feature

`imageToDataUrl` used to return `""` when a source could not be resolved, and `dataUrlToFile`
turned that into a 0-byte upload — the request was still sent. With a scheduler in place that
becomes one real request per provider for a single missing reference image. So it now raises
`ImageReadError`, and `scheduleImageGeneration` rethrows that class without falling back.

Side effects worth reviewing:

- `canvas-resource-references` catches it to keep its per-reference message (unchanged behaviour).
- `services/api/image.ts` rethrows it so a local read failure is not relabelled as a request failure.
- `services/api/video.ts` and `canvas-node-generation.ts` now fail fast on an unreadable reference
  instead of silently sending an empty image. This looks like the better behaviour, but it is a
  change — happy to gate it behind a flag or split it out if you prefer.

### Not included

Canvas-layer wiring (per-node target selection, provider/model rows in the node info panel,
`showImageInfo` plumbing) is intentionally left out to keep this reviewable. It builds directly on
the store and scheduler added here and can follow as a second PR.

### Verification

```
cd web
npm run typecheck   # only the pre-existing src/lib/canvas/canvas-generation-helpers.ts(51,47) TS18048
npm run build       # ok
npx prettier --check src/components/image-model-target-picker.tsx src/components/image-channel-badge.tsx src/services/api/image-generation-scheduler.ts
```

`canvas-generation-helpers.ts(51,47)` already fails on `main` before this branch — `node.metadata`
is not narrowed by the `!content` guard. Untouched here; say the word and I will fix it separately.

Existing files were **not** reformatted (several do not pass `prettier --check` on `main`); only the
three new files are prettier-clean.

### Manual checklist

No automated tests in `web/`, so the behaviour was exercised by hand against real providers:

- [ ] With a single provider selected, every image uses that provider.
- [ ] Single image, several providers selected: it waits for the default provider, then falls back
      by load after a real failure.
- [ ] Multiple images: the first goes to the default provider, the rest fill free capacity; a
      failing slot does not retry on another provider.
- [ ] Picking a provider from a different model replaces the whole selection instead of mixing models.
- [ ] The provider popover closes on outside click, and clicks inside it do not leak to the trigger.
- [ ] Changing the default image model in preferences immediately switches the workbench selection
      and the provider actually called; switching only the default provider of the *same* model keeps
      the existing multi-provider selection.
- [ ] Result badges are hidden by default, appear on hover or keyboard focus, and stay pinned after a
      click — legible in both light and dark themes.
- [ ] A reference image whose local storage entry is gone reports one read failure and sends **no**
      request to any provider.
- [ ] Replaying a history entry restores the provider selection, not just the model.

### CHANGELOG

Added to `## Unreleased`:

```
+ [新增] 图片工作台支持在一次任务中选择多个提供同一模型的渠道，按各渠道并发上限共享调度，并在生成结果上标注实际使用的渠道。
+ [新增] 渠道模型支持设置统一模型名和最大并发数，允许不同渠道使用不同实际调用名时仍归入同一生图模型组。
+ [优化] 多渠道生图优先使用默认渠道，单图请求失败后按负载切换其余已勾选渠道；本地图片读取失败不再逐渠道重复发起真实请求。
```

### Open questions for the maintainer

- Is `alias` the right concept and name? It could also live at the provider level, or be called
  something else (`logicalName`, `group`, …).
- `imageModelTargets` naming: does it fit the conventions introduced by `aa3208d` (merging multiple
  text generations into a single node)?
- Should `maxConcurrency` apply to every capability rather than image tasks only?

---

## 剥离自检结果（本地记录，不进 PR 正文）

| 检查 | 结果 |
| --- | --- |
| `git merge-base --is-ancestor upstream/main main` | 0（前置条件满足） |
| 桌面端痕迹 grep（`lotusDesktop` / `__lotus_media__` / `X-Lotus-` / `isDesktopMediaLibrary` / `DesktopMediaActions` / `desktop-media-storage` / `lotus-canvas` …） | 无命中 |
| `git diff upstream/main...HEAD --name-only` | 13 个 `web/src` 文件 + `CHANGELOG.md`；无 `desktop/**`、`.github/workflows/desktop-*.yml`、`VERSION`、`pending-test*`、`docs/plans/**` |
| `git diff HEAD..main`（残余差异） | 逐文件核对为 B（桌面端）+ C（无关私有功能）+ PR2 画布层 + 3 处刻意偏离 |
| 3 个提交逐个 typecheck | 各自仅剩上游既有的 1 个错误 |
| `npm run build` | 通过 |
| i18n en/zh key 对齐 | 1584 / 1584，无缺失；A 类新 key 齐备；B/C key 未泄漏 |

三处相对 fork `main` 的刻意偏离：

1. `maxConcurrency` / `imageModelTargets` 由必填改为可选（计划 §6-2），连带 `agent-site-tools.ts`
   与 `app-config-modal.tsx` 各一处改为可选访问。
2. scheduler 两处中文硬编码错误改走 `apiErrors.noImageChannel`（计划 §6-1）。
3. `image-model-target-picker.tsx` 一处 JSX 换行改为 prettier 期望格式。
