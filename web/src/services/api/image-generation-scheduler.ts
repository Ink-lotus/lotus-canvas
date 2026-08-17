import { decodeChannelModel, normalizeChannelConcurrency, normalizeImageModelTargets, type AiConfig } from "@/stores/use-config-store";

type ScheduledImageResult<T> = { value: T; target: string };
type PendingJob<T> = {
    config: AiConfig;
    targets: string[];
    signal?: AbortSignal;
    run: (target: string) => Promise<T>;
    resolve: (result: ScheduledImageResult<T>) => void;
    reject: (error: unknown) => void;
    started: boolean;
};

class ImageGenerationScheduler {
    private pending: PendingJob<unknown>[] = [];
    private activeByChannel = new Map<string, number>();
    private cursor = 0;

    schedule<T>(config: AiConfig, targets: string[], run: (target: string) => Promise<T>, signal?: AbortSignal) {
        const normalizedTargets = normalizeImageModelTargets(targets[0] || config.imageModel, targets, config.channels);
        if (!normalizedTargets.length) return Promise.reject(new Error("没有可用的图片生成渠道"));
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise<ScheduledImageResult<T>>((resolve, reject) => {
            const job: PendingJob<T> = { config, targets: normalizedTargets, signal, run, resolve, reject, started: false };
            const abort = () => {
                if (job.started) return;
                const index = this.pending.indexOf(job as PendingJob<unknown>);
                if (index >= 0) this.pending.splice(index, 1);
                reject(abortError());
            };
            signal?.addEventListener("abort", abort, { once: true });
            const wrappedResolve = job.resolve;
            const wrappedReject = job.reject;
            job.resolve = (value) => {
                signal?.removeEventListener("abort", abort);
                wrappedResolve(value);
            };
            job.reject = (error) => {
                signal?.removeEventListener("abort", abort);
                wrappedReject(error);
            };
            this.pending.push(job as PendingJob<unknown>);
            this.dispatch();
        });
    }

    private dispatch() {
        let dispatched = true;
        while (dispatched) {
            dispatched = false;
            for (let index = 0; index < this.pending.length; index += 1) {
                const job = this.pending[index];
                if (job.signal?.aborted) {
                    this.pending.splice(index, 1);
                    index -= 1;
                    job.reject(abortError());
                    continue;
                }
                const target = this.pickTarget(job);
                if (!target) continue;
                this.pending.splice(index, 1);
                this.start(job, target);
                dispatched = true;
                break;
            }
        }
    }

    private pickTarget(job: PendingJob<unknown>) {
        const candidates = job.targets.flatMap((target, index) => {
            const channelId = decodeChannelModel(target)?.channelId;
            const channel = job.config.channels.find((item) => item.id === channelId);
            if (!channelId || !channel) return [];
            const active = this.activeByChannel.get(channelId) || 0;
            const capacity = normalizeChannelConcurrency(channel.maxConcurrency);
            return active < capacity ? [{ target, channelId, active, capacity, order: (index - this.cursor + job.targets.length) % job.targets.length }] : [];
        });
        candidates.sort((a, b) => a.active / a.capacity - b.active / b.capacity || a.order - b.order);
        const picked = candidates[0];
        if (!picked) return null;
        this.cursor = (job.targets.indexOf(picked.target) + 1) % job.targets.length;
        return picked;
    }

    private start(job: PendingJob<unknown>, target: { target: string; channelId: string }) {
        job.started = true;
        this.activeByChannel.set(target.channelId, (this.activeByChannel.get(target.channelId) || 0) + 1);
        Promise.resolve()
            .then(() => job.run(target.target))
            .then((value) => job.resolve({ value, target: target.target }), job.reject)
            .finally(() => {
                const active = (this.activeByChannel.get(target.channelId) || 1) - 1;
                if (active > 0) this.activeByChannel.set(target.channelId, active);
                else this.activeByChannel.delete(target.channelId);
                this.dispatch();
            });
    }
}

const scheduler = new ImageGenerationScheduler();

export function scheduleImageGeneration<T>(config: AiConfig, targets: string[], run: (target: string) => Promise<T>, signal?: AbortSignal) {
    return scheduler.schedule(config, targets, run, signal);
}

function abortError() {
    return new DOMException("Aborted", "AbortError");
}
