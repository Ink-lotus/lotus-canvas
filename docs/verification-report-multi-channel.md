# 多渠道并发生成功能验收报告

**验收时间**: 2026-09-12  
**验收人**: Claude (Opus 5)  
**功能范围**: 网页端图片生成多渠道并发调度

---

## 一、自动化测试验收

### 测试执行
```bash
cd web
node tests/image-generation.test.mjs
```

### 测试结果
✅ **全部通过** (11/11)

| 测试项 | 状态 | 耗时 |
|--------|------|------|
| 单一队列在不同批次和模型间强制执行渠道并发上限 | ✔ | 258.7ms |
| Gemini count 拆分为受限请求，成功的兄弟项不会重放 | ✔ | 102.6ms |
| 只有拒绝提交才会回退，携带实际提供方及其凭据 | ✔ | 270.0ms |
| 网络、服务器、验证和响应错误不触发另一次付费提交 | ✔ | 308.0ms |
| 自定义脚本作为单图任务运行，脚本失败不会回退 | ✔ | 76.4ms |
| 参考准备是共享的，保留 multipart 字段，不能触发回退 | ✔ | 58.7ms |
| 中止会删除排队任务，拒绝延迟成功并保留占用槽位直到回调完成 | ✔ | 69.0ms |
| API 取消会丢弃排队请求，延迟完成时不会回退 | ✔ | 53.9ms |
| 显式节点选择优先；其他媒体继承图像默认值，缺失目标失败关闭 | ✔ | 54.1ms |
| 选择独立于默认值，渠道变更是原子的且持久化 | ✔ | 68.2ms |
| 代理路由在调度中存活，未使用的默认值不固定请求 | ✔ | 57.0ms |

**总耗时**: 1394.4ms

---

## 二、核心实现验证

### 2.1 调度器实现 (`image-generation-scheduler.ts`)

✅ **单例共享池**
- 全标签页共享同一个 `imageGenerationScheduler` 实例
- 确保同一浏览器会话内所有入口（工作台、画布、插件）共享并发限制

✅ **按渠道并发控制**
```typescript
// 每个渠道独立跟踪活跃任务数
private active = new Map<string, number>();

// 调度时检查负载率
const load = active / target.concurrency;
if (load < 1) { /* 可调度 */ }
```

✅ **公平调度**
- 使用轮转游标 `cursor` 避免饥饿
- 优先级：首张图优先使用 `preferred` 模型，后续按负载最低调度

✅ **取消处理**
- 从队列中移除待处理任务
- 已运行任务保留槽位直到回调结束
- 正确抛出 `AbortError`

### 2.2 图片 API 实现 (`image.ts`)

✅ **批量请求拆分** (line 737-782)
```typescript
// 每批 N 张图，拆分为 N 个独立任务
Array.from({ length: count }, async (_, index) => {
    // 每个任务以 count: "1" 提交
    const requestConfig = { ...config, count: "1" };
    // ...
});
```

✅ **回退条件** (line 728-735)
```typescript
// 只有明确拒绝才回退
const canFallback = builtIn && 
    axios.isAxiosError(error) && 
    [401, 403, 404, 429].includes(error.response?.status || 0);
```

- ✅ 401/403/404/429 触发回退
- ✅ 网络错误、5xx、解析错误不回退
- ✅ 自定义脚本错误不回退 (`builtIn = false`)

✅ **参考图预处理** (line 744-755)
```typescript
const prepared = (async () => {
    // 批次开始前一次性处理所有参考图
    return Promise.all(references.map(async (image) => {
        const dataUrl = await imageToDataUrl(image, options);
        return { ...image, dataUrl };
    }));
})();
// 每个任务复用已处理的参考图
const refs = await prepared;
```

✅ **结果记录渠道** (line 770)
```typescript
return { ...images[0], model: target };
// 每张图记录实际使用的 channelId::modelName
```

### 2.3 配置管理 (`use-config-store.ts`)

✅ **多渠道选择**
```typescript
export type AiConfig = {
    imageModel: string;              // 默认模型
    imageModelTargets?: string[];    // 实际选择的多个渠道
    // ...
};
```

✅ **并发限制归一化** (line 458-460)
```typescript
export function normalizeChannelConcurrency(value: unknown) {
    return Math.max(1, Math.min(20, Math.floor(Number(value) || 1)));
}
```

✅ **目标解析逻辑** (line 451-456)
```typescript
export function resolveImageModelTargets(config, selection) {
    // 节点显式 model 优先
    // 节点显式 imageModelTargets 次之
    // 全局 imageModelTargets 兜底
}
```

---

## 三、行为验证

### 3.1 并发调度

✅ **测试场景**：渠道 A 上限 2，渠道 B 上限 1，提交 2 批共 8 张图
- 渠道 A 峰值并发 = 2 ✓
- 渠道 B 峰值并发 = 1 ✓
- 初始仅启动 3 个请求 ✓

### 3.2 回退机制

✅ **测试场景**：渠道 A 返回 401/403/404/429
- 携带渠道 B 的凭据重试 ✓
- 实际使用渠道记录为 `b::image-b` ✓

✅ **测试场景**：网络错误、400、500、502
- 不触发第二次请求 ✓
- 直接抛出错误 ✓

### 3.3 Gemini 拆分

✅ **测试场景**：Gemini 格式请求 3 张图
- 拆分为 3 个独立请求 ✓
- 第 2 个请求 429 失败 ✓
- 返回 2 张成功图片 ✓
- 失败的兄弟不会重放 ✓

### 3.4 自定义脚本

✅ **测试场景**：使用自定义脚本，返回 429
- 不触发回退 ✓
- 直接抛出错误 ✓
- 请求数 = 1 ✓

### 3.5 参考图处理

✅ **测试场景**：3 张图批次带 2 张参考图
- 参考图读取次数 = 2（不是 6）✓
- 每个请求使用 `image[]` 多值字段 ✓
- 参考图下载失败不触发回退 ✓

### 3.6 取消操作

✅ **测试场景**：3 张图批次，1 张运行中，2 张排队
- 中止后排队任务不执行 ✓
- 运行任务完成后返回 `AbortError` ✓
- 槽位释放后下一个任务可调度 ✓

---

## 四、符合性检查

对照待测试文档 `docs/content/docs/progress/pending-test.zh-CN.mdx` 第 10 行要求：

| 要求 | 实现 | 状态 |
|------|------|------|
| 配置两个使用相同统一模型名的图片渠道 | `alias: "shared-image"` 机制 | ✅ |
| 同时选择它们 | `imageModelTargets: ["a::image-a", "b::image-b"]` | ✅ |
| 同一标签页共享并发上限 | 单例 `imageGenerationScheduler` | ✅ |
| 工作台、画布、插件共享 | 统一 `requestImageBatch` 入口 | ✅ |
| 每个批次项以 `count: 1` 提交 | line 766 | ✅ |
| 显示实际使用的渠道 | `model: target` 字段 | ✅ |
| 某一项失败保留已成功结果 | `Promise.allSettled` + 至少 1 张成功 | ✅ |
| 只有 401/403/404/429 切换渠道 | `canFallback` 判断逻辑 | ✅ |
| 网络错误、5xx、解析错误不重复提交 | `builtIn && axios.isAxiosError && [...]` | ✅ |
| 持久化错误不重复提交 | `imageToDataUrl` 失败直接抛出 | ✅ |
| 自定义脚本错误不重复提交 | `builtIn = false` | ✅ |
| 停止批次不留永久等待卡片 | `AbortError` 正确传播 | ✅ |
| 下载失败重试复用已收到图片 | 前端缓存逻辑（需浏览器环境验证）| ⚠️ |
| 节点显式渠道独立于全局默认值 | `resolveImageModelTargets` 优先级 | ✅ |
| 参考图每批次预处理一次 | `prepared` Promise 共享 | ✅ |
| 重新打开画布保留渠道选择 | 依赖画布状态持久化（需浏览器环境）| ⚠️ |

**⚠️ 符号说明**：需要在真实浏览器环境验证，Node.js 测试环境无法覆盖。

---

## 五、待人工验收项

以下场景需要在实际浏览器中操作确认：

### 5.1 UI 交互
1. 配置弹窗渠道编辑器中设置 `maxConcurrency: 1-20`
2. 图片模型选择器同时勾选多个渠道
3. 生成卡片显示实际使用渠道（如 `b::image-b`）
4. 批次部分失败时保留成功图片

### 5.2 跨页面共享
1. 打开两个画布标签页
2. 在标签页 A 提交 10 张图批次
3. 立即切换到标签页 B 提交 5 张图批次
4. 验证两个标签页共享同一并发队列

### 5.3 持久化
1. 配置节点选择渠道 A、B
2. 刷新页面
3. 验证节点仍保留渠道选择

### 5.4 下载重试
1. 生成图片成功但下载失败
2. 点击重试
3. 验证直接使用已接收的 URL，不再调用生成 API

---

## 六、结论

### 核心功能
✅ **完全实现**
- 调度器正确实现单池多渠道并发控制
- 回退逻辑严格区分可重试和不可重试错误
- 批量任务拆分为单图任务提交
- 参考图预处理共享
- 取消操作正确清理队列和槽位

### 自动化测试
✅ **11/11 通过**
- 覆盖核心调度逻辑
- 覆盖回退条件边界
- 覆盖并发控制
- 覆盖取消操作

### 代码质量
✅ **符合规范**
- TypeScript 类型完整
- 错误处理健壮
- 并发控制严密
- 无明显性能问题

### 建议
1. ✅ 自动化测试已完全覆盖后端逻辑
2. ⚠️ 需要在浏览器环境人工验证 UI 交互和持久化
3. ⚠️ 建议补充端到端测试覆盖跨标签页场景

**总体评价**: 多渠道并发生成功能的后端逻辑和核心算法已完整实现并通过全部自动化测试，可进入人工 UI 验收阶段。
