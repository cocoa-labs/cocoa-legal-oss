export const COCO_LEGAL_DOC_DRAG_TYPE = "application/coco-legal-doc";
export const COCO_LEGAL_FOLDER_DRAG_TYPE = "application/coco-legal-folder";

const LEGACY_DOC_DRAG_TYPE = "application/mike-doc";
const LEGACY_FOLDER_DRAG_TYPE = "application/mike-folder";

export function getCocoLegalDocDragData(dataTransfer: DataTransfer): string {
    return (
        dataTransfer.getData(COCO_LEGAL_DOC_DRAG_TYPE) ||
        dataTransfer.getData(LEGACY_DOC_DRAG_TYPE)
    );
}

export function getCocoLegalFolderDragData(dataTransfer: DataTransfer): string {
    return (
        dataTransfer.getData(COCO_LEGAL_FOLDER_DRAG_TYPE) ||
        dataTransfer.getData(LEGACY_FOLDER_DRAG_TYPE)
    );
}

export function hasCocoLegalDragPayload(dataTransfer: DataTransfer): boolean {
    const types = Array.from(dataTransfer.types);
    return [
        COCO_LEGAL_DOC_DRAG_TYPE,
        COCO_LEGAL_FOLDER_DRAG_TYPE,
        LEGACY_DOC_DRAG_TYPE,
        LEGACY_FOLDER_DRAG_TYPE,
    ].some((type) => types.includes(type));
}
