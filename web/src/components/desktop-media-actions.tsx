import { App, Button, Dropdown } from "antd";
import { Copy, FolderOpen, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { isDesktopMediaLibrary, readDesktopMediaInfo, revealDesktopMedia } from "@/services/desktop-media-storage";

export function DesktopMediaActions({ storageKey, className }: { storageKey?: string; className?: string }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    if (!storageKey || !isDesktopMediaLibrary()) return null;

    const reveal = async () => {
        try {
            await revealDesktopMedia(storageKey);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.mediaActionFailed"));
        }
    };
    const copyPath = async () => {
        try {
            const info = await readDesktopMediaInfo(storageKey);
            if (!info.filePath) throw new Error(t("common.mediaActionFailed"));
            copyText(info.filePath, t("common.pathCopied"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.mediaActionFailed"));
        }
    };

    return (
        <Dropdown
            trigger={["click"]}
            menu={{
                items: [
                    { key: "reveal", icon: <FolderOpen className="size-4" />, label: t("common.showInFolder") },
                    { key: "copy", icon: <Copy className="size-4" />, label: t("common.copyPath") },
                ],
                onClick: ({ key }) => void (key === "reveal" ? reveal() : copyPath()),
            }}
        >
            <Button className={className} size="small" type="text" icon={<MoreHorizontal className="size-4" />} aria-label={t("common.fileActions")} />
        </Dropdown>
    );
}
