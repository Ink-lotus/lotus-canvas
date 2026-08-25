### What

Today an image generation task is bound to exactly one provider entry. This PR lets one logical image model be backed by several providers and dispatches a batch across them, respecting a per-provider concurrency limit.

Three commits, in dependency order:

**1. `feat(config)` — unified model alias and per-channel concurrency limit**

- `ChannelModel.alias` — an optional logical name. Providers exposing the same model under different identifiers share one alias; `resolveModelRequestConfig` still sends the provider's real `name`.
- `ModelChannel.maxConcurrency` — optional, defaults to 1, capped at 20.
- `AiConfig.imageModelTargets` — optional list of channel-qualified image models, plus `normalizeImageModelTargets` as the shared primitive.

**2. `feat(api)` — image generation scheduler with multi-channel dispatch**

- `scheduleImageGeneration(config, targets, run, options)` queues requests and keeps each provider inside its own limit.
- A job may pin a `preferredTarget`: it waits for that provider rather than jumping to a free one, so a single-image request still honours the user's default.
- Unpinned jobs pick the provider with the lowest load ratio, with a round-robin cursor breaking ties so parallel batches spread out.
- `fallbackOnError` retries the remaining providers after a real request failure, and gives up once every provider has been tried.

**3. `feat(image)` — select multiple providers sharing one model**

- `ImageModelTargetPicker` replaces `ModelPicker` in the image workbench: a multi-select grouped by alias, showing each provider's concurrency. Picking a provider from a different alias replaces the whole selection, so a task never mixes two models.
- The first image of a batch is pinned to the default provider; the rest go wherever capacity is free. A single-image task falls back to another provider on failure, a multi-image one does not — its slots already spread.
- `ImageChannelBadge` marks which provider produced each result. Hidden until hover or keyboard focus; clicking keeps every badge visible.
- History entries store `imageModelTargets`, and replaying one restores the provider selection instead of only the model.
- Changing the default image model in preferences rewrites the selection, so the workbench cannot keep calling the previous model's providers.

### Data model and compatibility

All three new fields are **optional**. Stored configurations load unchanged — `normalizeChannelModels`, `normalizeChannelConcurrency` and `normalizeImageModelTargets` fill the gaps in `persist.merge`.

`normalizeImageModelTargets` keeps only the targets sharing one alias and falls back to the primary model, so a stale or cross-model selection can never reach a request. Note the alias is taken from the first selected target rather than from the primary argument: callers that want to force one specific provider must pass it as the only target, not merely as the primary.

The selection lives on the config (global), not per node — there is no canvas-layer change in this PR.

### One behaviour change outside the feature

`imageToDataUrl` used to return `""` when a source could not be resolved, and `dataUrlToFile` turned that into a 0-byte upload — the request was still sent. With a scheduler in place that becomes one real request per provider for a single unreadable reference image. So it now raises `ImageReadError`, and `scheduleImageGeneration` rethrows that class without falling back.

Side effects worth a look:

- `canvas-resource-references` catches it to keep its per-reference message (behaviour unchanged).
- `services/api/image.ts` rethrows it so a local read failure is not relabelled as a request failure.
- `services/api/video.ts` and `canvas-node-generation.ts` now fail fast on an unreadable reference instead of silently sending an empty image. This looks like the better behaviour, but it is a change — happy to split it out or gate it if you would rather keep it separate.

### Not included

Canvas-layer wiring — per-node target selection, provider/model rows in the node info panel, the `showImageInfo` plumbing — is intentionally left out to keep this reviewable. It builds directly on the store and scheduler added here and can follow as a second PR.

### Verification

Rebased on `2b59a00`, so it merges cleanly.

```
cd web
npm run typecheck
npm run build
npx prettier --check --end-of-line auto src/components/image-model-target-picker.tsx src/components/image-channel-badge.tsx src/services/api/image-generation-scheduler.ts
```

`npm run build` passes. `npm run typecheck` reports one error, and it is pre-existing on `main` before this branch:

```
src/lib/canvas/canvas-generation-helpers.ts(51,47): error TS18048: 'node.metadata' is possibly 'undefined'.
```

`node.metadata` is not narrowed by the `!content` guard above it. Untouched here since it is unrelated — say the word and I will fix it separately. Each of the three commits was typechecked on its own and each reports only that same error.

Existing files were **not** reformatted: several already fail `prettier --check` on `main`, so only the three new files are prettier-clean. (If you run `prettier --check` on Windows with `core.autocrlf=true`, add `--end-of-line auto` or every file reports a violation.)

The en-US and zh-CN key sets were compared programmatically and match exactly.

### Manual checklist

There are no automated tests in `web/`. The behaviour below was exercised by hand against real providers in the fork this was extracted from; the extracted branch itself was verified by typecheck, build and a file-by-file review against that fork, **not** by re-running the app. So please treat this as a list to re-verify rather than as a passed suite:

- [ ] With a single provider selected, every image uses that provider.
- [ ] Single image, several providers selected: it waits for the default provider, then falls back by load after a real failure.
- [ ] Multiple images: the first goes to the default provider, the rest fill free capacity; a failing slot does not retry on another provider.
- [ ] Picking a provider from a different model replaces the whole selection instead of mixing models.
- [ ] The provider popover closes on outside click, and clicks inside it do not leak to the trigger.
- [ ] Changing the default image model in preferences immediately switches both the workbench selection and the provider actually called; switching only the default provider of the *same* model keeps the existing multi-provider selection.
- [ ] Result badges are hidden by default, appear on hover or keyboard focus, and stay pinned after a click — legible in both light and dark themes.
- [ ] A reference image whose local storage entry is gone reports one read failure and sends **no** request to any provider.
- [ ] Replaying a history entry restores the provider selection, not just the model.

### CHANGELOG

Added to `## Unreleased`:

```
+ [新增] 图片工作台支持在一次任务中选择多个提供同一模型的渠道，按各渠道并发上限共享调度，并在生成结果上标注实际使用的渠道。
+ [新增] 渠道模型支持设置统一模型名和最大并发数，允许不同渠道使用不同实际调用名时仍归入同一生图模型组。
+ [优化] 多渠道生图优先使用默认渠道，单图请求失败后按负载切换其余已勾选渠道；本地图片读取失败不再逐渠道重复发起真实请求。
```

### Open questions

- Is `alias` the right concept and name? It could live at the provider level instead, or be called something else (`logicalName`, `group`, …).
- Does `imageModelTargets` fit the naming conventions introduced by `aa3208d` (merging multiple text generations into a single node)?
- Should `maxConcurrency` apply to every capability rather than image tasks only?
