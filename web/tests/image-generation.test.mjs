import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const pixel = "data:image/png;base64,cGl4ZWw=";
const refusal = (status) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: { error: { message: `HTTP ${status}` } } } });
const gate = () => Promise.withResolvers();

// Transpile the production modules with the existing TypeScript dependency. Only browser I/O is replaced.
function environment() {
    const cache = new Map();
    const stored = new Map();
    const calls = [];
    const reads = [];
    let post = async () => ({ data: { data: [{ b64_json: "cGl4ZWw=" }] } });
    let read = async (image) => image.dataUrl?.startsWith("data:") ? image.dataUrl : pixel;
    const middleware = require("zustand/middleware");
    const storage = middleware.createJSONStorage(() => ({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) }));
    const axios = {
        isAxiosError: (error) => Boolean(error?.isAxiosError),
        isCancel: (error) => error?.code === "ERR_CANCELED",
        post: async (url, data, options) => {
            const call = { url, data, ...options };
            calls.push(call);
            return post(call);
        },
        request: async (options) => {
            calls.push(options);
            return post(options);
        },
    };
    const overrides = {
        axios,
        "@/i18n": { t: (key, options) => options?.message || key },
        "zustand/middleware": { ...middleware, persist: (initializer, options) => middleware.persist(initializer, { ...options, storage }) },
        "@/services/image-storage": { imageToDataUrl: async (image, options) => { reads.push(image); return read(image, options); } },
        "@/lib/image-utils": { dataUrlToFile: (image) => new File([image.dataUrl], image.name, { type: image.type }) },
    };
    function load(file) {
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        new Function("require", "exports", "module", output)((specifier) => {
            if (specifier in overrides) return overrides[specifier];
            if (specifier.startsWith("@/")) return load(resolve(sourceRoot, `${specifier.slice(2)}.ts`));
            if (specifier.startsWith(".")) return load(resolve(dirname(file), `${specifier}.ts`));
            return require(specifier);
        }, module.exports, module);
        return module.exports;
    }
    const configModule = load(resolve(sourceRoot, "stores/use-config-store.ts"));
    const { defaultConfig, useConfigStore } = configModule;
    const channels = ["a", "b"].map((id) => ({ id, name: id, baseUrl: `https://${id}.example`, apiKey: `key-${id}`, apiFormat: "openai", maxConcurrency: 1, models: [{ name: `image-${id}`, alias: "shared-image", capability: "image" }] }));
    const config = { ...defaultConfig, channels, models: ["a::image-a", "b::image-b"], model: "a::image-a", imageModel: "a::image-a", imageModelTargets: ["a::image-a", "b::image-b"], size: "auto", quality: "auto" };
    useConfigStore.setState({ config });
    return { config, configModule, api: load(resolve(sourceRoot, "services/api/image.ts")), scheduler: load(resolve(sourceRoot, "services/api/image-generation-scheduler.ts")), calls, reads, stored, setPost: (callback) => { post = callback; }, setRead: (callback) => { read = callback; } };
}

test("one pool enforces channel caps across batches and different models", async () => {
    const env = environment();
    const waits = [];
    const active = new Map();
    const peak = new Map();
    env.config.channels[0].maxConcurrency = 2;
    env.config.channels[0].models.push({ name: "image-extra", alias: "shared-image", capability: "image" });
    env.config.imageModelTargets.push("a::image-extra");
    env.setPost(async ({ url, data }) => {
        assert.equal(data.n, 1);
        const channel = new URL(url).hostname;
        active.set(channel, (active.get(channel) || 0) + 1);
        peak.set(channel, Math.max(peak.get(channel) || 0, active.get(channel)));
        const wait = gate();
        waits.push(wait);
        await wait.promise;
        active.set(channel, active.get(channel) - 1);
        return { data: { data: [{ b64_json: "cGl4ZWw=" }] } };
    });
    const results = Promise.all([...env.api.requestImageBatch({ ...env.config, count: "4" }, "first"), ...env.api.requestImageBatch({ ...env.config, count: "4" }, "second")]);
    await setImmediate();
    assert.equal(env.calls.length, 3);
    for (let wave = 0; wave < 8; wave++) {
        waits.splice(0).forEach((wait) => wait.resolve());
        await setImmediate();
    }
    assert.equal((await results).length, 8);
    assert.equal(peak.get("a.example"), 2);
    assert.equal(peak.get("b.example"), 1);
});

test("Gemini count is split into capped requests and successful siblings are never replayed", async () => {
    const env = environment();
    env.config.channels.forEach((channel) => { channel.apiFormat = "gemini"; });
    env.config.imageModelTargets = ["a::image-a"];
    const waits = [];
    env.setPost(async ({ url }) => {
        assert.match(url, /generateContent/);
        const wait = gate();
        waits.push(wait);
        await wait.promise;
        return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cGl4ZWw=" } }] } }] } };
    });
    const batch = env.api.requestGeneration({ ...env.config, count: "3" }, "gemini");
    for (let index = 0; index < 3; index++) {
        await setImmediate();
        assert.equal(env.calls.length, index + 1);
        if (index === 1) waits.shift().reject(refusal(429));
        else waits.shift().resolve();
    }
    assert.equal((await batch).length, 2);
    assert.equal(env.calls.length, 3);
});

test("only refused submissions fall back, carrying the actual provider and its credentials", async () => {
    for (const status of [401, 403, 404, 429]) {
        const env = environment();
        env.setPost(async ({ url, headers }) => {
            if (url.includes("a.example")) throw refusal(status);
            assert.equal(headers.Authorization, "Bearer key-b");
            return { data: { data: [{ url: "https://images.example/result.png" }] } };
        });
        const [image] = await env.api.requestGeneration(env.config, "fallback");
        assert.equal(image.model, "b::image-b");
        assert.equal(env.calls.length, 2);
    }
});

test("network, server, validation and response errors never trigger another paid submission", async () => {
    for (const error of [new Error("Network Error"), refusal(400), refusal(500), refusal(502)]) {
        const env = environment();
        env.setPost(async () => { throw error; });
        await assert.rejects(env.api.requestGeneration(env.config, "failure"), (reason) => {
            assert.equal(reason.model, "a::image-a");
            return true;
        });
        assert.equal(env.calls.length, 1);
    }
    const env = environment();
    env.setPost(async () => ({ data: { data: [] } }));
    await assert.rejects(env.api.requestGeneration(env.config, "empty"), (reason) => {
        assert.equal(reason.model, "a::image-a");
        return true;
    });
    assert.equal(env.calls.length, 1);
});

test("fallback exhaustion reports the last attempted target", async () => {
    const env = environment();
    env.setPost(async () => { throw refusal(429); });
    await assert.rejects(env.api.requestGeneration(env.config, "fallback failure"), (reason) => {
        assert.equal(reason.model, "b::image-b");
        return true;
    });
    assert.equal(env.calls.length, 2);
});

test("custom scripts run as single-image jobs and script failures never fall back", async () => {
    const env = environment();
    env.config.channels[0].models[0].script = "await http.post('/generate', { n: params.count }); return ['https://images.example/result.png'];";
    const [image] = await env.api.requestGeneration(env.config, "custom");
    assert.equal(image.dataUrl, "https://images.example/result.png");
    assert.equal(env.calls[0].data.n, 1);
    assert.equal(env.calls.length, 1);
    env.setPost(async () => { throw refusal(429); });
    await assert.rejects(env.api.requestGeneration(env.config, "custom failure"));
    assert.equal(env.calls.length, 2);
});

test("reference preparation is shared, preserves multipart fields, and cannot trigger fallback", async () => {
    const env = environment();
    const references = ["first", "second"].map((name) => ({ id: name, name, type: "image/png", dataUrl: `https://refs.example/${name}.png` }));
    await Promise.all(env.api.requestImageBatch({ ...env.config, count: "3" }, "edit", references));
    assert.equal(env.reads.filter((image) => image.dataUrl.startsWith("https:")).length, 2);
    assert.equal(env.calls.length, 3);
    env.calls.forEach(({ data }) => { assert.equal(data.get("n"), "1"); assert.equal(data.getAll("image[]").length, 2); });
    env.setRead(async () => { throw new Error("reference download failed"); });
    await assert.rejects(env.api.requestEdit(env.config, "edit", references));
    assert.equal(env.calls.length, 3);
});

test("abort removes queued tasks, rejects late successes and retains occupied slots until callbacks settle", async () => {
    const { scheduler: { ImageGenerationScheduler } } = environment();
    const pool = new ImageGenerationScheduler();
    const targets = [{ value: "a", channelId: "a", concurrency: 1 }];
    const running = gate();
    const controller = new AbortController();
    const first = pool.schedule(targets, () => running.promise, controller.signal);
    const queued = pool.schedule(targets, () => { assert.fail("canceled task ran"); }, controller.signal);
    const canceled = Promise.all([assert.rejects(first, { name: "AbortError" }), assert.rejects(queued, { name: "AbortError" })]);
    await setImmediate();
    controller.abort();
    await canceled;
    let started = false;
    const next = pool.schedule(targets, async () => { started = true; return "next"; });
    await setImmediate();
    assert.equal(started, false);
    running.resolve("late");
    assert.equal(await next, "next");
    await assert.rejects(pool.schedule([], async () => "invalid"));
});

test("API cancellation drops queued requests and never falls back on late completion", async () => {
    const env = environment();
    env.config.imageModelTargets = ["a::image-a"];
    const controller = new AbortController();
    const wait = gate();
    env.setPost(async () => { await wait.promise; return { data: { data: [{ b64_json: "cGl4ZWw=" }] } }; });
    const result = assert.rejects(env.api.requestGeneration({ ...env.config, count: "3" }, "cancel", { signal: controller.signal }), { name: "AbortError" });
    await setImmediate();
    controller.abort();
    await result;
    wait.resolve();
    await setImmediate();
    assert.equal(env.calls.length, 1);
});

test("explicit node selection wins; other media inherit image defaults and missing targets fail closed", () => {
    const { config, configModule: { resolveGenerationModel, resolveImageModelTargets } } = environment();
    config.channels[0].models.push({ name: "text", capability: "text" });
    assert.deepEqual(resolveImageModelTargets(config, { model: "b::image-b" }), ["b::image-b"]);
    assert.deepEqual(resolveImageModelTargets(config, { model: "a::image-a", imageModelTargets: ["b::image-b"] }), ["b::image-b"]);
    assert.deepEqual(resolveImageModelTargets(config, { model: "a::text" }), config.imageModelTargets);
    assert.deepEqual(resolveImageModelTargets(config, { model: "missing::image" }), []);
    assert.deepEqual(resolveImageModelTargets(config, { imageModelTargets: [] }), []);
    assert.equal(resolveGenerationModel(config, "a::image-a", "image", []), "");
});

test("selection is independent of the default and channel changes are atomic and persisted", async () => {
    const { config, configModule: { useConfigStore } } = environment();
    const store = useConfigStore.getState();
    store.setImageModelTargets(["a::image-a", "b::image-b"]);
    assert.equal(useConfigStore.getState().config.imageModel, "a::image-a");
    store.updateConfig("imageModel", "b::image-b");
    assert.deepEqual(useConfigStore.getState().config.imageModelTargets, ["a::image-a", "b::image-b"]);
    const channels = structuredClone(config.channels);
    channels[0].models.push({ name: "other", capability: "image" });
    store.setChannels(channels);
    store.updateConfig("imageModel", "a::other");
    assert.deepEqual(useConfigStore.getState().config.imageModelTargets, ["a::image-a", "b::image-b"]);
    store.setImageModelTargets([]);
    store.updateConfig("imageModel", "b::image-b");
    assert.deepEqual(useConfigStore.getState().config.imageModelTargets, []);
    const observed = [];
    const unsubscribe = useConfigStore.subscribe((state) => observed.push(state.config));
    store.setChannels([channels[1]]);
    unsubscribe();
    assert.equal(observed.length, 1);
    assert.equal(observed[0].imageModel, "b::image-b");
    assert.deepEqual(observed[0].imageModelTargets, []);
    await useConfigStore.persist.rehydrate();
    assert.equal(useConfigStore.getState().config.channels[0].models[0].alias, "shared-image");
    assert.deepEqual(useConfigStore.getState().config.imageModelTargets, []);
});

test("an explicit empty target list fails closed without a request", async () => {
    const env = environment();
    await assert.rejects(env.api.requestGeneration({ ...env.config, imageModelTargets: [] }, "blocked"));
    assert.equal(env.calls.length, 0);
});

test("proxy routing survives scheduling and unused defaults do not pin a request", async () => {
    const env = environment();
    env.configModule.useConfigStore.getState().updateConfig("proxyEnabled", true);
    const [image] = await env.api.requestGeneration({ ...env.config, imageModelTargets: ["b::image-b"] }, "proxy");
    assert.equal(image.model, "b::image-b");
    assert.equal(env.calls[0].url, "http://127.0.0.1:23210/https://b.example/v1/images/generations");
});

test("channel concurrency defaults to one and clamps explicit values", async () => {
    const { config, configModule: { CONFIG_STORE_KEY, createModelChannel, defaultConfig, normalizeChannelConcurrency, useConfigStore }, stored } = environment();
    assert.equal(defaultConfig.channels[0].maxConcurrency, 1);
    const legacy = createModelChannel({ name: "legacy", baseUrl: "https://old.example", models: [] });
    assert.equal(legacy.maxConcurrency, 1);
    const explicit1 = createModelChannel({ name: "explicit-1", baseUrl: "https://ex1.example", maxConcurrency: 1, models: [] });
    assert.equal(explicit1.maxConcurrency, 1);
    const explicit99 = createModelChannel({ name: "explicit-99", baseUrl: "https://ex99.example", maxConcurrency: 99, models: [] });
    assert.equal(explicit99.maxConcurrency, 20);
    assert.equal(normalizeChannelConcurrency(undefined), 1);
    assert.equal(normalizeChannelConcurrency(0), 1);
    assert.equal(normalizeChannelConcurrency(1), 1);
    assert.equal(normalizeChannelConcurrency(99), 20);
    const persistedConfig = structuredClone(config);
    delete persistedConfig.channels[0].maxConcurrency;
    stored.set(CONFIG_STORE_KEY, JSON.stringify({ state: { config: persistedConfig, webdav: {} }, version: 0 }));
    await useConfigStore.persist.rehydrate();
    assert.equal(useConfigStore.getState().config.channels[0].maxConcurrency, 1);
    const persistedWithoutChannels = structuredClone(config);
    delete persistedWithoutChannels.channels;
    stored.set(CONFIG_STORE_KEY, JSON.stringify({ state: { config: persistedWithoutChannels, webdav: {} }, version: 0 }));
    await useConfigStore.persist.rehydrate();
    assert.equal(useConfigStore.getState().config.channels[0].maxConcurrency, 1);
});
