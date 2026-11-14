export const COCOA_LEGAL_DOC_DRAG_TYPE = "application/cocoa-legal-doc";
export const COCOA_LEGAL_FOLDER_DRAG_TYPE = "application/cocoa-legal-folder";

const LEGACY_DOC_DRAG_TYPE = "application/mike-doc";
const LEGACY_FOLDER_DRAG_TYPE = "application/mike-folder";

export function getCocoaLegalDocDragData(dataTransfer: DataTransfer): string {
    return (
        dataTransfer.getData(COCOA_LEGAL_DOC_DRAG_TYPE) ||
        dataTransfer.getData(LEGACY_DOC_DRAG_TYPE)
    );
}

export function getCocoaLegalFolderDragData(dataTransfer: DataTransfer): string {
    return (
        dataTransfer.getData(COCOA_LEGAL_FOLDER_DRAG_TYPE) ||
        dataTransfer.getData(LEGACY_FOLDER_DRAG_TYPE)
    );
}

export function hasCocoaLegalDragPayload(dataTransfer: DataTransfer): boolean {
    const types = Array.from(dataTransfer.types);
    return [
        COCOA_LEGAL_DOC_DRAG_TYPE,
        COCOA_LEGAL_FOLDER_DRAG_TYPE,
        LEGACY_DOC_DRAG_TYPE,
        LEGACY_FOLDER_DRAG_TYPE,
    ].some((type) => types.includes(type));
}
