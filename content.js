(() => {
const CONTENT_SCRIPT_GUARD_KEY = '__CLIPSHELF_CONTENT_SCRIPT_INJECTED__';
if (globalThis[CONTENT_SCRIPT_GUARD_KEY]) {
    return;
}
globalThis[CONTENT_SCRIPT_GUARD_KEY] = true;

const MESSAGE_TYPES = {
    CAPTURE_SELECTION: 'CLIPSHELF_CAPTURE_SELECTION',
};

const ACTION_TYPES = {
    FORCE_DISABLE_SELECTION: 'forceDisableSelection',
};

const STORAGE_KEYS = {
    ACTIVE_SHELF_ID: 'activeShelfId',
};

const MIN_SELECTION_SIZE = 1;
const CAPTURE_DELAY_MS = 120;
const OVERLAY_Z_INDEX = 2147483646;

const selectionState = {
    isDragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    activeShelfId: null,
    overlayElement: null,
};

const keyboardState = {
    isSelectionKeyPressed: false,
    isSelectionKeyDown: false,
};

let currentActiveShelfId = null;

// === ストレージ（保存状態）の同期 ===
function normalizeStorageId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function hasActiveShelfId() {
    return Boolean(currentActiveShelfId);
}

// 読み込み時に現在の保存先棚IDを取得
chrome.storage.local.get(STORAGE_KEYS.ACTIVE_SHELF_ID, (result) => {
    currentActiveShelfId = normalizeStorageId(result[STORAGE_KEYS.ACTIVE_SHELF_ID]);
});

// 独立ウィンドウで「保存を終了」などが押された時に状態を同期
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.ACTIVE_SHELF_ID]) {
        currentActiveShelfId = normalizeStorageId(changes[STORAGE_KEYS.ACTIVE_SHELF_ID].newValue);
        if (!hasActiveShelfId()) {
            resetSelectionInteractionState();
        }
    }
});

// === キャプチャ用の青い枠（オーバーレイ）の制御 ===
function createSelectionOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'clipshelf-selection-overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '0px';
    overlay.style.top = '0px';
    overlay.style.width = '0px';
    overlay.style.height = '0px';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = String(OVERLAY_Z_INDEX);
    overlay.style.background = 'rgba(59, 130, 246, 0.24)';
    overlay.style.border = '1px solid rgba(37, 99, 235, 0.95)';
    overlay.style.boxSizing = 'border-box';
    overlay.style.backdropFilter = 'brightness(0.95)';
    return overlay;
}

function getRectFromPoints(startX, startY, currentX, currentY) {
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    return { x, y, width, height };
}

function updateOverlayRect(currentX, currentY) {
    if (!selectionState.overlayElement) return;
    selectionState.lastX = currentX;
    selectionState.lastY = currentY;
    const rect = getRectFromPoints(selectionState.startX, selectionState.startY, currentX, currentY);
    selectionState.overlayElement.style.left = `${rect.x}px`;
    selectionState.overlayElement.style.top = `${rect.y}px`;
    selectionState.overlayElement.style.width = `${rect.width}px`;
    selectionState.overlayElement.style.height = `${rect.height}px`;
}

function removeOverlay() {
    if (selectionState.overlayElement) {
        selectionState.overlayElement.remove();
        selectionState.overlayElement = null;
    }
    document.querySelectorAll('#clipshelf-selection-overlay').forEach(el => el.remove());
}

function resetSelectionInteractionState() {
    selectionState.isDragging = false;
    selectionState.activeShelfId = null;
    removeOverlay();
    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;
}

// === 選択処理のフロー ===
function beginSelection(event, activeShelfId) {
    selectionState.isDragging = true;
    selectionState.startX = event.clientX;
    selectionState.startY = event.clientY;
    selectionState.lastX = event.clientX;
    selectionState.lastY = event.clientY;
    selectionState.activeShelfId = activeShelfId;

    const overlay = createSelectionOverlay();
    selectionState.overlayElement = overlay;
    document.documentElement.appendChild(overlay);
    updateOverlayRect(event.clientX, event.clientY);
}

function endSelection() {
    selectionState.isDragging = false;
    selectionState.activeShelfId = null;
    removeOverlay();
}

function scheduleSelectionCapture(rect, activeShelfId) {
    window.setTimeout(() => {
        chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CAPTURE_SELECTION,
            activeShelfId,
            pageUrl: window.location.href,
            selection: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
            },
        });
    }, CAPTURE_DELAY_MS);
}

function finalizeSelection(eventX, eventY) {
    if (!selectionState.isDragging) return;
    selectionState.isDragging = false;

    const finalX = Number.isFinite(eventX) ? eventX : selectionState.lastX;
    const finalY = Number.isFinite(eventY) ? eventY : selectionState.lastY;
    const activeShelfId = selectionState.activeShelfId || currentActiveShelfId;
    selectionState.activeShelfId = null;

    removeOverlay();

    const rect = getRectFromPoints(selectionState.startX, selectionState.startY, finalX, finalY);
    if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) return;
    if (!activeShelfId) return;

    scheduleSelectionCapture(rect, activeShelfId);
}

// === イベントハンドラ (キーボード・マウス) ===
function isEditableTarget(target) {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function isSelectionShortcutKey(event) {
    return typeof event.key === 'string' && event.key.toLowerCase() === 's';
}

function handleKeyDown(event) {
    if (!hasActiveShelfId() || isEditableTarget(event.target) || !isSelectionShortcutKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    keyboardState.isSelectionKeyDown = true;
    keyboardState.isSelectionKeyPressed = true;
}

function handleKeyUp(event) {
    if (!isSelectionShortcutKey(event)) return;
    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;
    if (!selectionState.isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    finalizeSelection();
}

function handleMouseDown(event) {
    if (!hasActiveShelfId() || event.button !== 0 || !keyboardState.isSelectionKeyPressed || selectionState.isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    beginSelection(event, currentActiveShelfId);
}

function handleMouseMove(event) {
    if (!hasActiveShelfId() || !selectionState.isDragging) return;
    if ((event.buttons & 1) === 0) {
        finalizeSelection();
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateOverlayRect(event.clientX, event.clientY);
}

function handleMouseUp(event) {
    if (!hasActiveShelfId() || !selectionState.isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    finalizeSelection(event.clientX, event.clientY);
}

function blockNativeSelectionWhileDragging(event) {
    if (selectionState.isDragging) {
        event.preventDefault();
        event.stopPropagation();
    }
}

function handleContextMenu(event) {
    if (keyboardState.isSelectionKeyPressed || selectionState.isDragging) {
        event.preventDefault();
        event.stopPropagation();
    }
}

function handleWindowBlur() {
    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;
    if (selectionState.isDragging) endSelection();
}

chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === ACTION_TYPES.FORCE_DISABLE_SELECTION) {
        resetSelectionInteractionState();
    }
});

document.addEventListener('keydown', handleKeyDown, true);
document.addEventListener('keyup', handleKeyUp, true);
document.addEventListener('mousedown', handleMouseDown, true);
document.addEventListener('mousemove', handleMouseMove, true);
document.addEventListener('mouseup', handleMouseUp, true);
document.addEventListener('dragstart', blockNativeSelectionWhileDragging, true);
document.addEventListener('selectstart', blockNativeSelectionWhileDragging, true);
document.addEventListener('contextmenu', handleContextMenu, true);
window.addEventListener('blur', handleWindowBlur, true);

})();