export type ImageGenerationTarget = { value: string; channelId: string; concurrency: number };

type Job = {
    targets: ImageGenerationTarget[];
    preferred?: string;
    start: (target: ImageGenerationTarget) => void;
};

export class ImageGenerationScheduler {
    private pending: Job[] = [];
    private active = new Map<string, number>();
    private cursor = 0;

    schedule<T>(targets: ImageGenerationTarget[], run: (target: string) => Promise<T>, signal?: AbortSignal, preferred?: string) {
        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            if (!targets.length) return reject(new Error("No image generation targets"));
            const finish = (settle: () => void) => {
                signal?.removeEventListener("abort", abort);
                settle();
            };
            const job: Job = {
                targets,
                preferred: targets.some((target) => target.value === preferred) ? preferred : undefined,
                start: (target) => {
                    this.active.set(target.channelId, (this.active.get(target.channelId) || 0) + 1);
                    Promise.resolve()
                        .then(() => {
                            signal?.throwIfAborted();
                            return run(target.value);
                        })
                        .then(
                            (value) => finish(() => (signal?.aborted ? reject(signal.reason) : resolve(value))),
                            (error) => finish(() => reject(signal?.aborted ? signal.reason : error)),
                        )
                        .finally(() => {
                            const active = (this.active.get(target.channelId) || 1) - 1;
                            if (active) this.active.set(target.channelId, active);
                            else this.active.delete(target.channelId);
                            this.dispatch();
                        });
                },
            };
            const abort = () => {
                const index = this.pending.indexOf(job);
                if (index >= 0) this.pending.splice(index, 1);
                // Running callbacks retain their slot until settled, even when cancellation is ignored.
                finish(() => reject(signal?.reason));
                this.dispatch();
            };
            signal?.addEventListener("abort", abort, { once: true });
            this.pending.push(job);
            this.dispatch();
        });
    }

    private dispatch() {
        for (let index = 0; index < this.pending.length; index += 1) {
            const job = this.pending[index];
            let picked: ImageGenerationTarget | undefined;
            let lowestLoad = Infinity;
            for (let offset = 0; offset < job.targets.length; offset += 1) {
                const target = job.targets[(offset + this.cursor) % job.targets.length];
                if (job.preferred && target.value !== job.preferred) continue;
                const active = this.active.get(target.channelId) || 0;
                const load = active / target.concurrency;
                if (load < 1 && load < lowestLoad) {
                    lowestLoad = load;
                    picked = target;
                }
            }
            if (!picked) continue;
            this.cursor += 1;
            this.pending.splice(index--, 1);
            job.start(picked);
        }
    }
}

// All image entry points in this browser tab share one pool.
export const imageGenerationScheduler = new ImageGenerationScheduler();
