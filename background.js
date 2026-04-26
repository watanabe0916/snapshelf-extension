importScripts('lib/dexie.min.js', 'db.js');

const STORAGE_DEFAULTS = {
    isUiOpen: false,
    uiPosition: 'bottom',
    activeGroupId: null,
    groupsMetadata: {},
};

const MESSAGE_TYPES = {
    CAPTURE_SELECTION: 'SNAPSHELF_CAPTURE_SELECTION',
    GET_UI_MODEL: 'SNAPSHELF_GET_UI_MODEL',
    CREATE_GROUP: 'SNAPSHELF_CREATE_GROUP',
    RENAME_GROUP: 'SNAPSHELF_RENAME_GROUP',
    DELETE_GROUP: 'SNAPSHELF_DELETE_GROUP',
    SET_ACTIVE_GROUP: 'SNAPSHELF_SET_ACTIVE_GROUP',
    END_SAVE_MODE: 'SNAPSHELF_END_SAVE_MODE',
    DELETE_SCREENSHOT: 'SNAPSHELF_DELETE_SCREENSHOT',
};

const EVENT_TYPES = {
    SCREENSHOT_SAVED: 'SNAPSHELF_SCREENSHOT_SAVED',
};

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

function createGroupId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `group_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function getStoredAppState() {
    const state = await getStorage(Object.keys(STORAGE_DEFAULTS));

    return {
        isUiOpen: Boolean(state.isUiOpen),
        uiPosition: normalizeUiPosition(state.uiPosition),
        activeGroupId: typeof state.activeGroupId === 'string' ? state.activeGroupId : null,
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

    const { activeGroupId } = await getStorage(['activeGroupId']);
    if (!activeGroupId) {
        return { saved: false, reason: 'no-active-group' };
    }

    const pageUrl =
        typeof payload.pageUrl === 'string' && payload.pageUrl.trim() !== ''
            ? payload.pageUrl
            : sender?.tab?.url || '';

    const dataUrl = await captureVisibleTab(sender?.tab?.windowId, { format: 'png' });
    const imageBlob = await cropDataUrlToBlob(dataUrl, selection);

    await self.SnapShelfDB.addScreenshot({
        groupId: activeGroupId,
        imageBlob,
        pageUrl,
        timestamp: Date.now(),
    });

    void sendMessageToTab(sender?.tab?.id, {
        type: EVENT_TYPES.SCREENSHOT_SAVED,
        groupId: activeGroupId,
    });

    return { saved: true };
}

async function buildUiModel() {
    const state = await getStoredAppState();
    const groupsMetadata = state.groupsMetadata;
    let activeGroupId = state.activeGroupId;

    if (activeGroupId && !groupsMetadata[activeGroupId]) {
        activeGroupId = null;
        await setStorage({ activeGroupId: null });
    }

    const groupIds = Object.keys(groupsMetadata);
    const countsByGroupId = await self.SnapShelfDB.getScreenshotCountsByGroupIds(groupIds);

    const groups = groupIds
        .map((groupId) => ({
            id: groupId,
            name: groupsMetadata[groupId].name,
            createdAt: groupsMetadata[groupId].createdAt,
            updatedAt: groupsMetadata[groupId].updatedAt,
            count: countsByGroupId[groupId] || 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.name.localeCompare(b.name));

    const screenshots = activeGroupId ? await self.SnapShelfDB.getScreenshotsByGroup(activeGroupId) : [];
    const screenshotsForUi = await Promise.all(
        screenshots.map(async (screenshot) => ({
            id: screenshot.id,
            groupId: screenshot.groupId,
            pageUrl: screenshot.pageUrl || '',
            timestamp: screenshot.timestamp,
            imageDataUrl: await blobToDataUrl(screenshot.imageBlob),
        })),
    );

    return {
        isUiOpen: state.isUiOpen,
        uiPosition: state.uiPosition,
        activeGroupId,
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

    await setStorage({ activeGroupId: requestedGroupId });
    return { activeGroupId: requestedGroupId };
}

async function endSaveMode() {
    await setStorage({ activeGroupId: null });
    return { activeGroupId: null };
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

    await Promise.all([
        setStorage(nextStorage),
        self.SnapShelfDB.deleteScreenshotsByGroup(groupId),
    ]);

    return { deleted: true };
}

async function deleteScreenshot(payload) {
    const id = Number(payload?.id);
    if (!Number.isFinite(id)) {
        throw new Error('A valid screenshot id is required.');
    }

    await self.SnapShelfDB.deleteScreenshotById(id);
    return { deleted: true };
}

async function toggleUiOpenState() {
    const state = await getStoredAppState();
    const nextIsUiOpen = !state.isUiOpen;
    await setStorage({ isUiOpen: nextIsUiOpen });
    return { isUiOpen: nextIsUiOpen };
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
        console.error('Failed to initialize SnapShelf storage defaults:', error);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    void initializeStorageDefaults();
});

chrome.runtime.onStartup.addListener(() => {
    void initializeStorageDefaults();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !HANDLED_MESSAGE_TYPES.has(message.type)) {
        return undefined;
    }

    void routeRuntimeMessage(message, sender)
        .then((data) => {
            sendResponse({ ok: true, data });
        })
        .catch((error) => {
            console.error('SnapShelf message handling failed:', error);
            sendResponse({
                ok: false,
                error: error?.message || 'Failed to process request.',
            });
        });

    return true;
});

if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(() => {
        void toggleUiOpenState();
    });
}

void initializeStorageDefaults();

self.SnapShelfBackground = {
    initializeStorageDefaults,
    STORAGE_DEFAULTS,
    MESSAGE_TYPES,
    persistCapturedSelection,
    buildUiModel,
};