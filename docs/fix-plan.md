# 修复工单：多渠道生图改动问题清单

本文档是 `docs/review-findings.md`（审查报告）的配套**修复工单**，供 Codex 直接执行。范围对应提交 `8bb920c..025dc47`（5 个提交），共 15 条问题。

- **必须修**：#1、#2、#9、#12、#6 —— 用户可感知的功能失效或数据错误。
- **建议修**：#3、#4、#7、#10、#11、#13、#14 —— 静默失效或状态卡死类。
- **可斟酌**：#8、#15 —— UI 重叠 / 疑似误删样式。

行号以当前 `main`（`025dc47`）为准，执行时如行号漂移请按代码内容定位。

---

## #1 日志复现功能失效（必须修）

**文件**：`web/src/pages/image/index.tsx:325-336`（写入方），读取方 `108-114`，移动端摘要 `513-515`

**现状**：`previewGenerationLog` 恢复历史日志时把参数写回**全局 store**：

```tsx
// 331-334
setImageModelTargets(log.config.imageModelTargets || [log.config.model || log.model]);
if (log.config.quality) updateConfig("quality", log.config.quality);
if (log.config.size) updateConfig("size", log.config.size);
if (log.config.count) updateConfig("count", log.config.count);
```

但生成参数读的是 mount 时固化的 **local state**（`108-111` 的 `useState` 初始化，`createSession`（293-306）不重置它们）：

```tsx
// 107-111
const [localModelTargets, setLocalModelTargets] = useState<string[]>(() => resolveImageModelTargets(effectiveConfig));
const [localQuality, setLocalQuality] = useState(effectiveConfig.quality);
const [localSize, setLocalSize] = useState(effectiveConfig.size);
const [localCount, setLocalCount] = useState(effectiveConfig.count);
```

点"复现"后 prompt/参考图恢复，但模型、质量、尺寸、数量全部不生效。且移动端摘要条（513-515）读 store 显示新值、桌面面板（523-532）显示 local 旧值，两处 UI 自相矛盾。

**预期行为**：点"复现"后，本次会话的生成参数（模型多选、质量、尺寸、数量）与日志记录一致。

**修复方案**：`previewGenerationLog` 改写 local state 而非 store：

```tsx
setLocalModelTargets(log.config.imageModelTargets || [log.config.model || log.model]);
if (log.config.quality) setLocalQuality(log.config.quality);
if (log.config.size) setLocalSize(log.config.size);
if (log.config.count) setLocalCount(log.config.count);
```

`count` 注意类型：local 是 `useState(effectiveConfig.count)`，日志里是字符串，确认与现有 local 类型一致。同时把移动端摘要条（513-515）从 `effectiveConfig.size/quality` 改为读 `localSize/localQuality`（模型标签同理用 `modelTargets[0]`），与桌面面板一致。

**验证**：手动——生成一条日志→修改面板参数→点日志复现→确认面板和摘要条显示的参数与日志一致，且实际生成请求使用这些参数（看 Network 或生成日志的 config 字段）。

---

## #2 多选选择器显示与实际选择脱钩（必须修）

**文件**：`web/src/pages/image/index.tsx:626`

**现状**：`GenerationSettings` 内：

```tsx
// 617 / 626
const config = useEffectiveConfig();
<ImageModelTargetPicker config={config} onChange={onModelTargetsChange} ... />
```

`ImageModelTargetPicker`（image-model-target-picker.tsx:21）的勾选态从传入 config 派生（`resolveImageModelTargets(config)`），而 `onChange` 只写 `localModelTargets`（经 props 523-532 / 595-604 传入的 `setLocalModelTargets`）。用户勾选后复选框立即回弹到 store 旧值，实际生成却用新选的 local 值——**看到选了 X，实际打到 Y**。

**预期行为**：勾选后复选框保持新选状态，显示与实际生成所用一致。

**修复方案**：传合并后的 config 使勾选态从 local 派生：

```tsx
<ImageModelTargetPicker config={{ ...config, imageModelTargets: modelTargets }} onChange={onModelTargetsChange} ... />
```

`GenerationSettings` 已接收 `modelTargets` props（含 local 值），组件签名（image-model-target-picker.tsx:9-15）接受 `config: AiConfig`，无需改 picker。

**验证**：手动——打开多选 Popover 勾选新模型→复选框保持勾中→按钮 label 显示新选择→生成请求打到所选渠道。

---

## #9 `updateConfig("imageModel")` 不重派生 targets，已提交测试是红的（必须修）

**文件**：`web/src/stores/use-config-store.ts:219-225`

**现状**：

```ts
updateConfig: (key, value) =>
    set((state) => ({
        config: {
            ...state.config,
            [key]: value,
        },
    })),
```

只做平铺展开，`imageModel` 变化后 `imageModelTargets` 不重派生。仓库自带测试 `web/tests/image-generation.test.mjs:229` 实跑失败（**当前 10 通过 1 失败**，actual `['b::image-b']` vs expected `['a::other']`）。Agent 面板工具（`web/src/pages/canvas/agent-site-tools.ts:167`）就是这么调——切默认模型后生成请求继续打到旧渠道。

**预期行为**（由测试 `web/tests/image-generation.test.mjs:218-243` 完整定义）：

1. `updateConfig("imageModel", v)` 后，`imageModelTargets` 跟随新默认（重派生为 `[v]`），**除非**当前 `imageModelTargets` 显式为 `[]`（sticky fail-closed：用户显式清空过多选，保持 `[]`，不自动回退）。
2. `setImageModelTargets([])` 后再 `updateConfig("imageModel", ...)`，targets 仍为 `[]`（测试 230-232）。
3. 不破坏 `setChannels` 的原子性——`useConfigStore.subscribe` 在一次 `setChannels` 里只触发一次（测试 233-237）。
4. 不破坏 rehydrate 持久化（测试 240-242）。

**修复方案**：`updateConfig` 在 `key === "imageModel"` 时重派生：

```ts
updateConfig: (key, value) =>
    set((state) => {
        const config = { ...state.config, [key]: value };
        if (key === "imageModel") {
            // 显式清空（[]）保持 fail-closed；未设置（undefined）或已有选择时跟随新默认
            const nextTargets = config.imageModelTargets?.length === 0 ? [] : [value];
            config.imageModelTargets = normalizeImageModelTargets(value, nextTargets, config.channels);
        }
        return { config };
    }),
```

注意 `[]` vs `undefined` 的区分（镜像 `setChannels` 238-240 的写法）：`undefined` = 从未设置过、跟随默认；`[]` = 显式清空、保持空。`normalizeImageModelTargets(primary, targets, channels)` 在 `use-config-store.ts:441-446`，直接可用。可顺手评估 `key === "model"` 是否需要同样处理（`config.model` 是旧的单一模型字段，image.ts:739 的 `resolveImageModelTargets` 会读它），若测试未覆盖则保持不动并在完成报告里说明。

**验证（完成标准）**：`web/` 目录下执行

```
node --test tests/image-generation.test.mjs
```

须 **11/11 通过**（当前 10 通过 1 失败）。注意 `web/package.json` 没有 test script，不要用 `pnpm test`。

---

## #12 旧数据渠道并发静默退化为串行（必须修）

**文件**：`web/src/stores/use-config-store.ts:336`（`createModelChannel` 内），类型声明 `:25`，第二处归一 `web/src/services/api/image.ts:742`

**现状**：`ModelChannel.maxConcurrency` 是可选字段（`use-config-store.ts:25` `maxConcurrency?: number;`）。升级前持久化的渠道没有这个字段，rehydrate 后经 `createModelChannel`：

```ts
// 336
maxConcurrency: normalizeChannelConcurrency(channel?.maxConcurrency),
```

`normalizeChannelConcurrency(undefined)` = 1（`Number(undefined) || 1`）。存量用户 count=15 的批量从并行退化成逐张串行，墙钟约 15 倍，无任何提示。**本 commit 主打的渠道级并发对老数据完全失效。**

`web/src/services/api/image.ts:742` 调度入口还有第二处 `normalizeChannelConcurrency(channel.maxConcurrency)`——若 store 层已把旧渠道归一成 1，这里同样拿不到原始 undefined，需一并处理。

**预期行为**：升级前的存量渠道获得合理的默认并发（不退化为 1）；用户显式设置的 1 仍保持 1。

**修复方案**：区分"字段缺失（旧数据）"与"显式设 1"。`createModelChannel` 处：

```ts
maxConcurrency: channel?.maxConcurrency === undefined ? <默认值> : normalizeChannelConcurrency(channel.maxConcurrency),
```

默认值建议 3-5（并发太低浪费调度器、太高容易打爆上游限流，取 4 左右折中，可按仓库风格定夺并在完成报告里说明取值理由）。`image.ts:742` 若在 store 层已保证字段总是存在（数字），保持 `normalizeChannelConcurrency(channel.maxConcurrency)` 不动即可；只改 store 层。**不要**把类型改成必填——那会迫使所有构造点补字段，扩大改动面。

**验证**：单测——在 `web/tests/image-generation.test.mjs` 补一个用例：构造不带 `maxConcurrency` 的渠道（模拟旧持久化数据）→ rehydrate 或 `setChannels` → 断言 `channel.maxConcurrency === <默认值>`；再断言显式 `maxConcurrency: 1` 的渠道仍为 1、`maxConcurrency: 99` 仍被 clamp 到 20。跑 `node --test tests/image-generation.test.mjs` 全绿。

---

## #6 画布节点图片模式丢失模型回退链（必须修）

**文件**：`web/src/lib/canvas/canvas-generation-helpers.ts:100`；两份逐字节副本 `web/src/components/canvas/canvas-config-node-panel.tsx:159`、`web/src/components/canvas/canvas-node-prompt-panel.tsx:175`

**现状**：

```ts
// canvas-generation-helpers.ts:100
model: mode === "image" ? imageModelTargets[0] || "" : resolveModelForCapability(config, node?.metadata?.model, mode),
```

图片模式把模型从 `resolveModelForCapability` 的三级回退（node metadata.model → config 对应能力模型 → 默认）改成了 `imageModelTargets[0] || ""`。节点 `metadata.model` 指向已删除渠道时，旧逻辑回退可用模型继续生成；新逻辑得到空串，进 `requestImageBatch` 后在 image.ts:746-749 抛 noChannel，**用户无提示、无法自愈**。

**预期行为**：`imageModelTargets[0]` 为空时回退到 `resolveModelForCapability` 的原三级回退链，节点不因渠道被删而永久无法生成。

**修复方案**：

```ts
model: mode === "image" ? imageModelTargets[0] || resolveModelForCapability(config, node?.metadata?.model, mode) : resolveModelForCapability(config, node?.metadata?.model, mode),
```

**三处副本必须同步修改**（canvas-generation-helpers.ts:100、canvas-config-node-panel.tsx:159、canvas-node-prompt-panel.tsx:175），改完 diff 三处确认一致。

**验证**：`pnpm typecheck`；手动——配置一个 image 渠道→画布节点用它生成过一次→删掉该渠道→再在节点上生成→应回退到可用模型成功，而非 noChannel 报错。

---

## #3 透明背景开关静默失效（建议修）

**文件**：`web/src/pages/image/index.tsx:629-633`

**现状**：`GenerationSettings` 的 `onConfigChange` 只路由三个 key：

```tsx
const onConfigChange = (key: string, value: string) => {
    if (key === "quality") setLocalQuality(value);
    else if (key === "size") setLocalSize(value);
    else if (key === "count") setLocalCount(value);
};
```

`ImageSettingsPanel`（`web/src/components/image-settings-panel.tsx:128`）还会发 `background` 键，被直接丢弃。开关显示已开启，请求里 `background` 仍是旧值。

**预期行为**：透明背景开关生效，本次会话的请求带上新 background 值。

**修复方案**：补一条路由。`background` 没有 local state，而快照（349 行）的 `background` 读自 `effectiveConfig` spread，所以写 store 即生效：

```tsx
else if (key === "background") updateConfig("background", value);
```

`GenerationSettings` 内需要拿到 `updateConfig`（`useConfigStore` 的 action，组件里已可用 zustand hook 或经 props 传）。若想完全统一到"会话内 local"模式，也可以加 `localBackground` state 并在 349 行快照里覆盖 `background`——两种都正确，选改动小的那种（写 store），并在完成报告里注明选择。

**验证**：手动——打开透明背景开关→生成→请求 payload 的 background 字段为新值；看生成日志 config.background 同步。

---

## #4 local targets 不跟随渠道变化（建议修）

**文件**：`web/src/pages/image/index.tsx:108`

**现状**：`localModelTargets` 只在 mount 时初始化一次。会话中途删除已勾选渠道后，local 仍持死 target：每次点生成弹配置警告（344 行 `isAiConfigReady` 检查失败），或进到 `requestImageBatch` 被过滤成空 targets 抛 noChannel——即使其他渠道本可用。

**预期行为**：渠道列表变化后，local 多选过滤掉已不存在的 target；全被删时回落到默认派生（或触发配置提示），不再持死值。

**修复方案**（二选一）：

- **方案 A（简单）**：读取时过滤——113 行改为：

  ```tsx
  const modelTargets = localModelTargets.length
      ? localModelTargets.filter((target) => isAiConfigReady(effectiveConfig, target))
      : resolveImageModelTargets(effectiveConfig);
  ```

  过滤后为空时回落 `resolveImageModelTargets(effectiveConfig)`。注意：全被删时回落默认派生可能打到用户未选渠道——与 #10 的语义（保持空、fail-closed 提示配置）需对齐，建议全被删时也保持空并让 344 行的 `configFirst` 警告兜底。

- **方案 B（跟随）**：`useEffect` 监听 `effectiveConfig.channels`，变化时 `setLocalModelTargets((prev) => prev.filter(存活))`。

方案 A 更贴近现有代码形态（113 行已有 `length ? :` 结构），推荐 A。

**验证**：手动——多选两个渠道→删其中一个→回到工作台：面板不再弹配置警告（或提示重新选择），生成打到存活渠道。

---

## #5 Agent 任务卡死在 running（建议修）

**文件**：`web/src/pages/image/index.tsx:205`

**现状**：

```tsx
// 204-205
const result = await Promise.allSettled(tasks);
if (generationController.current !== controller) return;   // ← 早退
// 212
if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", ... });
// 214-232 try { saveLog(...) } finally { generationController.current = null; setRunning(false); }
```

生成中用户点日志复现（`createSession`（293-306）abort 旧 controller 并置空 `generationController.current`），旧批次在 205 早退：agent task 状态永远停在 running，本次生成也不落 GenerationLog。

**预期行为**：旧批次被新会话取代时，其 agent task 以失败/取消状态终结，不悬挂。

**修复方案**：205 行早退**之前**先终结 agent task（新 controller / `running` / finally 清理都不动——新批次已接管，旧批次不应碰它们）：

```tsx
if (generationController.current !== controller) {
    if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("common.requestCanceled") /*或现有取消文案*/ });
    return;
}
```

`status: "failed"` 在 185 行已有先例（`invalidParams` 也用它）。若仓库有更贴切的取消语义（查 `updateAgentTask` 的类型定义确认 status 合法值），用之；落不落一条 canceled GenerationLog 可选，不落也可以接受。

**验证**：`pnpm typecheck`；手动——通过 Agent 面板发起生图任务→生成进行中点历史日志复现→Agent 任务列表里旧任务状态变为 failed/canceled，不再 running。

---

## #7 失败图片不带渠道标签（建议修）

**文件**：`web/src/pages/canvas/project.tsx:2505`（失败分支），`2413-2418`（初始化），显示守卫 `web/src/components/canvas/canvas-node.tsx:899`

**现状**：批量生成的 images 数组初始化时 `model: undefined`（2416），只有成功路径赋 `model: image.model`（2471）。失败分支只写：

```tsx
// 2505
{ ...image, status: NODE_STATUS_ERROR, errorDetails }
```

`canvas-node.tsx:899` 的标签守卫是 `image.model ?`，所以**初始就失败**的槽位永不渲染渠道标签——02362bc"为失败图片添加渠道标签"这条提交对该路径未兑现（失败后重试成功的才有标签）。

**预期行为**：失败图片也显示实际尝试的渠道标签（用户最需要知道是哪个渠道挂了）。

**修复方案**：两处补 model——

1. 初始化（2416）：`model: imageIds.map(...)` 的对象里给 `model: <批次 targets[0]>`（初始化时无法预知最终尝试哪个渠道，先填 targets[0] 作为最优猜测；若 `generationConfig.model` 可用则用它）。
2. 失败分支（2505）：优先用实际尝试的渠道。查该 catch 分支的作用域里能否拿到 attempted target（`requestImageBatch` 的每图 fallback 循环只把最终失败抛出，per-image 的 attempted 信息可能没透传）——拿不到就沿用 `image.model ??`（即初始化时填的 targets[0]），保证有值。

`CanvasNodeImage` 类型（查其定义处）的 `model` 若是必填或可选，按现状补齐即可。

**验证**：`pnpm typecheck`；手动——配置一个必然失败的渠道（如 apiKey 无效）→画布批量生成→失败图片上显示渠道标签。

---

## #10 删除渠道时多选被静默重置（建议修）

**文件**：`web/src/stores/use-config-store.ts:238-240`（`setChannels` 内）

**现状**：

```ts
const targets = resolveImageModelTargets(config);
const nextTargets = targets.length || state.config.imageModelTargets?.length === 0 ? targets : undefined;
config.imageModelTargets = normalizeImageModelTargets(config.imageModel, nextTargets, config.channels);
```

显式多选的渠道**全被删除**时：`resolveImageModelTargets(config)` 基于新 channels 解析出默认派生的非空 targets，于是走 `targets.length` 分支——用户的多选被静默重置回默认回退，下次生成打到用户未选过的渠道。`[]` 分支（sticky fail-closed）只有"用户曾显式清空"才触发。

**预期行为**：用户显式选择的渠道被删光时，多选保持 `[]`（fail-closed），下次生成触发配置提示（`isAiConfigReady` 检查 / configFirst 警告），而非静默换渠道。

**修复方案**：区分"用户显式清空（`[]`）"与"显式选择被删光"。原 `state.config.imageModelTargets` 非空但 `resolveImageModelTargets(config)`（新 channels 下解析当前选择）为空时，应保持 `[]`：

```ts
const previousTargets = state.config.imageModelTargets;
const resolved = resolveImageModelTargets(config);          // 新 channels 下旧选择还剩什么
let nextTargets: string[] | undefined;
if (previousTargets === undefined) nextTargets = undefined; // 从未设置，继续跟随默认
else if (resolved.length) nextTargets = resolved;           // 旧选择还有存活项，收敛到存活项
else nextTargets = [];                                      // 显式选择被删光，fail-closed
config.imageModelTargets = normalizeImageModelTargets(config.imageModel, nextTargets, config.channels);
```

**注意**：`resolveImageModelTargets(config)` 读的是 `config.imageModelTargets`（此时 config 已是 setChannels 里的新对象、还带着旧 targets 值），所以 `resolved` 语义是"旧选择在新 channels 下的存活投影"——与现状 238 行一致，只是分支判定改了。改完必须跑 `node --test tests/image-generation.test.mjs`，尤其 218-243（setChannels 原子性 233-239、sticky `[]` 230-232）不能破。若测试对"删光后回退默认"的现状有断言（核对 218-243 全段），按测试语义调整方案——**测试定义语义，测试红就是改错了**。

**验证**：`node --test tests/image-generation.test.mjs` 全绿；手动——多选渠道 A→删除渠道 A→偏好设置里多选显示为空且下次生成弹配置提示，而非自动换成渠道 B。

---

## #11 并发数输入框清空跳 1（建议修）

**文件**：`web/src/components/layout/channel-editor-drawer.tsx:86`（InputNumber），`46-49`（save）

**现状**：

```tsx
// 86
<InputNumber min={1} max={20} precision={0} value={normalizeChannelConcurrency(draft.maxConcurrency)}
    onChange={(value) => patch({ maxConcurrency: normalizeChannelConcurrency(value) })} className="!w-full" />
```

onChange 直接归一化：清空产生 NaN 被立即折成 1。想把 5 改成 8：全选删除的瞬间值跳成 1，继续输入得到 "18"（clamp 20）——与意图严重不符。

**预期行为**：清空时输入框允许暂时为空，save 时才归一；用户可以正常从 5 改到 8。

**修复方案**：onChange 保留原始值（不归一化），save 时统一归一。`draft.maxConcurrency` 类型放宽到 `number | undefined`（draft 是本地 state），save（46-49）处：

```tsx
const save = () => {
    onSave({ ...draft, maxConcurrency: normalizeChannelConcurrency(draft.maxConcurrency), ... });
    onClose();
};
```

`normalizeChannelConcurrency(undefined)` = 1，即"清空不填就存 1"——若想清空存默认值（与 #12 的默认对齐），改为 `draft.maxConcurrency === undefined ? <默认值> : normalizeChannelConcurrency(draft.maxConcurrency)`，与 #12 取值保持一致。InputNumber 的 `value` 在 draft 值为 undefined 时显示空，`min/max/precision` 保留约束输入。

**验证**：手动——打开渠道编辑→并发框从 5 改 8：全选删除不跳 1，输入 8 正常；清空直接保存得到默认值/1（按选定方案）；`pnpm typecheck`。

---

## #13 首图 pin 到全局默认而非批内首选（建议修）

**文件**：`web/src/services/api/image.ts:760`

**现状**：

```ts
let preferred = index === 0 ? config.imageModel : undefined;
```

用全局 `config.imageModel`，而所有调用方的 `config.model` 都已设为 `targets[0]`（工作台 114 行、画布 buildGenerationConfig、快照 349 行）。全局默认 B、用户多选 [A, B] 时首图打到 B，但日志按 `targets[0]`=A 记录——账单统计与实际渠道不符；且默认渠道饱和时首图排队而其他渠道空闲。

**预期行为**：首图优先打到批内首选 `targets[0]`，与日志记录一致。

**修复方案**：

```ts
const selected = resolveImageModelTargets(config, { model: config.model, imageModelTargets: config.imageModelTargets });  // 739 行已有
// ...
let preferred = index === 0 ? selected[0] : undefined;
```

调度器（image-generation-scheduler.ts:24）本就校验 `preferred ∈ targets` 否则丢弃，改这里不会越界。与测试 245-251（"unused defaults do not pin a request"）的语义一致。

**验证**：`node --test tests/image-generation.test.mjs` 全绿（注意 245-251 断言 proxy 路由，确认改动后仍过）；手动——全局默认设 B、多选 [A, B] 生成 2 张→首张打到 A。

---

## #14 插件传入未验证 model 必败（建议修）

**文件**：`web/src/pages/canvas/hooks/use-plugin-host.tsx:54`（generateImage），`46-51`（ensureReady）

**现状**：

```tsx
const config = {
    ...buildGenerationConfig(effectiveConfig, undefined, "image"),
    count: String(options?.count || 1),
    ...(options?.model ? { model: options.model, imageModelTargets: [options.model] } : {}),
    ...(options?.size ? { size: options.size } : {}),
};
```

`options.model` 能力不符或已删除时，`imageModelTargets: [options.model]` 被 normalize 过滤成 `[]`；`ensureReady`（46-51）只查 `config.model`，拦截不到，最终在 image.ts:746-749 抛 noChannel——**改动前插件走默认渠道可成功**。

**预期行为**：插件传入的 model 无效时，回退默认渠道继续生成（或抛出语义明确的错误），不进 noChannel 死路。

**修复方案**：`generateImage` 里校验 `options.model`，无效则不覆盖：

```tsx
const requested = options?.model;
const modelValid = requested && selectableModelsByCapability(effectiveConfig, "image").includes(requested);
const config = {
    ...buildGenerationConfig(effectiveConfig, undefined, "image"),
    count: String(options?.count || 1),
    ...(modelValid ? { model: requested, imageModelTargets: [requested] } : {}),
    ...(options?.size ? { size: options.size } : {}),
};
```

`selectableModelsByCapability(effectiveConfig, "image")` 在同一文件 87-88 行（listModels）已在用，直接复用。二选一语义：静默回退默认（上面方案，宽松）或抛明确错误给插件（严格）——建议宽松，与改动前行为兼容。

**验证**：`pnpm typecheck`；手动——写个传无效 model 的测试插件调用生图→回退默认渠道成功。

---

## #15 model-script-editor 样式删除疑似误伤（可斟酌，PLAUSIBLE）

**文件**：`web/src/components/layout/model-script-editor.tsx:55-56`

**现状**：本 diff 在该文件的唯一改动是删除 `styles.content`（height/padding/borderRadius/overflow），但 `wrapClassName`（55 行）没给 `.ant-modal-content` 加 `!p-0`。antd 默认 contentPadding 恢复后，内层 `h-dvh` 容器加 padding 超出视口，矮视口下保存/取消按钮可能被裁掉。且这与多渠道生图无关，疑似顺手改的无关文件。

**修复方案**：先目验——打开"自定义模型脚本"编辑器，把窗口高度压到 700px 以下看底部按钮是否被裁。被裁则还原 `styles.content` 或在 `wrapClassName` 里补 `.ant-modal-content` 的 `!p-0`（注意与 antd 6 的 Modal 样式 API 匹配）；没被裁则关闭此项并在报告里说明目验结论。

**验证**：手动目验 + 截图确认。

---

## #8 双徽章重叠（可斟酌）

**文件**：`web/src/components/canvas/canvas-node.tsx:879` 附近

**现状**：展开的失败图片同时渲染 `ExpandedImageCard` 的渠道标签（872-878）和 `BatchImageFailureActions` 的渠道标签（899-905），右下角两枚错位重叠。同一标签 span 在文件里复制了 4 份。

**修复方案**：去掉其中一枚（保留 `BatchImageFailureActions` 里带失败上下文的那枚更合理——它与失败重试按钮同区）。若顺手把 4 份复制的标签 span 收敛成一个局部小组件/变量更好，但控制改动面，收敛非必需。

**验证**：手动——画布上生成失败的图片展开查看：右下角只有一枚渠道标签，无重叠。

---

## 结构性建议（本次可不做，记入 backlog）

1. **`buildGenerationConfig` 三副本收敛**：`web/src/lib/canvas/canvas-generation-helpers.ts:96`、`web/src/components/canvas/canvas-config-node-panel.tsx:159`、`web/src/components/canvas/canvas-node-prompt-panel.tsx:175` 是三份逐字节相同的实现，这次 #6 被迫三处同步打补丁。建议后续收敛到 `canvas-generation-helpers.ts` 导出的 `buildGenerationConfig` 单一来源，另两处 import。**不要在本次修 #6 时顺手做**——保持每条修复独立可回滚。
2. **canvas-node.tsx 整 config 订阅击穿 memo**：`web/src/components/canvas/canvas-node.tsx` 752/818/886 三处订阅整个 `state.config`（只是读 channels），任何 config 字段变化都会重渲染所有节点。应改订阅 `state.config.channels`（zustand selector）。本次可不修，画布节点多时性能可感知再动。

---

## 给 Codex 的执行注意

1. **逐条独立修复**：每条一个独立 commit（或至少独立可回滚的改动集），按 必须修 → 建议修 → 可斟酌 顺序推进。#15、#8 先做目验确认再决定动不动手。
2. **不要顺手扩大改动面**：只改各条列出的文件和行；发现相邻问题记录到报告里，不要一并修。
3. **#9 / #10 / #13 的完成标准是测试**：`web/` 目录下 `node --test tests/image-generation.test.mjs`（`web/package.json` **没有 test script，不要用 `pnpm test`**）。#9 必须达到 11/11（当前 10 通过 1 失败）；#10、#13 改完不得让任何现有用例变红。测试文件里的语义断言（sticky `[]`、setChannels 原子单次 subscribe、rehydrate）定义了正确行为，**测试红就是改错了**。
4. **#12 需要补测试用例**（旧数据无 maxConcurrency 字段 → 默认值；显式 1 → 1；99 → clamp 20），加进 `web/tests/image-generation.test.mjs` 现有 describe 结构。
5. **全局验证**：全部修完后在 `web/` 下跑 `pnpm typecheck`（tsc --noEmit）必须干净。
6. **格式**：不要跑 `prettier --write`；如需检查用 `prettier --check --end-of-line auto .`（Windows 下 CRLF 会让不带 `--end-of-line auto` 的 check 全量假警报）。
7. **类型修改最小化**：#12 不要把 `maxConcurrency` 改成必填；#11 只放宽 draft 本地类型，不动导出的 `ModelChannel`。
8. 行号基于 `main` @ `025dc47`，若执行时有漂移，按各条摘录的代码内容定位。
