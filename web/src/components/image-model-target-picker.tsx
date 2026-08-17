import { Checkbox, Popover } from "antd";
import { Network } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { decodeChannelModel, modelOptionName, normalizeImageModelTargets, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

type ImageModelTargetPickerProps = {
    config: AiConfig;
    value?: string[];
    onChange: (targets: string[]) => void;
    className?: string;
    fullWidth?: boolean;
    onMissingConfig?: () => void;
};

export function ImageModelTargetPicker({ config, value, onChange, className, fullWidth = false, onMissingConfig }: ImageModelTargetPickerProps) {
    const { t } = useTranslation();
    const options = useMemo(() => selectableModelsByCapability(config, "image"), [config]);
    const selected = normalizeImageModelTargets(value?.[0] || config.imageModel, value, config.channels);
    const currentName = modelOptionName(selected[0] || "");
    const groups = useMemo(() => {
        const result = new Map<string, string[]>();
        options.forEach((option) => result.set(modelOptionName(option), [...(result.get(modelOptionName(option)) || []), option]));
        return Array.from(result.entries());
    }, [options]);

    const toggle = (target: string, checked: boolean) => {
        const nextModelName = modelOptionName(target);
        if (nextModelName !== currentName) return void onChange([target]);
        if (checked) return void onChange(normalizeImageModelTargets(selected[0] || target, [...selected, target], config.channels));
        const next = selected.filter((item) => item !== target);
        if (next.length) onChange(next);
    };

    const content = options.length ? (
        <div className="thin-scrollbar max-h-80 w-80 overflow-y-auto p-1">
            {groups.map(([modelName, targets]) => (
                <section key={modelName} className="py-1">
                    <div className="px-2 py-1 text-xs font-medium text-stone-500">{modelName}</div>
                    {targets.map((target) => {
                        const channelId = decodeChannelModel(target)?.channelId;
                        const channel = config.channels.find((item) => item.id === channelId);
                        const checked = selected.includes(target);
                        return (
                            <label key={target} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10">
                                <Checkbox checked={checked} onChange={(event) => toggle(target, event.target.checked)} />
                                <span className="min-w-0 flex-1 truncate">{channel?.name || channelId}</span>
                                <span className="shrink-0 text-xs text-stone-500">{t("imageChannelPicker.concurrency", { count: channel?.maxConcurrency || 1 })}</span>
                            </label>
                        );
                    })}
                </section>
            ))}
        </div>
    ) : (
        <div className="w-64 p-3 text-sm text-stone-500">{t("imageChannelPicker.empty")}</div>
    );

    return (
        <Popover content={content} trigger="click" placement="bottomLeft">
            <button
                type="button"
                className={cn(
                    "canvas-composer-model-picker flex h-8 min-w-[9rem] max-w-full items-center justify-start gap-2 rounded-full border border-input bg-transparent px-3 text-sm shadow-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10",
                    fullWidth && "w-full min-w-0",
                    className,
                )}
                title={currentName ? t("imageChannelPicker.summary", { model: currentName, count: selected.length }) : t("settingsPanels.model.select")}
                onClick={() => {
                    if (!options.length) onMissingConfig?.();
                }}
            >
                <Network className="size-4 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate text-left">{currentName ? t("imageChannelPicker.summary", { model: currentName, count: selected.length }) : t("settingsPanels.model.select")}</span>
            </button>
        </Popover>
    );
}
