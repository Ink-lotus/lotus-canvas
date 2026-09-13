代码审查已完成。范围是 `8bb920c..025dc47` 这 5 个提交（24 文件，+1151/−141），经过 10 个独立角度扫描 + 逐项回源码验证，最终确认 15 条问题（13 条 CONFIRMED、2 条 PLAUSIBLE）。按你列的四个改动分组汇报，组内按严重度排序。

## 改动 1：工作台改用局部 state —— 问题最集中

**「写 store、读 local」的半截重构是最大问题源**：读取方换成了 local state，写入方还留着旧的 store 写入路径，两边永久脱节。

1. **日志复现功能失效**（`web/src/pages/image/index.tsx:331`）— `previewGenerationLog` 恢复历史日志时把 quality/size/count 写回全局 store（332-334），但生成参数读的是 108-111 行 mount 时固化的 local state。点“复现”后：prompt/参考图恢复了，模型、质量、尺寸、数量全部不生效。更糟的是移动端摘要条（513-515）读 store 显示新值、桌面面板（522-532）显示 local 旧值，两处 UI 自相矛盾。
2. **多选选择器显示与实际选择脱钩**（`web/src/pages/image/index.tsx:626`）— `GenerationSettings` 把 store 的 config 传给 `ImageModelTargetPicker`，勾选态从 store 派生，onChange 却只写 `localModelTargets`。用户勾选后复选框回弹到旧值，实际生成用的却是新选的 local 值——用户看到选了 X，实际打到 Y。
3. **透明背景开关静默失效**（`web/src/pages/image/index.tsx:630`）— `onConfigChange` 只路由 quality/size/count 三个 key，`ImageSettingsPanel` 还会发 `background` 键（image-settings-panel.tsx:128），被直接丢弃。开关显示已开启，请求里 background 仍是旧值。
4. **local targets 不跟随渠道变化**（`web/src/pages/image/index.tsx:108`）— `localModelTargets` 只在 mount 初始化。会话中途删除已勾选渠道后，local 仍持死 target：每次点生成弹配置警告，或进到 `requestImageBatch` 被过滤成空 targets 抛 noChannel——即使其他渠道本可用。
5. **Agent 任务卡死在 running**（`web/src/pages/image/index.tsx:205`）— 新加的 `if (generationController.current !== controller) return;` 早退位于 `updateAgentTask`（212）和 try/finally 清理（214-232）之前。生成中用户点日志复现（`createSession` abort 旧 controller 并置空），旧批次在 205 早退，agent task 状态永远停在 running，本次生成也不落 GenerationLog。

## 改动 2：画布节点继承源节点配置

6. **图片模式丢失模型回退链**（`web/src/lib/canvas/canvas-generation-helpers.ts:100`）— 三份逐字节相同的 `buildGenerationConfig`（canvas-config-node-panel.tsx:159、canvas-node-prompt-panel.tsx:175）把图片模式模型从 `resolveModelForCapability` 的三级回退改为 `imageModelTargets[0] || ""`。节点 metadata.model 指向已删除渠道时，旧逻辑回退可用模型继续生成，新逻辑得到空串直接抛 noChannel，用户无提示无法自愈。
7. **失败图片不带渠道标签**（`web/src/pages/canvas/project.tsx:2505`）— 批量生成失败分支只写 `{ ...image, status, errorDetails }`，images 数组初始化时 `model: undefined`，只有成功路径赋 model。canvas-node.tsx:899 的标签守卫 `image.model ?` 因此永不渲染——02362bc “为失败图片添加渠道标签”这条提交对**初始就失败**的路径未兑现。
8. **双徽章重叠**（`web/src/components/canvas/canvas-node.tsx:879`）— 展开的失败图片同时渲染 ExpandedImageCard 的渠道标签（872-878）和 BatchImageFailureActions 的渠道标签（899-905），右下角两枚错位重叠。同一标签 span 在文件里复制了 4 份。

## 改动 3：移除自动同步逻辑

9. **`updateConfig("imageModel")` 不重派生 targets，已提交测试是红的**（`web/src/stores/use-config-store.ts:219`）— 只做平铺展开，不重导出 `imageModelTargets`。仓库自带测试 `web/tests/image-generation.test.mjs:229` 实跑失败（**10 通过 1 失败**，actual `['b::image-b']` vs expected `['a::other']`）。Agent 面板工具（agent-site-tools.ts:167）就这么调——切默认模型后生成请求继续打到旧渠道。
10. **删除渠道时多选被静默重置**（`web/src/stores/use-config-store.ts:238`）— 显式多选的渠道全被删除时，`setChannels` 把 `imageModelTargets` 重置回默认回退，无任何提示，下次生成打到用户未选过的渠道。

## 改动 4：偏好设置多选选择器

11. **并发数输入框清空跳 1**（`web/src/components/layout/channel-editor-drawer.tsx:86`）— onChange 直接 `patch({ maxConcurrency: normalizeChannelConcurrency(value) })`，清空产生 NaN 被立即折成 1。想把 5 改成 8：全选删除的瞬间跳成 1，继续输入得到 "18"（clamp 到 20）或 "18" 变 1——与意图严重不符。
12. **旧数据渠道并发静默退化为串行**（`web/src/stores/use-config-store.ts:336`）— 升级前持久化的渠道没有 `maxConcurrency` 字段，rehydrate 后归一化为 1。存量用户 count=15 的批量从并行退化成逐张串行，墙钟约 15 倍，无任何提示。本 commit 主打的渠道级并发对老数据完全失效。

## 改动之外 / 调度器连带问题

13. **首图 pin 到全局默认而非批内首选**（`web/src/services/api/image.ts:760`）— `let preferred = index === 0 ? config.imageModel : undefined` 用全局 `config.imageModel`，而所有调用方的 `config.model` 都已设为 `targets[0]`。全局默认 B、用户多选 [A, B] 时首图打到 B，但日志按 targets[0]=A 记录，账单统计与实际渠道不符，且默认渠道饱和时首图会排队而其他渠道空闲。
14. **插件传入未验证 model 必败**（`web/src/pages/canvas/hooks/use-plugin-host.tsx:54`）— 直接 spread 成 `imageModelTargets: [options.model]`，能力不符或已删除的 model 被 normalize 过滤成 `[]`；`ensureReady`（46-51）只查 `config.model`，拦截不到，最终在 image.ts:746-749 抛 noChannel——改动前插件走默认渠道可成功。
15. **model-script-editor 样式删除疑似误伤**（`web/src/components/layout/model-script-editor.tsx:56`，PLAUSIBLE）— 本 diff 在该文件的唯一改动是删除 `styles.content`（height/padding/borderRadius/overflow），但 `wrapClassName`（55）没给 `.ant-modal-content` 设 `!p-0`。antd 默认 contentPadding 恢复后，内层 `h-dvh` 容器加 padding 超出视口，矮视口下保存/取消按钮可能被裁掉。且这与多渠道生图无关，疑似顺手改的无关文件。

## 修复优先级建议

**必须修**：#1（写读脱节）、#2（选择器脱钩）、#9（测试红）、#12（存量串行化）、#6（回退链丢失）——这五条都是用户可感知的功能失效或数据错误。

**建议修**：#3、#4、#7、#10、#11、#13、#14——静默失效或状态卡死类。

**可斟酌**：#8（双徽章）、#15（还原误删样式）。

另有两点结构性观察：`buildNodeConfig` 三份逐字节副本这次被迫三处同步打补丁，建议收敛到 `buildGenerationConfig` 单一来源；canvas-node.tsx 新增三处整 config 订阅（752/818/886）会击穿 `React.memo`，只读 channels 的话应订阅 `state.config.channels`。

本次为纯审查，未修改任何文件。验证方式：10 个角度的 finder 扫描 + 全部发现回源文件逐行核对，其中 #9 实跑了 `node --test tests/image-generation.test.mjs` 确认测试红。
