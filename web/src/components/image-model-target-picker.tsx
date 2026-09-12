import { Checkbox, Popover } from "antd";
import { Network } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { modelOptionAlias, modelOptionChannelName, modelOptionName, normalizeChannelConcurrency, resolveImageModelTargets, selectableModelsByCapability, decodeChannelModel, type AiConfig } from "@/stores/use-config-store";

export function ImageModelTargetPicker({ config, onChange, className, fullWidth = false, onMissingConfig }: {
    config: AiConfig;
    onChange: (targets: string[]) => void;
    className?: string;
    fullWidth?: boolean;
    onMissingConfig?: () => void;
}) {
    const { t } = useTranslation();
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const selected = resolveImageModelTargets(config);
    const groups = useMemo(() => {
        const groups = new Map<string, string[]>();
        for (const value of selectableModelsByCapability(config, "image")) {
            const name = modelOptionAlias(config, value);
            const group = groups.get(name) || [];
            group.push(value);
            groups.set(name, group);
        }
        return Array.from(groups);
    }, [config.channels]);

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (event.target instanceof Node && !trigger.current?.contains(event.target) && !content.current?.contains(event.target)) setOpen(false);
        };
        const closeOther = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) setOpen(false); };
        window.addEventListener("pointerdown", closeOutside, true);
        window.addEventListener("model-picker-open", closeOther);
        return () => {
            window.removeEventListener("pointerdown", closeOutside, true);
            window.removeEventListener("model-picker-open", closeOther);
        };
    }, [open, id]);

    const label = selected.length ? t("imageGeneration.selection", { model: modelOptionAlias(config, selected[0]), count: selected.length }) : t("settingsPanels.model.select");
    return (
        <Popover
            trigger="click"
            placement="bottomLeft"
            open={open}
            onOpenChange={(value) => {
                if (value && !groups.length) return onMissingConfig?.();
                if (value) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: id }));
                setOpen(value);
            }}
            zIndex={1200}
            content={
                <div ref={content} data-canvas-no-zoom data-image-model-target-picker className="thin-scrollbar max-h-80 w-72 max-w-[calc(100vw-48px)] overflow-y-auto" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } }}>
                    {groups.map(([name, targets]) => (
                        <fieldset key={name} className="mb-2 min-w-0 last:mb-0">
                            <legend className="mb-1 max-w-full truncate text-xs text-muted-foreground" title={name}>{name}</legend>
                            {targets.map((target) => {
                                const channel = config.channels.find((item) => item.id === decodeChannelModel(target)?.channelId);
                                const checked = selected.includes(target);
                                return (
                                    <div key={target} className="rounded px-1 py-1.5 hover:bg-black/5 dark:hover:bg-white/10">
                                        <Checkbox className="!flex [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1" checked={checked} disabled={checked && selected.length === 1} onChange={(event) => onChange(event.target.checked ? (name === modelOptionAlias(config, selected[0] || "") ? [...selected, target] : [target]) : selected.filter((value) => value !== target))}>
                                            <span className="flex min-w-0 items-center justify-between gap-2">
                                                <span className="min-w-0 truncate" title={modelOptionName(target)}>{modelOptionChannelName(config, target)}</span>
                                                <span className="shrink-0 text-xs text-muted-foreground">{t("imageGeneration.concurrency", { count: normalizeChannelConcurrency(channel?.maxConcurrency) })}</span>
                                            </span>
                                        </Checkbox>
                                    </div>
                                );
                            })}
                        </fieldset>
                    ))}
                </div>
            }
        >
            <button ref={trigger} type="button" data-image-model-target-picker aria-expanded={open} aria-label={label} title={label} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} className={cn("canvas-composer-model-picker flex h-8 max-w-full items-center gap-2 rounded-md bg-transparent px-2 text-sm hover:bg-black/5 dark:hover:bg-white/10", fullWidth ? "w-full min-w-0" : "min-w-[9rem]", className)}>
                <Network className="size-4 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            </button>
        </Popover>
    );
}
