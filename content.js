(() => {
const CONTENT_SCRIPT_GUARD_KEY = '__CLIPSHELF_CONTENT_SCRIPT_INJECTED__';
if (globalThis[CONTENT_SCRIPT_GUARD_KEY]) {
    return;
}
globalThis[CONTENT_SCRIPT_GUARD_KEY] = true;

const MESSAGE_TYPES = {
    CAPTURE_SELECTION: 'CLIPSHELF_CAPTURE_SELECTION',
    GET_UI_MODEL: 'CLIPSHELF_GET_UI_MODEL',
    CREATE_GROUP: 'CLIPSHELF_CREATE_GROUP',
    RENAME_GROUP: 'CLIPSHELF_RENAME_GROUP',
    DELETE_GROUP: 'CLIPSHELF_DELETE_GROUP',
    SET_ACTIVE_GROUP: 'CLIPSHELF_SET_ACTIVE_GROUP',
    END_SAVE_MODE: 'CLIPSHELF_END_SAVE_MODE',
    DELETE_SCREENSHOT: 'CLIPSHELF_DELETE_SCREENSHOT',
};

const EVENT_TYPES = {
    SCREENSHOT_SAVED: 'CLIPSHELF_SCREENSHOT_SAVED',
};

const ACTION_TYPES = {
    OPEN_OR_SWITCH_TAB: 'openOrSwitchTab',
    TOGGLE_UI: 'toggleUI',
    CLOSE_ALL_UIS: 'closeAllUIs',
    FORCE_CLOSE_UI: 'forceCloseUI',
    FORCE_DISABLE_SELECTION: 'forceDisableSelection',
};

const STORAGE_KEYS = {
    IS_UI_OPEN: 'isUiOpen',
    UI_PANEL_HEIGHT: 'uiPanelHeight',
    UI_PANEL_WIDTH: 'uiPanelWidth',  
    UI_PANEL_LEFT: 'uiPanelLeft',    
    UI_PANEL_TOP: 'uiPanelTop',
    UI_PANEL_LEFT: 'uiPanelLeft', 
    UI_PANEL_TOP: 'uiPanelTop',
    ACTIVE_GROUP_ID: 'activeGroupId',
    ACTIVE_SHELF_ID: 'activeShelfId',
    GROUPS_METADATA: 'groupsMetadata',
};

const MIN_SELECTION_SIZE = 1;
const MIN_PANEL_WIDTH = 340;
const MIN_PANEL_HEIGHT = 200;
const CAPTURE_DELAY_MS = 120;
// Temporary thresholds for verification; switch to 5000/10000 for production.
const SCREENSHOT_WARNING_THRESHOLD = 5000;
const SCREENSHOT_DANGER_THRESHOLD = 10000;
const OVERLAY_Z_INDEX = 2147483646;
const UI_Z_INDEX = 2147483647;
const UI_HOST_ID = 'clipshelf-ui-host';
const INITIAL_UI_SKIP_FLAG = '__CLIPSHELF_SKIP_INITIAL_UI_STATE';

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
let activeShelfLoadPromise = null;
let isActiveShelfStateInitialized = false;

const uiState = {
    hostElement: null,
    uiPanelHeight: null,
    uiPanelLeft: null,
    uiPanelTop: null,
    shadowRoot: null,
    panelElement: null,
    isUiOpen: false,
    uiPosition: 'bottom',
    model: null,
    objectUrls: new Set(),
    editingGroupId: null,
    lightboxElement: null,
    lightboxUrl: null,
    lastError: '',
    dismissedStorageWarningLevel: null,
};

const moveState = {
    isMoving: false,
    startX: 0,
    startY: 0,
    initialLeft: 0,
    initialTop: 0,
};

const resizeState = {
    isResizing: false,
    direction: '',
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,
};

function getLocalStorage(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve(result);
        });
    });
}

function setLocalStorage(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve();
        });
    });
}

function sendRuntimeMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                type,
                ...payload,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!response || response.ok !== true) {
                    reject(new Error(response?.error || i18nMessage('uiErrorBackgroundRequestFailed')));
                    return;
                }

                resolve(response.data);
            },
        );
    });
}

function sendRuntimeActionMessage(action, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                action,
                ...payload,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!response || response.ok !== true) {
                    reject(new Error(response?.error || i18nMessage('uiErrorBackgroundRequestFailed')));
                    return;
                }

                resolve(response.data);
            },
        );
    });
}

async function requestCloseAllUis() {
    await sendRuntimeActionMessage(ACTION_TYPES.CLOSE_ALL_UIS);
}

function normalizeUiPosition(value) {
    return value === 'top' ? 'top' : 'bottom';
}

function normalizeStorageId(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveActiveShelfIdFromStorage(values) {
    return normalizeStorageId(values?.[STORAGE_KEYS.ACTIVE_SHELF_ID]);
}

function hasActiveShelfId() {
    return Boolean(currentActiveShelfId);
}

function isSelectionModeReady() {
    return isActiveShelfStateInitialized;
}

function canUseSelectionMode() {
    return isSelectionModeReady() && hasActiveShelfId();
}

async function syncActiveShelfIdFromStorage() {
    if (activeShelfLoadPromise) {
        return activeShelfLoadPromise;
    }

    activeShelfLoadPromise = getLocalStorage(STORAGE_KEYS.ACTIVE_SHELF_ID)
        .then((values) => {
            currentActiveShelfId = resolveActiveShelfIdFromStorage(values);
            return currentActiveShelfId;
        })
        .finally(() => {
            activeShelfLoadPromise = null;
            isActiveShelfStateInitialized = true;
        });

    return activeShelfLoadPromise;
}

function i18nMessage(key, substitutions) {
    const message = chrome.i18n.getMessage(key, substitutions);
    return typeof message === 'string' ? message : '';
}

function getStorageWarningLevel(totalScreenshotCount) {
    if (!Number.isFinite(totalScreenshotCount)) {
        return null;
    }

    if (totalScreenshotCount >= SCREENSHOT_DANGER_THRESHOLD) {
        return 'danger';
    }

    if (totalScreenshotCount >= SCREENSHOT_WARNING_THRESHOLD) {
        return 'warning';
    }

    return null;
}

function getStorageWarningMessage(level, totalScreenshotCount) {
    if (level === 'danger') {
        return i18nMessage('uiStorageDangerCount', [
            String(totalScreenshotCount),
            String(SCREENSHOT_DANGER_THRESHOLD),
        ]);
    }

    return i18nMessage('uiStorageWarningCount', [
        String(totalScreenshotCount),
        String(SCREENSHOT_WARNING_THRESHOLD),
    ]);
}

function createTrackedObjectUrl(blob) {
    if (!(blob instanceof Blob)) {
        return null;
    }

    const objectUrl = URL.createObjectURL(blob);
    uiState.objectUrls.add(objectUrl);
    return objectUrl;
}

function resolveScreenshotImageSource(screenshot) {
    if (!screenshot || typeof screenshot !== 'object') {
        return null;
    }

    if (typeof screenshot.imageDataUrl === 'string' && screenshot.imageDataUrl.startsWith('data:')) {
        return screenshot.imageDataUrl;
    }

    return createTrackedObjectUrl(screenshot.imageBlob);
}

function closeLightbox() {
    if (uiState.lightboxElement) {
        uiState.lightboxElement.remove();
        uiState.lightboxElement = null;
    }

    if (uiState.lightboxUrl) {
        URL.revokeObjectURL(uiState.lightboxUrl);
        uiState.objectUrls.delete(uiState.lightboxUrl);
        uiState.lightboxUrl = null;
    }
}

function revokeAllObjectUrls() {
    uiState.objectUrls.forEach((url) => {
        URL.revokeObjectURL(url);
    });
    uiState.objectUrls.clear();
    uiState.lightboxUrl = null;
}

function applyUiHostPosition() {
    if (!uiState.hostElement || !uiState.panelElement) return;

    uiState.hostElement.style.position = 'fixed';
    uiState.hostElement.style.bottom = 'auto';
    uiState.hostElement.style.right = 'auto';
    uiState.hostElement.style.width = 'max-content';

    let width = uiState.uiPanelWidth || 420;
    let height = uiState.uiPanelHeight || 200;
    let left = uiState.uiPanelLeft;
    let top = uiState.uiPanelTop;

    // 座標が未保存の場合は、画面下部の中央に配置
    if (left === null || top === null) {
        left = Math.max(0, (window.innerWidth - width) / 2);
        top = Math.max(0, window.innerHeight - height - 20); // 画面下から20px浮かす
    }

    uiState.hostElement.style.left = `${left}px`;
    uiState.hostElement.style.top = `${top}px`;
    uiState.panelElement.style.width = `${width}px`;
    uiState.panelElement.style.height = `${height}px`;
}

// === ウィンドウ移動処理 ===
function handlePanelMoveStart(event) {
    // 左クリック以外、またはボタンやリサイズ枠をクリックした場合は無視
    if (event.button !== 0 || event.target.closest('button, input, .resizer')) return;
    
    moveState.isMoving = true;
    moveState.startX = event.clientX;
    moveState.startY = event.clientY;
    
    const rect = uiState.hostElement.getBoundingClientRect();
    moveState.initialLeft = rect.left;
    moveState.initialTop = rect.top;

    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handlePanelMove);
    window.addEventListener('mouseup', handlePanelMoveEnd);
}

function handlePanelMove(event) {
    if (!moveState.isMoving) return;
    event.preventDefault();

    const deltaX = event.clientX - moveState.startX;
    const deltaY = event.clientY - moveState.startY;

    let newLeft = moveState.initialLeft + deltaX;
    let newTop = moveState.initialTop + deltaY;

    // 画面外への飛び出し防止
    const hostRect = uiState.hostElement.getBoundingClientRect();
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - hostRect.width));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - hostRect.height));

    uiState.hostElement.style.left = `${newLeft}px`;
    uiState.hostElement.style.top = `${newTop}px`;
}

async function handlePanelMoveEnd(event) {
    if (!moveState.isMoving) return;
    moveState.isMoving = false;
    document.body.style.userSelect = '';

    window.removeEventListener('mousemove', handlePanelMove);
    window.removeEventListener('mouseup', handlePanelMoveEnd);

    const rect = uiState.hostElement.getBoundingClientRect();
    uiState.uiPanelLeft = rect.left;
    uiState.uiPanelTop = rect.top;

    await setLocalStorage({
        [STORAGE_KEYS.UI_PANEL_LEFT]: rect.left,
        [STORAGE_KEYS.UI_PANEL_TOP]: rect.top
    });
}

// === ウィンドウサイズ変更処理 ===
function handlePanelResizeStart(event, direction) {
    if (event.button !== 0) return;
    event.stopPropagation();

    resizeState.isResizing = true;
    resizeState.direction = direction;
    resizeState.startX = event.clientX;
    resizeState.startY = event.clientY;

    const hostRect = uiState.hostElement.getBoundingClientRect();
    resizeState.startLeft = hostRect.left;
    resizeState.startTop = hostRect.top;
    
    resizeState.startWidth = uiState.panelElement.offsetWidth;
    resizeState.startHeight = uiState.panelElement.offsetHeight;

    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handlePanelResizeMove);
    window.addEventListener('mouseup', handlePanelResizeEnd);
}

function handlePanelResizeMove(event) {
    if (!resizeState.isResizing) return;
    event.preventDefault();

    const dx = event.clientX - resizeState.startX;
    const dy = event.clientY - resizeState.startY;

    let newWidth = resizeState.startWidth;
    let newHeight = resizeState.startHeight;
    let newLeft = resizeState.startLeft;
    let newTop = resizeState.startTop;

    const dir = resizeState.direction;

    if (dir.includes('e')) newWidth = resizeState.startWidth + dx;
    if (dir.includes('s')) newHeight = resizeState.startHeight + dy;
    if (dir.includes('w')) {
        newWidth = resizeState.startWidth - dx;
        newLeft = resizeState.startLeft + dx;
    }
    if (dir.includes('n')) {
        newHeight = resizeState.startHeight - dy;
        newTop = resizeState.startTop + dy;
    }

    // 最小サイズの制限
    if (newWidth < MIN_PANEL_WIDTH) {
        if (dir.includes('w')) newLeft -= (MIN_PANEL_WIDTH - newWidth);
        newWidth = MIN_PANEL_WIDTH;
    }
    if (newHeight < MIN_PANEL_HEIGHT) {
        if (dir.includes('n')) newTop -= (MIN_PANEL_HEIGHT - newHeight);
        newHeight = MIN_PANEL_HEIGHT;
    }

    uiState.panelElement.style.width = `${newWidth}px`;
    uiState.panelElement.style.height = `${newHeight}px`;
    uiState.hostElement.style.left = `${newLeft}px`;
    uiState.hostElement.style.top = `${newTop}px`;
}

async function handlePanelResizeEnd(event) {
    if (!resizeState.isResizing) return;
    resizeState.isResizing = false;
    document.body.style.userSelect = '';

    window.removeEventListener('mousemove', handlePanelResizeMove);
    window.removeEventListener('mouseup', handlePanelResizeEnd);

    if (uiState.panelElement && uiState.hostElement) {
        const finalWidth = uiState.panelElement.offsetWidth;
        const finalHeight = uiState.panelElement.offsetHeight;
        const finalLeft = parseFloat(uiState.hostElement.style.left) || 0;
        const finalTop = parseFloat(uiState.hostElement.style.top) || 0;

        uiState.uiPanelWidth = finalWidth;
        uiState.uiPanelHeight = finalHeight;
        uiState.uiPanelLeft = finalLeft;
        uiState.uiPanelTop = finalTop;

        await setLocalStorage({
            [STORAGE_KEYS.UI_PANEL_WIDTH]: finalWidth,
            [STORAGE_KEYS.UI_PANEL_HEIGHT]: finalHeight,
            [STORAGE_KEYS.UI_PANEL_LEFT]: finalLeft,
            [STORAGE_KEYS.UI_PANEL_TOP]: finalTop
        });
    }
}

function ensureUiHost() {
    if (uiState.hostElement && uiState.shadowRoot && uiState.panelElement) {
        applyUiHostPosition();
        return;
    }

    const host = document.createElement('div');
    host.id = UI_HOST_ID;
    host.style.position = 'fixed';
    host.style.left = '12px';
    host.style.right = '12px';
    host.style.zIndex = String(UI_Z_INDEX);
    host.style.pointerEvents = 'none';

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
		:host {
			all: initial;
		}

		*,
		*::before,
		*::after {
			box-sizing: border-box;
		}

		.shell {
			pointer-events: none;
		}

		.panel {
			--ink: #1f2933;
			--muted: #5c6674;
			--line: #d8e3f3;
			--card: rgba(255, 255, 255, 0.78);
			--accent: #0f766e;
			--accent-strong: #0b5e58;
			--danger: #c2410c;
			pointer-events: auto;
			color: var(--ink);
			font-family: "Avenir Next", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
			position: relative; /* リサイズハンドルの基準として追加 */
			width: 420px; /* デフォルト幅 */
			min-width: 340px; /* 最小幅 */
			min-height: 200px;
			/*margin-inline: auto;*/
			border: 1px solid var(--line);
			border-radius: 18px;
			background: linear-gradient(155deg, #fff8ec 0%, #eef5ff 52%, #f4fff9 100%);
			box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
			backdrop-filter: blur(4px);
			display: flex;
			flex-direction: column;
            min-height: 200px;
            max-height: 85vh;
			overflow: hidden;
            width: min(90vw, 420px); 
            margin: 0;
		}

		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
            cursor: grab;
            user-select: none;
            padding: 3px 8px;
			border-bottom: 1px solid var(--line);
			background: linear-gradient(90deg, rgba(255, 255, 255, 0.55) 0%, rgba(239, 246, 255, 0.72) 100%);
            font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.02em;
		}

        .panel-header:active {
            cursor: grabbing; /* ドラッグ中は掴むカーソル */
        }

        .resizer {
            position: absolute;
            z-index: 10;
        }
        .resizer-n { top: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
        .resizer-s { bottom: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
        .resizer-e { top: 10px; bottom: 10px; right: 0; width: 6px; cursor: ew-resize; }
        .resizer-w { top: 10px; bottom: 10px; left: 0; width: 6px; cursor: ew-resize; }
        .resizer-nw { top: 0; left: 0; width: 10px; height: 10px; cursor: nwse-resize; }
        .resizer-ne { top: 0; right: 0; width: 10px; height: 10px; cursor: nesw-resize; }
        .resizer-sw { bottom: 0; left: 0; width: 10px; height: 10px; cursor: nesw-resize; }
        .resizer-se { bottom: 0; right: 0; width: 10px; height: 10px; cursor: nwse-resize; }

        .panel-body {
            padding: 3px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            gap: 3px;
            flex: 1;          /* 伸び縮み可能にする */
            min-height: 0;    /* 内部スクロールを有効 */
        }

        .panel-title {
            font-size: 12px;
            font-weight: 700;
            line-height: 1.1;
        }

		.panel-pos {
            font-size: 9px;
			color: var(--muted);
			font-weight: 600;
			background: rgba(255, 255, 255, 0.85);
			border: 1px solid var(--line);
			border-radius: 999px;
            padding: 1px 5px;
		}

        .panel-header-actions {
            display: flex;
            align-items: center;
            gap: 3px;
        }

        .panel-close {
            width: 22px;
            height: 22px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.75);
            background: rgba(15, 23, 42, 0.76);
            color: #fff;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            padding: 0;
            display: grid;
            place-items: center;
            cursor: pointer;
            transition: transform 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease;
        }

        .panel-close:hover {
            transform: translateY(-1px);
            background: rgba(194, 65, 12, 0.95);
            box-shadow: 0 8px 16px rgba(194, 65, 12, 0.22);
        }

        .panel-close:focus-visible {
            outline: 2px solid rgba(15, 118, 110, 0.35);
            outline-offset: 1px;
        }

        .storage-alert {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 4px;
            margin: 3px 3px 0;
            padding: 3px 6px;
            border-radius: 8px;
            border: 1px solid transparent;
        }

        .storage-alert.warning {
            background: rgba(254, 243, 199, 0.95);
            border-color: rgba(217, 119, 6, 0.42);
            color: #92400e;
        }

        .storage-alert.danger {
            background: rgba(254, 226, 226, 0.95);
            border-color: rgba(220, 38, 38, 0.42);
            color: #991b1b;
        }

        .storage-alert-text {
            margin: 0;
            font-size: 10px;
            line-height: 1.3;
            font-weight: 700;
            flex: 1;
        }

        .storage-alert-close {
            width: 18px;
            height: 18px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.75);
            background: rgba(15, 23, 42, 0.76);
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            padding: 0;
            display: grid;
            place-items: center;
            cursor: pointer;
            flex-shrink: 0;
            transition: transform 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease;
        }

        .storage-alert-close:hover {
            transform: translateY(-1px);
            background: rgba(194, 65, 12, 0.95);
            box-shadow: 0 8px 16px rgba(194, 65, 12, 0.22);
        }

        .storage-alert-close:focus-visible {
            outline: 2px solid rgba(15, 118, 110, 0.35);
            outline-offset: 1px;
        }

		.panel-body {
            padding: 3px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            gap: 3px;
            flex: 1;          /* 伸び縮み可能にする */
            min-height: 0;    /* 内部スクロールを有効 */
        }

		.section {
			border: 1px solid var(--line);
            border-radius: 10px;
            padding: 3px;
			background: var(--card);
            flex: 0 0 auto;
            display: flex;
            flex-direction: column;
		}

        .section.scrollable {
            flex: 1 1 0;
            min-height: 0;
        }

		.section-title {
            margin: 0 0 2px;
            font-size: 11px;
			color: var(--muted);
			font-weight: 700;
			letter-spacing: 0.01em;
            flex-shrink: 0;
		}

		.inline-row {
			display: flex;
			align-items: center;
            gap: 3px;
			flex-wrap: wrap;
		}

        .active-group-row {
            justify-content: space-between;
            flex-wrap: nowrap;
            min-width: 0;
        }

        .active-group-meta {
            display: flex;
            align-items: center;
            gap: 3px;
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }

        .active-group-actions {
            display: flex;
            gap: 3px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

		.input,
		.rename-input {
            min-width: 140px;
			flex: 1;
			border: 1px solid #cdd8e9;
			border-radius: 9px;
            padding: 3px 7px;
            font-size: 11px;
			color: var(--ink);
			background: rgba(255, 255, 255, 0.92);
		}

		.input:focus,
		.rename-input:focus {
			outline: 2px solid rgba(15, 118, 110, 0.25);
			outline-offset: 0;
			border-color: var(--accent);
		}

		.btn {
			border: 1px solid transparent;
			border-radius: 9px;
            padding: 3px 7px;
            font-size: 10px;
			font-weight: 700;
			cursor: pointer;
			transition: transform 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease;
			color: #fff;
			background: var(--accent);
			white-space: nowrap;
		}

		.btn:hover {
			transform: translateY(-1px);
			box-shadow: 0 8px 16px rgba(15, 118, 110, 0.22);
			background: var(--accent-strong);
		}

		.btn.secondary {
			background: #e2e8f0;
			color: #334155;
			border-color: #cbd5e1;
			box-shadow: none;
		}

		.btn.secondary:hover {
			background: #d6deea;
		}

		.btn.danger {
			background: var(--danger);
		}

		.btn.danger:hover {
			background: #9a3412;
			box-shadow: 0 8px 16px rgba(194, 65, 12, 0.22);
		}

		.group-list {
			display: grid;
            gap: 3px;
            overflow-y: auto;
            flex: 1;
            min-height: 0;
            align-content: start;
		}

		.group-item {
			border: 1px solid #d5dfef;
			background: rgba(255, 255, 255, 0.9);
			border-radius: 10px;
            padding: 3px;
			display: grid;
            gap: 3px;
			cursor: pointer;
		}

		.group-item:hover {
			border-color: #9fb5d4;
			background: rgba(255, 255, 255, 0.98);
		}

		.group-item-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
            gap: 3px;
			min-width: 0;
		}

		.group-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
            font-size: 12px;
			font-weight: 700;
		}

		.count-pill {
            font-size: 9px;
			border-radius: 999px;
            padding: 1px 7px;
			background: rgba(15, 118, 110, 0.14);
			color: #0b5e58;
			border: 1px solid rgba(15, 118, 110, 0.22);
			flex-shrink: 0;
			font-weight: 700;
		}

		.group-controls {
			display: flex;
            gap: 2px;
			flex-wrap: wrap;
		}

		.thumb-grid {
			display: grid;
            grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
            gap: 3px;
        }

        .thumb-scroll {
            overflow-y: visible;
            padding-right: 2px;
            flex: 1;
            min-height: 0;
		}

		.thumb-item {
			position: relative;
			border: 1px solid #d6deea;
			border-radius: 10px;
			overflow: hidden;
			background: #ffffff;
			cursor: pointer;
		}

		.thumb-item img {
			width: 100%;
            height: 80px;
			object-fit: cover;
			display: block;
			background: #f1f5f9;
		}

		.thumb-meta {
			display: block;
            padding: 1px 4px 2px;
            font-size: 8px;
			color: #64748b;
			text-overflow: ellipsis;
			overflow: hidden;
			white-space: nowrap;
		}

		.thumb-delete {
			position: absolute;
			top: 5px;
			right: 5px;
			width: 22px;
			height: 22px;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.75);
			background: rgba(15, 23, 42, 0.76);
			color: #fff;
			font-size: 12px;
			font-weight: 700;
			cursor: pointer;
			display: grid;
			place-items: center;
		}

		.thumb-delete:hover {
			background: rgba(194, 65, 12, 0.95);
		}

		.empty {
			color: var(--muted);
            font-size: 11px;
            line-height: 1.35;
			margin: 0;
		}

		.status-error {
			border: 1px solid rgba(194, 65, 12, 0.3);
			color: #9a3412;
			background: rgba(255, 237, 213, 0.8);
			border-radius: 9px;
            padding: 4px 8px;
            font-size: 11px;
			font-weight: 600;
		}

		.footer-actions {
			display: flex;
            gap: 3px;
			flex-wrap: wrap;
			justify-content: flex-end;
		}

		.lightbox {
			position: fixed;
			inset: 0;
			background: rgba(8, 15, 29, 0.72);
			display: grid;
			place-items: center;
			padding: 20px;
			pointer-events: auto;
			animation: fadeIn 0.14s ease;
		}

		.lightbox-inner {
			position: relative;
			width: min(88vw, 980px);
			max-height: 86vh;
			border-radius: 14px;
			overflow: hidden;
			background: #fff;
			border: 1px solid #d6deea;
			box-shadow: 0 18px 36px rgba(15, 23, 42, 0.35);
		}

		.lightbox-image {
			width: 100%;
			height: auto;
			max-height: 86vh;
			object-fit: contain;
			display: block;
			background: #f8fafc;
		}

		.lightbox-actions {
			position: absolute;
			top: 8px;
			left: 8px;
			right: 8px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 8px;
			pointer-events: none;
		}

		.lightbox-actions .btn {
			pointer-events: auto;
			box-shadow: 0 8px 20px rgba(15, 23, 42, 0.35);
		}

        .lightbox-open-link {
            background: rgba(15, 23, 42, 0.9);
            color: #f8fafc;
            border: 1px solid rgba(148, 163, 184, 0.58);
            font-size: 12px;
            padding: 7px 11px;
            line-height: 1.2;
            text-shadow: 0 1px 1px rgba(15, 23, 42, 0.45);
        }

        .lightbox-open-link:hover {
            background: rgba(194, 65, 12, 0.95);
            border-color: rgba(255, 255, 255, 0.75);
            box-shadow: 0 8px 20px rgba(194, 65, 12, 0.28);
        }

        .lightbox-open-link:disabled {
            background: rgba(100, 116, 139, 0.72);
            color: #e2e8f0;
            border-color: rgba(148, 163, 184, 0.45);
            cursor: not-allowed;
            box-shadow: none;
            transform: none;
        }

        .lightbox-close {
            pointer-events: auto;
            width: clamp(26px, 2.7vw, 34px);
            height: clamp(26px, 2.7vw, 34px);
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.75);
            background: rgba(15, 23, 42, 0.76);
            color: #fff;
            font-size: clamp(15px, 1.8vw, 20px);
            font-weight: 700;
            line-height: 1;
            padding: 0;
            display: grid;
            place-items: center;
            cursor: pointer;
            box-shadow: 0 8px 20px rgba(15, 23, 42, 0.35);
            transition: transform 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease;
        }

        .lightbox-close:hover {
            transform: translateY(-1px);
            background: rgba(194, 65, 12, 0.95);
        }

		@keyframes fadeIn {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		@media (max-width: 680px) {
			.panel {
                max-height: 44vh;
			}

			.thumb-grid {
				grid-template-columns: repeat(auto-fill, minmax(94px, 1fr));
			}

            .thumb-scroll {
                max-height: 96px;
            }

			.thumb-item img {
                height: 68px;
			}

			.btn {
                padding: 3px 7px;
			}

			.panel-header {
                padding: 3px 6px;
            }

            .active-group-row {
                flex-wrap: wrap;
            }

            .active-group-actions {
                width: 100%;
                justify-content: flex-start;
			}
		}
	`;

    const shell = document.createElement('div');
    shell.className = 'shell';

    const panel = document.createElement('div');
    panel.className = 'panel';
    shell.appendChild(panel);

    shadow.append(style, shell);
    document.documentElement.appendChild(host);

    uiState.hostElement = host;
    uiState.shadowRoot = shadow;
    uiState.panelElement = panel;

    applyUiHostPosition();
}

function createButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return button;
}

function renderErrorBanner(target) {
    if (!uiState.lastError) {
        return;
    }

    const errorBanner = document.createElement('div');
    errorBanner.className = 'status-error';
    errorBanner.textContent = uiState.lastError;
    target.appendChild(errorBanner);
}

function renderStorageWarning(panel, model) {
    const totalScreenshotCount = Number(model?.totalScreenshotCount);
    const warningLevel = getStorageWarningLevel(totalScreenshotCount);

    if (!warningLevel) {
        uiState.dismissedStorageWarningLevel = null;
        return;
    }

    if (uiState.dismissedStorageWarningLevel === warningLevel) {
        return;
    }

    const warning = document.createElement('div');
    warning.className = `storage-alert ${warningLevel}`;

    const warningText = document.createElement('p');
    warningText.className = 'storage-alert-text';
    warningText.textContent = getStorageWarningMessage(warningLevel, totalScreenshotCount);

    const closeWarningButton = document.createElement('button');
    closeWarningButton.type = 'button';
    closeWarningButton.className = 'storage-alert-close';
    closeWarningButton.textContent = '×';
    closeWarningButton.title = i18nMessage('uiButtonClose');
    closeWarningButton.setAttribute('aria-label', i18nMessage('uiButtonClose'));
    closeWarningButton.addEventListener('click', (event) => {
        event.stopPropagation();
        uiState.dismissedStorageWarningLevel = warningLevel;
        renderUiPanel();
    });

    warning.append(warningText, closeWarningButton);
    panel.appendChild(warning);
}

function renderNoActiveGroupState(panelBody, model) {
    const createSection = document.createElement('section');
    createSection.className = 'section';

    const createTitle = document.createElement('h3');
    createTitle.className = 'section-title';
    createTitle.textContent = i18nMessage('uiCreateNewShelfTitle');
    createSection.appendChild(createTitle);

    const createRow = document.createElement('div');
    createRow.className = 'inline-row';

    const groupNameInput = document.createElement('input');
    groupNameInput.className = 'input';
    groupNameInput.placeholder = i18nMessage('uiEnterShelfNamePlaceholder');
    groupNameInput.maxLength = 80;

    const createButtonElement = createButton(i18nMessage('uiButtonCreate'), 'btn', () => {
        void withUiMutation(async () => {
            await sendRuntimeMessage(MESSAGE_TYPES.CREATE_GROUP, { name: groupNameInput.value });
        });
    });

    groupNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            createButtonElement.click();
        }
    });

    createRow.append(groupNameInput, createButtonElement);
    createSection.appendChild(createRow);
    panelBody.appendChild(createSection);

    const listSection = document.createElement('section');
    listSection.className = 'section scrollable';

    const listTitle = document.createElement('h3');
    listTitle.className = 'section-title';
    listTitle.textContent = i18nMessage('uiShelvesTitle');
    listSection.appendChild(listTitle);

    const groups = Array.isArray(model.groups) ? model.groups : [];
    if (groups.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'empty';
        emptyText.textContent = i18nMessage('uiNoShelvesYet');
        listSection.appendChild(emptyText);
        panelBody.appendChild(listSection);
        return;
    }

    const list = document.createElement('div');
    list.className = 'group-list';

    groups.forEach((group) => {
        const item = document.createElement('div');
        item.className = 'group-item';

        const head = document.createElement('div');
        head.className = 'group-item-head';

        if (uiState.editingGroupId === group.id) {
            const renameInput = document.createElement('input');
            renameInput.className = 'rename-input';
            renameInput.value = group.name;
            renameInput.maxLength = 80;

            const saveRename = createButton(i18nMessage('uiButtonSave'), 'btn', () => {
                void withUiMutation(async () => {
                    await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, {
                        groupId: group.id,
                        name: renameInput.value,
                    });
                });
            });

            renameInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    saveRename.click();
                }

                if (event.key === 'Escape') {
                    uiState.editingGroupId = null;
                    renderUiPanel();
                }
            });

            head.append(renameInput, saveRename);
        } else {
            const name = document.createElement('span');
            name.className = 'group-name';
            name.textContent = group.name;

            const count = document.createElement('span');
            count.className = 'count-pill';
            count.textContent = i18nMessage('uiGroupImageCount', String(group.count ?? 0));

            head.append(name, count);
        }

        const controls = document.createElement('div');
        controls.className = 'group-controls';

        if (uiState.editingGroupId === group.id) {
            const cancelRename = createButton(i18nMessage('uiButtonCancel'), 'btn secondary', () => {
                uiState.editingGroupId = null;
                renderUiPanel();
            });
            controls.appendChild(cancelRename);
        } else {
            const renameButton = createButton(i18nMessage('uiButtonRename'), 'btn secondary', () => {
                uiState.editingGroupId = group.id;
                renderUiPanel();
            });

            const deleteButton = createButton(i18nMessage('uiButtonDeleteShelf'), 'btn danger', () => {
                const confirmed = window.confirm(i18nMessage('uiConfirmDeleteShelf'));
                if (!confirmed) {
                    return;
                }

                void withUiMutation(async () => {
                    await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: group.id });
                });
            });

            controls.append(renameButton, deleteButton);
        }

        item.append(head, controls);

        item.addEventListener('click', (event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.closest('button, input')) {
                return;
            }

            void withUiMutation(async () => {
                await sendRuntimeMessage(MESSAGE_TYPES.SET_ACTIVE_GROUP, { groupId: group.id });
            });
        });

        list.appendChild(item);
    });

    listSection.appendChild(list);
    panelBody.appendChild(listSection);
}

function openLightbox(screenshot) {
    if (!uiState.shadowRoot || !screenshot) {
        return;
    }

    const imageSource = resolveScreenshotImageSource(screenshot);
    if (!imageSource) {
        return;
    }

    closeLightbox();

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';

    const inner = document.createElement('div');
    inner.className = 'lightbox-inner';

    const image = document.createElement('img');
    image.className = 'lightbox-image';
    image.alt = i18nMessage('uiSavedImageAlt');

    image.src = imageSource;
    uiState.lightboxUrl = imageSource.startsWith('blob:') ? imageSource : null;

    const actions = document.createElement('div');
    actions.className = 'lightbox-actions';

    const openLinkButton = createButton(i18nMessage('uiButtonOpenLink'), 'btn lightbox-open-link', () => {
        if (typeof screenshot.pageUrl === 'string' && screenshot.pageUrl.length > 0) {
            void sendRuntimeActionMessage(ACTION_TYPES.OPEN_OR_SWITCH_TAB, { url: screenshot.pageUrl }).catch((error) => {
                console.warn('ClipShelf: failed to open or switch tab:', error);
            });
        }
    });

    if (!screenshot.pageUrl) {
        openLinkButton.disabled = true;
    }

    const closeButton = createButton('×', 'lightbox-close', () => {
        closeLightbox();
    });
    closeButton.title = i18nMessage('uiButtonClose');

    actions.append(openLinkButton, closeButton);
    inner.append(image, actions);
    overlay.appendChild(inner);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeLightbox();
        }
    });

    uiState.shadowRoot.appendChild(overlay);
    uiState.lightboxElement = overlay;
}

function renderActiveGroupState(panelBody, model) {
    const activeGroup = model.activeGroup;
    if (!activeGroup) {
        const fallback = document.createElement('p');
        fallback.className = 'empty';
        fallback.textContent = i18nMessage('uiFailedToLoadActiveShelfInfo');
        panelBody.appendChild(fallback);
        return;
    }

    const titleSection = document.createElement('section');
    titleSection.className = 'section';

    const titleRow = document.createElement('div');
    titleRow.className = 'inline-row active-group-row';

    const endSaveButton = createButton(i18nMessage('uiButtonStopSaving'), 'btn secondary', () => {
        void withUiMutation(async () => {
            await sendRuntimeMessage(MESSAGE_TYPES.END_SAVE_MODE);
        });
    });

    const deleteGroupButton = createButton(i18nMessage('uiButtonDeleteShelf'), 'btn danger', () => {
        const confirmed = window.confirm(i18nMessage('uiConfirmDeleteShelf'));
        if (!confirmed) {
            return;
        }

        void withUiMutation(async () => {
            await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: activeGroup.id });
        });
    });

    if (uiState.editingGroupId === activeGroup.id) {
        const renameInput = document.createElement('input');
        renameInput.className = 'rename-input';
        renameInput.value = activeGroup.name;
        renameInput.maxLength = 80;

        const saveRename = createButton(i18nMessage('uiButtonSave'), 'btn', () => {
            void withUiMutation(async () => {
                await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, {
                    groupId: activeGroup.id,
                    name: renameInput.value,
                });
            });
        });

        const cancelRename = createButton(i18nMessage('uiButtonCancel'), 'btn secondary', () => {
            uiState.editingGroupId = null;
            renderUiPanel();
        });

        renameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveRename.click();
            }

            if (event.key === 'Escape') {
                cancelRename.click();
            }
        });

        const editActions = document.createElement('div');
        editActions.className = 'active-group-actions';
        editActions.append(saveRename, cancelRename, endSaveButton, deleteGroupButton);

        titleRow.append(renameInput, editActions);
    } else {
        const groupTitle = document.createElement('strong');
        groupTitle.className = 'group-name';
        groupTitle.textContent = activeGroup.name;

        const count = document.createElement('span');
        count.className = 'count-pill';
        count.textContent = i18nMessage('uiGroupImageCount', String(activeGroup.count || 0));

        const renameButton = createButton(i18nMessage('uiButtonRename'), 'btn secondary', () => {
            uiState.editingGroupId = activeGroup.id;
            renderUiPanel();
        });

        const meta = document.createElement('div');
        meta.className = 'active-group-meta';
        meta.append(groupTitle, count);

        const actions = document.createElement('div');
        actions.className = 'active-group-actions';
        actions.append(renameButton, endSaveButton, deleteGroupButton);

        titleRow.append(meta, actions);
    }

    titleSection.appendChild(titleRow);
    panelBody.appendChild(titleSection);

    const screenshotsSection = document.createElement('section');
    screenshotsSection.className = 'section scrollable';

    const screenshotsTitle = document.createElement('h3');
    screenshotsTitle.className = 'section-title';
    screenshotsTitle.textContent = i18nMessage('uiSavedImagesTitle');
    screenshotsSection.appendChild(screenshotsTitle);

    const screenshots = Array.isArray(model.screenshots) ? model.screenshots : [];
    if (screenshots.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'empty';
        emptyText.textContent = i18nMessage('uiNoImagesInShelf');
        screenshotsSection.appendChild(emptyText);
    } else {
        const grid = document.createElement('div');
        grid.className = 'thumb-grid';

        screenshots.forEach((screenshot) => {
            const item = document.createElement('div');
            item.className = 'thumb-item';

            const image = document.createElement('img');
            image.loading = 'lazy';
            image.decoding = 'async';
            image.alt = i18nMessage('uiSavedImageThumbnailAlt');

            const imageSource = resolveScreenshotImageSource(screenshot);
            if (imageSource) {
                image.src = imageSource;
            } else {
                image.alt = i18nMessage('uiFailedToLoadImageDataAlt');
            }

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'thumb-delete';
            deleteButton.textContent = '×';
            deleteButton.title = i18nMessage('uiDeleteImageTitle');

            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                void withUiMutation(async () => {
                    await sendRuntimeMessage(MESSAGE_TYPES.DELETE_SCREENSHOT, { id: screenshot.id });
                });
            });

            const meta = document.createElement('span');
            meta.className = 'thumb-meta';
            meta.textContent = new Date(screenshot.timestamp).toLocaleString();

            item.append(image, deleteButton, meta);

            item.addEventListener('click', () => {
                openLightbox(screenshot);
            });

            grid.appendChild(item);
        });

        const scroll = document.createElement('div');
        scroll.className = 'thumb-scroll';
        scroll.appendChild(grid);
        screenshotsSection.appendChild(scroll);
    }

    panelBody.appendChild(screenshotsSection);
}

function renderUiPanel() {
    if (!uiState.panelElement) {
        return;
    }

    closeLightbox();
    revokeAllObjectUrls();

    const panel = uiState.panelElement;
    panel.textContent = '';

    const header = document.createElement('header');
    header.className = 'panel-header';

    header.addEventListener('mousedown', handlePanelMoveStart);

    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = i18nMessage('extName');

    const headerActions = document.createElement('div');
    headerActions.className = 'panel-header-actions';

    const closePanelButton = createButton('×', 'panel-close', () => {
        void closeUiPanelFromUserAction().catch((error) => {
            console.warn('ClipShelf: failed to close UI from panel button:', error);
        });
    });
    closePanelButton.title = i18nMessage('uiButtonClose');
    closePanelButton.setAttribute('aria-label', i18nMessage('uiButtonClose'));

    headerActions.append(closePanelButton);

    const directions = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
    directions.forEach(dir => {
        const resizer = document.createElement('div');
        resizer.className = `resizer resizer-${dir}`;
        resizer.addEventListener('mousedown', (e) => handlePanelResizeStart(e, dir));
        panel.appendChild(resizer);
    });

    header.append(title, headerActions);
    panel.appendChild(header);

    if (uiState.model) {
        renderStorageWarning(panel, uiState.model);
    }

    const body = document.createElement('div');
    body.className = 'panel-body';
    panel.appendChild(body);

    renderErrorBanner(body);

    if (!uiState.model) {
        const loadingText = document.createElement('p');
        loadingText.className = 'empty';
        loadingText.textContent = i18nMessage('uiLoadingData');
        body.appendChild(loadingText);
        return;
    }

    if (!uiState.model.activeGroupId) {
        renderNoActiveGroupState(body, uiState.model);
        return;
    }

    renderActiveGroupState(body, uiState.model);
}

async function refreshAndRenderUi() {
    if (!uiState.isUiOpen) {
        return;
    }

    try {
        const model = await sendRuntimeMessage(MESSAGE_TYPES.GET_UI_MODEL);
        uiState.model = model;
        uiState.uiPosition = normalizeUiPosition(model?.uiPosition || uiState.uiPosition);

        const warningLevel = getStorageWarningLevel(Number(model?.totalScreenshotCount));
        if (!warningLevel) {
            uiState.dismissedStorageWarningLevel = null;
        } else if (uiState.dismissedStorageWarningLevel === 'warning' && warningLevel === 'danger') {
            uiState.dismissedStorageWarningLevel = null;
        }

        uiState.lastError = '';
        applyUiHostPosition();
        renderUiPanel();
    } catch (error) {
        uiState.model = null;
        uiState.lastError = error?.message || i18nMessage('uiErrorLoadUiData');
        renderUiPanel();
    }
}

async function withUiMutation(action) {
    try {
        uiState.lastError = '';
        await action();
        uiState.editingGroupId = null;
        await refreshAndRenderUi();
    } catch (error) {
        uiState.lastError = error?.message || i18nMessage('uiErrorOperationFailed');
        renderUiPanel();
    }
}

async function openUiPanel() {
    uiState.isUiOpen = true;
    uiState.dismissedStorageWarningLevel = null;
    ensureUiHost();
    await refreshAndRenderUi();
}

async function closeUiPanelFromUserAction() {
    const shouldCloseAllUis = !hasActiveShelfId();

    closeUiPanel();
    await setLocalStorage({ [STORAGE_KEYS.IS_UI_OPEN]: false });

    if (!shouldCloseAllUis) {
        return;
    }

    try {
        await requestCloseAllUis();
    } catch (error) {
        console.warn('ClipShelf: failed to request closeAllUIs:', error);
    }
}

async function toggleUiPanelInCurrentTab() {
    if (uiState.isUiOpen) {
        await closeUiPanelFromUserAction();
    } else {
        await openUiPanel();
        await setLocalStorage({ [STORAGE_KEYS.IS_UI_OPEN]: true });
    }

    return { isUiOpen: uiState.isUiOpen };
}

function closeUiPanel() {
    uiState.isUiOpen = false;
    uiState.model = null;
    uiState.editingGroupId = null;
    uiState.lastError = '';
    uiState.dismissedStorageWarningLevel = null;

    closeLightbox();
    revokeAllObjectUrls();

    if (uiState.hostElement) {
        uiState.hostElement.remove();
    }

    uiState.hostElement = null;
    uiState.shadowRoot = null;
    uiState.panelElement = null;
}

function handleStorageChanged(changes, areaName) {
    if (areaName !== 'local') {
        return;
    }

    const hasActiveShelfChange = Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.ACTIVE_SHELF_ID);

    if (hasActiveShelfChange) {
        currentActiveShelfId = normalizeStorageId(changes[STORAGE_KEYS.ACTIVE_SHELF_ID].newValue);
        isActiveShelfStateInitialized = true;

        if (!hasActiveShelfId()) {
            resetSelectionInteractionState();
        }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_POSITION)) {
        uiState.uiPosition = normalizeUiPosition(changes[STORAGE_KEYS.UI_POSITION].newValue);
        applyUiHostPosition();
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_PANEL_HEIGHT)) {
        uiState.uiPanelHeight = changes[STORAGE_KEYS.UI_PANEL_HEIGHT].newValue;
        applyUiHostPosition();
    }

    if (!uiState.isUiOpen) {
        return;
    }

    if (
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.ACTIVE_GROUP_ID) ||
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.GROUPS_METADATA)
    ) {
        void refreshAndRenderUi();
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_PANEL_LEFT) ||
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_PANEL_TOP) ||
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_PANEL_WIDTH) ||
        Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_PANEL_HEIGHT)) {
        
        if (changes[STORAGE_KEYS.UI_PANEL_LEFT]) uiState.uiPanelLeft = changes[STORAGE_KEYS.UI_PANEL_LEFT].newValue;
        if (changes[STORAGE_KEYS.UI_PANEL_TOP]) uiState.uiPanelTop = changes[STORAGE_KEYS.UI_PANEL_TOP].newValue;
        if (changes[STORAGE_KEYS.UI_PANEL_WIDTH]) uiState.uiPanelWidth = changes[STORAGE_KEYS.UI_PANEL_WIDTH].newValue;
        if (changes[STORAGE_KEYS.UI_PANEL_HEIGHT]) uiState.uiPanelHeight = changes[STORAGE_KEYS.UI_PANEL_HEIGHT].newValue;
        
        applyUiHostPosition();
    }
}

function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.action === ACTION_TYPES.FORCE_DISABLE_SELECTION) {
        resetSelectionInteractionState();
        return undefined;
    }
    if (message?.action === ACTION_TYPES.FORCE_CLOSE_UI) {
        if (uiState.isUiOpen) {
            closeUiPanel();
        }

        return undefined;
    }

    if (message?.action === ACTION_TYPES.TOGGLE_UI) {
        void toggleUiPanelInCurrentTab()
            .then((data) => {
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error('ClipShelf toggleUI failed:', error);
                sendResponse({
                    ok: false,
                    error: error?.message || 'Failed to toggle UI.',
                });
            });

        return true;
    }

    if (!message || message.type !== EVENT_TYPES.SCREENSHOT_SAVED) {
        return undefined;
    }

    if (!uiState.isUiOpen) {
        return;
    }

    if (
        message.groupId &&
        uiState.model?.activeGroupId &&
        message.groupId !== uiState.model.activeGroupId
    ) {
        return undefined;
    }

    void refreshAndRenderUi();
    return undefined;
}

async function initializeUiState() {
    try {
        // STORAGE_KEYS を経由せず直接文字列の配列を渡す
        const values = await getLocalStorage([
            'isUiOpen', 
            'uiPanelHeight',
            'uiPanelWidth',
            'uiPanelLeft',
            'uiPanelTop'
        ]);
        
        uiState.uiPanelHeight = values['uiPanelHeight'] || null;
        uiState.uiPanelWidth = values['uiPanelWidth'] || null;
        uiState.uiPanelLeft = values['uiPanelLeft'] ?? null;
        uiState.uiPanelTop = values['uiPanelTop'] ?? null;

        if (values['isUiOpen']) {
            await openUiPanel();
        }
    } catch (error) {
        console.error('ClipShelf UI initialization failed:', error);
    }
}

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

function isEditableTarget(target) {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
}

function isSelectionShortcutKey(event) {
    return typeof event.key === 'string' && event.key.toLowerCase() === 's';
}

function handleKeyDown(event) {
    if (!canUseSelectionMode()) {
        return;
    }

    if (isEditableTarget(event.target)) {
        return;
    }

    if (!isSelectionShortcutKey(event)) {
        return;
    }

    // Cancel browser default only while selection save mode is active.
    event.preventDefault();
    event.stopPropagation();
    keyboardState.isSelectionKeyDown = true;
    keyboardState.isSelectionKeyPressed = true;
}

function handleKeyUp(event) {
    if (!isSelectionShortcutKey(event)) {
        return;
    }

    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;

    if (!selectionState.isDragging) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    finalizeSelection();
}

function resetSelectionShortcutState() {
    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;
}

function getRectFromPoints(startX, startY, currentX, currentY) {
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    return { x, y, width, height };
}

function updateOverlayRect(currentX, currentY) {
    if (!selectionState.overlayElement) {
        return;
    }

    selectionState.lastX = currentX;
    selectionState.lastY = currentY;

    const rect = getRectFromPoints(
        selectionState.startX,
        selectionState.startY,
        currentX,
        currentY,
    );

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

    // Remove stale overlays that may remain from interrupted interactions.
    document.querySelectorAll('#clipshelf-selection-overlay').forEach((overlay) => {
        overlay.remove();
    });
}

function resetSelectionInteractionState() {
    selectionState.isDragging = false;
    selectionState.startX = 0;
    selectionState.startY = 0;
    selectionState.lastX = 0;
    selectionState.lastY = 0;
    selectionState.activeShelfId = null;
    removeOverlay();

    keyboardState.isSelectionKeyDown = false;
    keyboardState.isSelectionKeyPressed = false;
}

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
        sendSelectionToBackground(rect, activeShelfId);
    }, CAPTURE_DELAY_MS);
}

function finalizeSelection(eventX, eventY) {
    if (!selectionState.isDragging) {
        return;
    }

    // Prevent duplicate capture when mouseup and keyup happen back-to-back.
    selectionState.isDragging = false;

    const finalX = Number.isFinite(eventX) ? eventX : selectionState.lastX;
    const finalY = Number.isFinite(eventY) ? eventY : selectionState.lastY;
    const activeShelfId = normalizeStorageId(selectionState.activeShelfId) || currentActiveShelfId;
    selectionState.activeShelfId = null;

    removeOverlay();

    const rect = getRectFromPoints(
        selectionState.startX,
        selectionState.startY,
        finalX,
        finalY,
    );

    if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
        return;
    }

    if (!activeShelfId) {
        return;
    }

    scheduleSelectionCapture(rect, activeShelfId);
}

function sendSelectionToBackground(rect, activeShelfId) {
    chrome.runtime.sendMessage(
        {
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
        },
        (response) => {
            if (chrome.runtime.lastError) {
                console.warn('ClipShelf: failed to send selection message:', chrome.runtime.lastError.message);
                return;
            }

            if (!response || response.ok !== true) {
                console.warn('ClipShelf: capture request failed:', response?.error || 'unknown-error');
                return;
            }

            if (response.data?.saved === false) {
                console.warn('ClipShelf: selection was not saved:', response.data.reason || 'unknown-reason');
            }
        },
    );
}

function handleMouseDown(event) {
    if (!canUseSelectionMode()) {
        return;
    }

    if (event.button !== 0 || !keyboardState.isSelectionKeyPressed || selectionState.isDragging) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    beginSelection(event, currentActiveShelfId);
}

function handleMouseMove(event) {
    if (!canUseSelectionMode()) {
        return;
    }

    if (!selectionState.isDragging) {
        return;
    }

    if ((event.buttons & 1) === 0) {
        finalizeSelection();
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateOverlayRect(event.clientX, event.clientY);
}

function handleMouseUp(event) {
    if (!canUseSelectionMode()) {
        return;
    }

    if (!selectionState.isDragging) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    finalizeSelection(event.clientX, event.clientY);
}

function blockNativeSelectionWhileDragging(event) {
    if (!selectionState.isDragging) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
}

function handleContextMenu(event) {
    if (!keyboardState.isSelectionKeyPressed && !selectionState.isDragging) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
}

function handleWindowBlur() {
    resetSelectionShortcutState();

    if (selectionState.isDragging) {
        endSelection();
    }
}

document.addEventListener('keydown', handleKeyDown, true);
document.addEventListener('keyup', handleKeyUp, true);
document.addEventListener('mousedown', handleMouseDown, true);
document.addEventListener('mousemove', handleMouseMove, true);
document.addEventListener('mouseup', handleMouseUp, true);
document.addEventListener('dragstart', blockNativeSelectionWhileDragging, true);
document.addEventListener('selectstart', blockNativeSelectionWhileDragging, true);
document.addEventListener('contextmenu', handleContextMenu, true);
window.addEventListener('blur', handleWindowBlur, true);
window.addEventListener('beforeunload', () => {
    resetSelectionShortcutState();
    closeLightbox();
    revokeAllObjectUrls();
});

chrome.storage.onChanged.addListener(handleStorageChanged);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);
void syncActiveShelfIdFromStorage().catch((error) => {
    console.warn('ClipShelf: failed to initialize activeShelfId state:', error);
});

if (globalThis[INITIAL_UI_SKIP_FLAG]) {
    delete globalThis[INITIAL_UI_SKIP_FLAG];
} else {
    void initializeUiState();
}

})();