importScripts('lib/dexie.min.js', 'db.js');

const STORAGE_DEFAULTS = {
    isUiOpen: false,
    uiPosition: 'bottom',
    activeGroupId: null,
    activeShelfId: null,
    groupsMetadata: {},
    keySaveImage: 's',
    keySaveTab: 'a',
    promptForName: false,
    thumbSize: 'medium'
};

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
    CAPTURE_VISIBLE_TAB: 'captureVisibleTab',
};

const CONTENT_INITIAL_UI_SKIP_FLAG = '__CLIPSHELF_SKIP_INITIAL_UI_STATE';

const HANDLED_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

const FALLBACK_GROUP_NAME = 'Untitled Group';

function getStorage(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(result);
        });
    });
}

function setStorage(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve();
        });
    });
}

function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
        if (!Number.isInteger(tabId)) {
            resolve();
            return;
        }

        chrome.tabs.sendMessage(tabId, message, () => {
            // Ignore cases where the tab has no active content script listener.
            resolve();
        });
    });
}

function sendMessageToTabWithResponse(tabId, message) {
    return new Promise((resolve, reject) => {
        if (!Number.isInteger(tabId)) {
            reject(new Error('A valid tab id is required.'));
            return;
        }

        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(response);
        });
    });
}

function executeScriptOnTab(tabId, injection) {
    return new Promise((resolve, reject) => {
        if (!Number.isInteger(tabId)) {
            reject(new Error('A valid tab id is required.'));
            return;
        }

        chrome.scripting.executeScript(
            {
                target: { tabId },
                ...injection,
            },
            (results) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }

                resolve(results);
            },
        );
    });
}

function queryTabs(queryInfo) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query(queryInfo, (tabs) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(Array.isArray(tabs) ? tabs : []);
        });
    });
}

function updateTab(tabId, updateProperties) {
    return new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, updateProperties, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(tab);
        });
    });
}

function focusWindow(windowId) {
    return new Promise((resolve, reject) => {
        chrome.windows.update(windowId, { focused: true }, (window) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(window);
        });
    });
}

function createTab(createProperties) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create(createProperties, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(tab);
        });
    });
}

function isInjectableTabUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    const trimmedUrl = url.trim();
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
        return false;
    }

    try {
        const parsedUrl = new URL(trimmedUrl);
        const host = parsedUrl.hostname.toLowerCase();
        const path = parsedUrl.pathname.toLowerCase();

        if (host === 'chromewebstore.google.com') {
            return false;
        }

        if (host === 'chrome.google.com' && path.startsWith('/webstore')) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

async function injectContentScriptIntoExistingTabs() {
    const tabs = await queryTabs({});

    for (const tab of tabs) {
        const tabId = tab?.id;
        const tabUrl = tab?.url;

        if (!Number.isInteger(tabId) || !isInjectableTabUrl(tabUrl)) {
            continue;
        }

        try {
            await executeScriptOnTab(tabId, {
                files: ['content.js'],
            });
        } catch (error) {
            console.warn('ClipShelf: failed to inject content script:', {
                tabId,
                tabUrl,
                error: error?.message || String(error),
            });
        }
    }
}

function cloneDefaultValue(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    return JSON.parse(JSON.stringify(value));
}

function normalizeGroupName(name) {
    if (typeof name !== 'string') {
        return FALLBACK_GROUP_NAME;
    }

    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : FALLBACK_GROUP_NAME;
}

function normalizeGroupsMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const normalized = {};
    const now = Date.now();

    Object.entries(value).forEach(([groupId, metadata]) => {
        if (!groupId || !metadata || typeof metadata !== 'object') {
            return;
        }

        const createdAt = Number(metadata.createdAt);
        const updatedAt = Number(metadata.updatedAt);
        const safeCreatedAt = Number.isFinite(createdAt) ? createdAt : now;
        const safeUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : safeCreatedAt;

        normalized[groupId] = {
            name: normalizeGroupName(metadata.name),
            createdAt: safeCreatedAt,
            updatedAt: safeUpdatedAt,
        };
    });

    return normalized;
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

function createGroupId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `group_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function getStoredAppState() {
    const state = await getStorage(Object.keys(STORAGE_DEFAULTS));
    const activeGroupId = normalizeStorageId(state.activeGroupId);
    const activeShelfId = normalizeStorageId(state.activeShelfId) || activeGroupId;

    return {
        isUiOpen: Boolean(state.isUiOpen),
        uiPosition: normalizeUiPosition(state.uiPosition),
        activeGroupId,
        activeShelfId,
        groupsMetadata: normalizeGroupsMetadata(state.groupsMetadata),
    };
}

function captureVisibleTab(windowId, options) {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            resolve(dataUrl);
        });
    });
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function normalizeSelection(selection) {
    if (!selection || typeof selection !== 'object') {
        return null;
    }

    const x = Number(selection.x);
    const y = Number(selection.y);
    const width = Number(selection.width);
    const height = Number(selection.height);
    const viewportWidth = Number(selection.viewportWidth);
    const viewportHeight = Number(selection.viewportHeight);

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return null;
    }

    return {
        x,
        y,
        width,
        height,
        viewportWidth: Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0,
        viewportHeight: Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0,
    };
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

async function blobToDataUrl(blob) {
    if (!(blob instanceof Blob)) {
        return null;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const mimeType = blob.type || 'image/png';
    return `data:${mimeType};base64,${base64}`;
}

async function cropDataUrlToBlob(dataUrl, selection) {
    const sourceBlob = await dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(sourceBlob);

    try {
        const sourceWidth = bitmap.width;
        const sourceHeight = bitmap.height;
        const viewportWidth = selection.viewportWidth > 0 ? selection.viewportWidth : sourceWidth;
        const viewportHeight = selection.viewportHeight > 0 ? selection.viewportHeight : sourceHeight;
        const scaleX = sourceWidth / viewportWidth;
        const scaleY = sourceHeight / viewportHeight;

        const rawX = Math.round(selection.x * scaleX);
        const rawY = Math.round(selection.y * scaleY);
        const sx = clamp(rawX, 0, Math.max(0, sourceWidth - 1));
        const sy = clamp(rawY, 0, Math.max(0, sourceHeight - 1));
        const sw = clamp(Math.round(selection.width * scaleX), 1, sourceWidth - sx);
        const sh = clamp(Math.round(selection.height * scaleY), 1, sourceHeight - sy);

        const canvas = new OffscreenCanvas(sw, sh);
        const context = canvas.getContext('2d', { alpha: true });
        if (!context) {
            throw new Error('Failed to initialize OffscreenCanvas 2D context.');
        }

        context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
        return canvas.convertToBlob({ type: 'image/png' });
    } finally {
        if (typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }
}

async function persistCapturedSelection(payload, sender) {
    const selection = normalizeSelection(payload.selection);
    if (!selection) {
        return { saved: false, reason: 'invalid-selection' };
    }

    const state = await getStoredAppState();
    const requestedShelfId = normalizeStorageId(payload?.activeShelfId);
    const activeShelfId = requestedShelfId || state.activeShelfId;
    if (!activeShelfId || !state.groupsMetadata[activeShelfId]) {
        return { saved: false, reason: 'no-active-shelf' };
    }

    const pageUrl =
        typeof payload.pageUrl === 'string' && payload.pageUrl.trim() !== ''
            ? payload.pageUrl
            : sender?.tab?.url || '';

    const dataUrl = await captureVisibleTab(sender?.tab?.windowId, { format: 'png' });
    const imageBlob = await cropDataUrlToBlob(dataUrl, selection);

    await self.ClipShelfDB.addScreenshot({
        groupId: activeShelfId,
        imageBlob,
        pageUrl,
        timestamp: Date.now(),
        name: payload.customName || 'No name', // 追加: 名前を保存
    });

    if (state.groupsMetadata[activeShelfId]) {
        const groupsMetadata = { ...state.groupsMetadata };
        groupsMetadata[activeShelfId] = {
            ...groupsMetadata[activeShelfId],
            updatedAt: Date.now(),
        };
        await setStorage({ groupsMetadata });
    }

    void sendMessageToTab(sender?.tab?.id, {
        type: EVENT_TYPES.SCREENSHOT_SAVED,
        groupId: activeShelfId,
    });

    return { saved: true };
}

async function buildUiModel() {
    const state = await getStoredAppState();
    const groupsMetadata = state.groupsMetadata;
    let activeGroupId = state.activeGroupId;
    let activeShelfId = state.activeShelfId;
    const nextStorage = {};

    if (activeGroupId && !groupsMetadata[activeGroupId]) {
        activeGroupId = null;
        nextStorage.activeGroupId = null;
    }

    if (activeShelfId && !groupsMetadata[activeShelfId]) {
        activeShelfId = null;
        nextStorage.activeShelfId = null;
    }

    if (!activeShelfId && activeGroupId) {
        activeShelfId = activeGroupId;
        nextStorage.activeShelfId = activeGroupId;
    }

    if (Object.keys(nextStorage).length > 0) {
        await setStorage(nextStorage);
    }

    const groupIds = Object.keys(groupsMetadata);
    const countsByGroupId = await self.ClipShelfDB.getScreenshotCountsByGroupIds(groupIds);
    const totalScreenshotCount = await self.ClipShelfDB.getTotalScreenshotCount();

    const groups = groupIds
        .map((groupId) => ({
            id: groupId,
            name: groupsMetadata[groupId].name,
            createdAt: groupsMetadata[groupId].createdAt,
            updatedAt: groupsMetadata[groupId].updatedAt,
            count: countsByGroupId[groupId] || 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.name.localeCompare(b.name));

    const screenshots = activeGroupId ? await self.ClipShelfDB.getScreenshotsByGroup(activeGroupId) : [];
    const screenshotsForUi = await Promise.all(
        screenshots.map(async (screenshot) => ({
            id: screenshot.id,
            groupId: screenshot.groupId,
            pageUrl: screenshot.pageUrl || '',
            timestamp: screenshot.timestamp,
            name: screenshot.name || '名称未設定', // 追加: UIに名前を渡す
            imageDataUrl: await blobToDataUrl(screenshot.imageBlob),
        })),
    );

    return {
        isUiOpen: state.isUiOpen,
        uiPosition: state.uiPosition,
        activeGroupId,
        totalScreenshotCount,
        groups,
        activeGroup: activeGroupId
            ? {
                id: activeGroupId,
                ...groupsMetadata[activeGroupId],
                count: countsByGroupId[activeGroupId] || 0,
            }
            : null,
        screenshots: screenshotsForUi,
    };
}

async function createGroup(payload) {
    const state = await getStoredAppState();
    const groupsMetadata = { ...state.groupsMetadata };
    const groupId = createGroupId();
    const now = Date.now();

    groupsMetadata[groupId] = {
        name: normalizeGroupName(payload?.name),
        createdAt: now,
        updatedAt: now,
    };

    await setStorage({
        groupsMetadata,
        activeGroupId: groupId,
        activeShelfId: groupId,
    });

    return { groupId };
}

async function renameGroup(payload) {
    const groupId = typeof payload?.groupId === 'string' ? payload.groupId : null;
    if (!groupId) {
        throw new Error('groupId is required.');
    }

    const state = await getStoredAppState();
    if (!state.groupsMetadata[groupId]) {
        throw new Error('Group not found.');
    }

    const groupsMetadata = { ...state.groupsMetadata };
    groupsMetadata[groupId] = {
        ...groupsMetadata[groupId],
        name: normalizeGroupName(payload?.name),
        updatedAt: Date.now(),
    };

    await setStorage({ groupsMetadata });
    return { groupId };
}

async function setActiveGroup(payload) {
    const requestedGroupId = typeof payload?.groupId === 'string' ? payload.groupId : null;
    if (!requestedGroupId) {
        throw new Error('groupId is required.');
    }

    const state = await getStoredAppState();
    if (!state.groupsMetadata[requestedGroupId]) {
        throw new Error('Group not found.');
    }

    const groupsMetadata = { ...state.groupsMetadata };
    groupsMetadata[requestedGroupId] = {
        ...groupsMetadata[requestedGroupId],
        updatedAt: Date.now(),
    };

    await setStorage({
        activeGroupId: requestedGroupId,
        activeShelfId: requestedGroupId,
        groupsMetadata,
    });

    return { activeGroupId: requestedGroupId, activeShelfId: requestedGroupId };
}

async function endSaveMode() {
    await setStorage({ activeGroupId: null, activeShelfId: null });
    try {
        await forceDisableSelectionAcrossTabs();
    } catch (error) {
        console.warn('ClipShelf: failed to force-disable selection across tabs:', error);
    }

    return { activeGroupId: null, activeShelfId: null };
}

async function deleteGroup(payload) {
    const groupId = typeof payload?.groupId === 'string' ? payload.groupId : null;
    if (!groupId) {
        throw new Error('groupId is required.');
    }

    const state = await getStoredAppState();
    if (!state.groupsMetadata[groupId]) {
        return { deleted: false };
    }

    const groupsMetadata = { ...state.groupsMetadata };
    delete groupsMetadata[groupId];

    const nextStorage = { groupsMetadata };
    if (state.activeGroupId === groupId) {
        nextStorage.activeGroupId = null;
    }

    if (state.activeShelfId === groupId) {
        nextStorage.activeShelfId = null;
    }

    await Promise.all([
        setStorage(nextStorage),
        self.ClipShelfDB.deleteScreenshotsByGroup(groupId),
    ]);

    if (state.activeShelfId === groupId) {
        try {
            await forceDisableSelectionAcrossTabs();
        } catch (error) {
            console.warn('ClipShelf: failed to force-disable selection after group delete:', error);
        }
    }

    return { deleted: true };
}

async function deleteScreenshot(payload) {
    const id = Number(payload?.id);
    if (!Number.isFinite(id)) {
        throw new Error('A valid screenshot id is required.');
    }

    await self.ClipShelfDB.deleteScreenshotById(id);
    return { deleted: true };
}

function isNoReceiverError(error) {
    const message = String(error?.message || '');
    return (
        message.includes('Could not establish connection') ||
        message.includes('Receiving end does not exist')
    );
}


// === 独立ウィンドウ管理 ===
let uiWindowId = null;
let lastWindowBlurTime = 0; // フォーカスを失った時間を記録

// ウィンドウのフォーカス変更を監視
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (uiWindowId !== null && windowId !== uiWindowId) {
        lastWindowBlurTime = Date.now();
    }
});

async function toggleUiWindow() {
    if (uiWindowId !== null) {
        const winInfo = await new Promise((resolve) => {
            chrome.windows.get(uiWindowId, (win) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                } else {
                    resolve(win);
                }
            });
        });

        if (winInfo) {
            // アイコンクリック時にフォーカスが奪われるため、
            // 現在フォーカスされているか、フォーカスを失ってから300ミリ秒以内なら「前面にあった」と判定
            const timeSinceBlur = Date.now() - lastWindowBlurTime;
            
            if (winInfo.focused || timeSinceBlur < 300) {
                await new Promise((resolve) => {
                    chrome.windows.remove(uiWindowId, () => resolve());
                });
                uiWindowId = null;
                await setStorage({ isUiOpen: false });
                return { toggled: true, action: 'closed' };
            } else {
                await new Promise((resolve) => {
                    chrome.windows.update(uiWindowId, { focused: true }, () => resolve());
                });
                return { toggled: true, action: 'focused' };
            }
        } else {
            uiWindowId = null;
        }
    }

    const state = await getStorage(['uiPanelLeft', 'uiPanelTop', 'uiPanelWidth', 'uiPanelHeight']);
    const isValid = (val) => typeof val === 'number' && !isNaN(val);
    
    let width = isValid(state.uiPanelWidth) ? Math.round(state.uiPanelWidth) : 420;
    let height = isValid(state.uiPanelHeight) ? Math.round(state.uiPanelHeight) : 600;
    let left = isValid(state.uiPanelLeft) ? Math.round(state.uiPanelLeft) : undefined;
    let top = isValid(state.uiPanelTop) ? Math.round(state.uiPanelTop) : undefined;

    width = Math.max(width, 340);
    height = Math.max(height, 200);

    const createData = {
        url: chrome.runtime.getURL('panel.html'),
        type: 'popup',
        width: width,
        height: height
    };

    if (left !== undefined) createData.left = left;
    if (top !== undefined) createData.top = top;

    try {
        const win = await new Promise((resolve, reject) => {
            chrome.windows.create(createData, (window) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(window);
            });
        });
        uiWindowId = win.id;
        await setStorage({ isUiOpen: true });
    } catch (error) {
        const win = await new Promise((resolve) => {
            chrome.windows.create({
                url: chrome.runtime.getURL('panel.html'),
                type: 'popup',
                width: 420,
                height: 600
            }, resolve);
        });
        if (win) {
            uiWindowId = win.id;
            await setStorage({ isUiOpen: true });
        }
    }
    
    return { toggled: true, action: 'created' };
}

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === uiWindowId) {
        uiWindowId = null;
        setStorage({ isUiOpen: false });
    }
});
chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === uiWindowId) {
        uiWindowId = null;
        setStorage({ isUiOpen: false });
    }
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === uiWindowId) {
        uiWindowId = null;
        setStorage({ isUiOpen: false });
    }
});

// ウィンドウが閉じられたことを検知する
chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === uiWindowId) {
        uiWindowId = null;
        setStorage({ isUiOpen: false });
    }
});

// ウィンドウが閉じられたことを検知する
chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === uiWindowId) {
        uiWindowId = null;
        setStorage({ isUiOpen: false });
    }
});

async function openOrSwitchTab(payload) {
    const targetUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (!targetUrl) {
        throw new Error('A valid URL is required.');
    }

    const existingTabs = await queryTabs({ url: targetUrl });
    const targetTab = existingTabs.find((tab) => Number.isInteger(tab?.id));

    if (targetTab && Number.isInteger(targetTab.windowId)) {
        await focusWindow(targetTab.windowId);
        await updateTab(targetTab.id, { active: true });
        return { reused: true, tabId: targetTab.id };
    }

    const createdTab = await createTab({ url: targetUrl });
    return { reused: false, tabId: createdTab?.id || null };
}

async function closeAllUisAcrossTabs() {
    const tabs = await queryTabs({});

    await Promise.all(
        tabs.map((tab) =>
            sendMessageToTab(tab?.id, {
                action: ACTION_TYPES.FORCE_CLOSE_UI,
            }),
        ),
    );

    return {
        closedTabCount: tabs.filter((tab) => Number.isInteger(tab?.id)).length,
    };
}

async function forceDisableSelectionAcrossTabs() {
    const tabs = await queryTabs({});

    await Promise.all(
        tabs.map((tab) =>
            sendMessageToTab(tab?.id, {
                action: ACTION_TYPES.FORCE_DISABLE_SELECTION,
            }),
        ),
    );

    return {
        signalledTabCount: tabs.filter((tab) => Number.isInteger(tab?.id)).length,
    };
}

async function routeRuntimeMessage(message, sender) {
    switch (message.type) {
        case MESSAGE_TYPES.CAPTURE_SELECTION:
            return persistCapturedSelection(message, sender);
        case MESSAGE_TYPES.GET_UI_MODEL:
            return buildUiModel();
        case MESSAGE_TYPES.CREATE_GROUP:
            return createGroup(message);
        case MESSAGE_TYPES.RENAME_GROUP:
            return renameGroup(message);
        case MESSAGE_TYPES.DELETE_GROUP:
            return deleteGroup(message);
        case MESSAGE_TYPES.SET_ACTIVE_GROUP:
            return setActiveGroup(message);
        case MESSAGE_TYPES.END_SAVE_MODE:
            return endSaveMode();
        case MESSAGE_TYPES.DELETE_SCREENSHOT:
            return deleteScreenshot(message);
        default:
            return null;
    }
}

async function initializeStorageDefaults() {
    try {
        const existing = await getStorage(Object.keys(STORAGE_DEFAULTS));
        const missingValues = {};

        Object.entries(STORAGE_DEFAULTS).forEach(([key, defaultValue]) => {
            if (typeof existing[key] === 'undefined') {
                missingValues[key] = cloneDefaultValue(defaultValue);
            }
        });

        if (Object.keys(missingValues).length > 0) {
            await setStorage(missingValues);
        }

        const normalizedUiPosition = normalizeUiPosition(existing.uiPosition);
        if (existing.uiPosition !== undefined && existing.uiPosition !== normalizedUiPosition) {
            await setStorage({ uiPosition: normalizedUiPosition });
        }

        if (existing.groupsMetadata !== undefined) {
            const normalizedGroupsMetadata = normalizeGroupsMetadata(existing.groupsMetadata);
            const serializedExisting = JSON.stringify(existing.groupsMetadata || {});
            const serializedNormalized = JSON.stringify(normalizedGroupsMetadata);
            if (serializedExisting !== serializedNormalized) {
                await setStorage({ groupsMetadata: normalizedGroupsMetadata });
            }
        }
    } catch (error) {
        console.error('Failed to initialize ClipShelf storage defaults:', error);
    }
}

chrome.runtime.onInstalled.addListener((details) => {
    void initializeStorageDefaults();

    if (details?.reason !== 'install' && details?.reason !== 'update') {
        return;
    }

    void injectContentScriptIntoExistingTabs().catch((error) => {
        console.warn('ClipShelf: failed to inject existing tabs on install/update:', error);
    });
});

chrome.runtime.onStartup.addListener(() => {
    void initializeStorageDefaults();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === ACTION_TYPES.OPEN_OR_SWITCH_TAB) {
        void openOrSwitchTab(message)
            .then((data) => {
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error('ClipShelf openOrSwitchTab failed:', error);
                sendResponse({
                    ok: false,
                    error: error?.message || 'Failed to process tab request.',
                });
            });

        return true;
    }

    if (message?.action === ACTION_TYPES.CAPTURE_VISIBLE_TAB) {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ ok: true, dataUrl });
            }
        });
        return true;
    }

    if (message?.action === ACTION_TYPES.CLOSE_ALL_UIS) {
        void closeAllUisAcrossTabs()
            .then((data) => {
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error('ClipShelf closeAllUIs failed:', error);
                sendResponse({
                    ok: false,
                    error: error?.message || 'Failed to close all UIs.',
                });
            });

        return true;
    }

    if (!message || !HANDLED_MESSAGE_TYPES.has(message.type)) {
        return undefined;
    }

    void routeRuntimeMessage(message, sender)
        .then((data) => {
            sendResponse({ ok: true, data });
        })
        .catch((error) => {
            console.error('ClipShelf message handling failed:', error);
            sendResponse({
                ok: false,
                error: error?.message || 'Failed to process request.',
            });
        });

    return true;
});

if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(() => {
        void toggleUiWindow().catch((error) => {
            console.error('ClipShelf window toggle failed:', error);
        });
    });
}

void initializeStorageDefaults();

self.ClipShelfBackground = {
    initializeStorageDefaults,
    STORAGE_DEFAULTS,
    MESSAGE_TYPES,
    persistCapturedSelection,
    buildUiModel,
};