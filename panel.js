const MESSAGE_TYPES = {
    GET_UI_MODEL: 'CLIPSHELF_GET_UI_MODEL',
    GET_SCREENSHOTS_PAGE: 'CLIPSHELF_GET_SCREENSHOTS_PAGE',
    CREATE_GROUP: 'CLIPSHELF_CREATE_GROUP',
    RENAME_GROUP: 'CLIPSHELF_RENAME_GROUP',
    DELETE_GROUP: 'CLIPSHELF_DELETE_GROUP',
    SET_ACTIVE_GROUP: 'CLIPSHELF_SET_ACTIVE_GROUP',
    END_SAVE_MODE: 'CLIPSHELF_END_SAVE_MODE',
    DELETE_SCREENSHOT: 'CLIPSHELF_DELETE_SCREENSHOT',
};

const ACTION_TYPES = {
    OPEN_OR_SWITCH_TAB: 'openOrSwitchTab',
};

const EVENT_TYPES = {
    SCREENSHOT_SAVED: 'CLIPSHELF_SCREENSHOT_SAVED',
};

const SCREENSHOT_PAGE_SIZE = 10;
const SCREENSHOT_AUTO_LOAD_DELAY_MS = 80;

const uiState = {
    model: null,
    editingGroupId: null,
    lastError: '',
    lightboxUrl: null,
    thumbSize: 'medium',
    screenshotPaging: {
        groupId: null,
        items: [],
        offset: 0,
        totalCount: 0,
        hasMore: false,
        isLoading: false,
        requestId: 0,
    }
};

let suppressNextGroupsMetadataRefresh = false;
let suppressGroupsMetadataRefreshTimer = null;
let lastActiveGroupId = null;
let suppressNextScreenshotStorageRefresh = false;
let autoScreenshotLoadTimer = null;

function suppressNextLocalGroupsMetadataRefresh() {
    suppressNextGroupsMetadataRefresh = true;
    if (suppressGroupsMetadataRefreshTimer) {
        clearTimeout(suppressGroupsMetadataRefreshTimer);
    }
    suppressGroupsMetadataRefreshTimer = setTimeout(() => {
        suppressNextGroupsMetadataRefresh = false;
        suppressGroupsMetadataRefreshTimer = null;
    }, 1000);
}

window.addEventListener('beforeunload', () => {
    chrome.storage.local.set({
        uiPanelLeft: window.screenX,
        uiPanelTop: window.screenY,
        uiPanelWidth: window.outerWidth,
        uiPanelHeight: window.outerHeight
    });
});

function getMessage(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
}

function sendRuntimeMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response || response.ok !== true) {
                reject(new Error(response?.error || getMessage('uiErrorBackgroundRequestFailed')));
                return;
            }
            resolve(response.data);
        });
    });
}

function createButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
}

function createIconButton(iconName, className, onClick, titleText = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = titleText;
    btn.innerHTML = `<span class="material-symbols-rounded" style="font-size:22px">${iconName}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
}

function normalizeDisplayName(name, fallback = 'Untitled Group') {
    if (typeof name !== 'string') return fallback;
    const trimmed = name.trim();
    return trimmed || fallback;
}

function applyGroupNameToModel(groupId, name) {
    if (!uiState.model || !groupId) return;

    const displayName = normalizeDisplayName(name);
    if (uiState.model.activeGroup?.id === groupId) {
        uiState.model.activeGroup.name = displayName;
    }

    if (Array.isArray(uiState.model.groups)) {
        uiState.model.groups = uiState.model.groups.map((group) => (
            group.id === groupId ? { ...group, name: displayName } : group
        ));
    }
}

function resetScreenshotPaging(groupId, totalCount = 0) {
    if (autoScreenshotLoadTimer) {
        clearTimeout(autoScreenshotLoadTimer);
        autoScreenshotLoadTimer = null;
    }

    uiState.screenshotPaging = {
        groupId,
        items: [],
        offset: 0,
        totalCount,
        hasMore: totalCount > 0,
        isLoading: false,
        requestId: uiState.screenshotPaging.requestId + 1,
    };
}

function syncScreenshotPagingWithModel() {
    const activeGroupId = uiState.model?.activeGroupId || null;
    const totalCount = uiState.model?.activeGroup?.count || 0;
    const paging = uiState.screenshotPaging;

    if (
        paging.groupId !== activeGroupId ||
        paging.totalCount !== totalCount ||
        lastActiveGroupId !== activeGroupId
    ) {
        resetScreenshotPaging(activeGroupId, totalCount);
    }
    lastActiveGroupId = activeGroupId;
}

function renderActiveGroupTitleOnly() {
    if (!uiState.model?.activeGroup) {
        renderUi();
        return;
    }

    const container = document.getElementById('app-container');
    const currentTitle = container.querySelector('.active-group-title-section');
    const nextTitle = createActiveGroupTitleSection(uiState.model);

    if (currentTitle) {
        currentTitle.replaceWith(nextTitle);
    } else {
        renderUi();
    }
}

function createScreenshotItem(screenshot) {
    const item = document.createElement('div');
    item.className = 'thumb-item';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = screenshot.imageDataUrl;
    img.alt = getMessage('uiSavedImageThumbnailAlt');

    const delBtn = document.createElement('button');
    delBtn.className = 'thumb-delete';
    delBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px">close</span>';
    delBtn.title = getMessage('uiDeleteImageTitle');
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        delBtn.disabled = true;
        try {
            await sendRuntimeMessage(MESSAGE_TYPES.DELETE_SCREENSHOT, { id: screenshot.id });
            applyDeletedScreenshot(screenshot, item);
        } catch (error) {
            delBtn.disabled = false;
            uiState.lastError = error.message;
            renderUi();
        }
    });

    const meta = document.createElement('span');
    meta.className = 'thumb-meta';
    meta.textContent = screenshot.name;
    meta.title = screenshot.name;

    item.append(img, delBtn, meta);
    item.addEventListener('click', () => openLightbox(screenshot));
    return item;
}

function appendScreenshotsToGrid(grid, screenshots) {
    screenshots.forEach((screenshot) => {
        grid.appendChild(createScreenshotItem(screenshot));
    });
}

function prependScreenshotToGrid(grid, screenshot) {
    grid.prepend(createScreenshotItem(screenshot));
}

function applyDeletedScreenshot(screenshot, itemElement) {
    const paging = uiState.screenshotPaging;
    const screenshotId = Number(screenshot?.id);
    const itemIndex = paging.items.findIndex((item) => Number(item.id) === screenshotId);

    if (itemIndex !== -1) {
        paging.items.splice(itemIndex, 1);
    }

    paging.totalCount = Math.max(0, paging.totalCount - 1);
    paging.offset = Math.max(0, paging.offset - 1);

    if (uiState.model?.activeGroup) {
        uiState.model.activeGroup.count = Math.max(0, (uiState.model.activeGroup.count || 0) - 1);
    }

    if (Array.isArray(uiState.model?.groups)) {
        uiState.model.groups = uiState.model.groups.map((group) => (
            group.id === screenshot.groupId ? { ...group, count: Math.max(0, (group.count || 0) - 1) } : group
        ));
    }

    itemElement?.remove();
    renderActiveGroupTitleOnly();

    const activeSection = document.querySelector('.screenshots-section');
    if (uiState.model?.activeGroup?.count === 0) {
        renderUi();
        return;
    }

    if (activeSection) {
        scheduleNextScreenshotPage(activeSection);
    }
}

function updateScreenshotLoadStatus(section) {
    const paging = uiState.screenshotPaging;
    const status = section.querySelector('.thumb-load-status');
    if (!status) return;

    if (paging.isLoading && paging.items.length === 0) {
        status.textContent = getMessage('uiLoadingData');
        status.hidden = false;
        return;
    }

    if (paging.isLoading) {
        status.textContent = getMessage('uiLoadingData');
        status.hidden = false;
        return;
    }

    status.textContent = '';
    status.hidden = true;
}

function scheduleNextScreenshotPage(section) {
    const paging = uiState.screenshotPaging;
    if (!section?.isConnected || !paging.groupId || paging.isLoading || !paging.hasMore) return;

    if (autoScreenshotLoadTimer) {
        clearTimeout(autoScreenshotLoadTimer);
    }

    autoScreenshotLoadTimer = setTimeout(() => {
        autoScreenshotLoadTimer = null;
        loadNextScreenshotPage(section);
    }, SCREENSHOT_AUTO_LOAD_DELAY_MS);
}

async function loadNextScreenshotPage(section) {
    const paging = uiState.screenshotPaging;
    const groupId = paging.groupId;
    if (!section?.isConnected || !groupId || paging.isLoading || !paging.hasMore) return;

    const requestId = paging.requestId + 1;
    paging.requestId = requestId;
    paging.isLoading = true;
    updateScreenshotLoadStatus(section);

    try {
        const page = await sendRuntimeMessage(MESSAGE_TYPES.GET_SCREENSHOTS_PAGE, {
            groupId,
            offset: paging.offset,
            limit: SCREENSHOT_PAGE_SIZE,
        });

        if (uiState.screenshotPaging.requestId !== requestId || uiState.screenshotPaging.groupId !== groupId) {
            return;
        }

        const screenshots = Array.isArray(page?.screenshots) ? page.screenshots : [];
        paging.items = paging.items.concat(screenshots);
        paging.offset = Number.isFinite(page?.nextOffset) ? page.nextOffset : paging.items.length;
        paging.totalCount = Number.isFinite(page?.totalCount) ? page.totalCount : paging.totalCount;
        paging.hasMore = Boolean(page?.hasMore);
        paging.isLoading = false;

        if (!section.isConnected) {
            renderUi();
            return;
        }

        const grid = section.querySelector('.thumb-grid');
        if (grid) {
            appendScreenshotsToGrid(grid, screenshots);
        }
        updateScreenshotLoadStatus(section);

        const scroll = section.querySelector('.thumb-scroll');
        if (scroll && paging.hasMore && scroll.scrollHeight - scroll.clientHeight < 240) {
            requestAnimationFrame(() => loadNextScreenshotPage(section));
        } else {
            scheduleNextScreenshotPage(section);
        }
    } catch (e) {
        if (uiState.screenshotPaging.requestId === requestId) {
            paging.isLoading = false;
            uiState.lastError = e.message;
            renderUi();
        }
    }
}

function ensureScreenshotPageLoading(section) {
    const paging = uiState.screenshotPaging;
    const totalCount = uiState.model?.activeGroup?.count || paging.totalCount || 0;
    if (!paging.groupId || paging.items.length > 0 || paging.isLoading || totalCount <= 0) return;

    if (!paging.hasMore) {
        paging.offset = 0;
        paging.hasMore = true;
    }

    requestAnimationFrame(() => loadNextScreenshotPage(section));
}

function applySavedScreenshotEvent(message) {
    const groupId = typeof message?.groupId === 'string' ? message.groupId : null;
    const screenshot = message?.screenshot;
    if (!groupId || !screenshot || uiState.model?.activeGroupId !== groupId) return false;

    const paging = uiState.screenshotPaging;
    if (paging.groupId !== groupId) {
        resetScreenshotPaging(groupId, uiState.model.activeGroup?.count || 0);
    }

    paging.totalCount += 1;
    paging.offset += 1;
    uiState.model.activeGroup.count = (uiState.model.activeGroup.count || 0) + 1;

    if (Array.isArray(uiState.model.groups)) {
        uiState.model.groups = uiState.model.groups.map((group) => (
            group.id === groupId ? { ...group, count: (group.count || 0) + 1, updatedAt: Date.now() } : group
        ));
    }

    paging.items.unshift(screenshot);
    const activeSection = document.querySelector('.screenshots-section');
    const grid = activeSection?.querySelector('.thumb-grid');
    const empty = activeSection?.querySelector('.empty');

    if (grid) {
        prependScreenshotToGrid(grid, screenshot);
        renderActiveGroupTitleOnly();
        return true;
    }

    if (empty) {
        renderUi();
        return true;
    }

    renderUi();
    return true;
}

function openLightbox(screenshot) {
    const container = document.body;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox';

    const inner = document.createElement('div');
    inner.className = 'lightbox-inner';

    const image = document.createElement('img');
    image.className = 'lightbox-image';
    image.src = screenshot.imageDataUrl;
    image.alt = getMessage('uiSavedImageAlt');

    const actions = document.createElement('div');
    actions.className = 'lightbox-actions';

    const openLinkBtn = createButton(getMessage('uiButtonOpenLink'), 'btn lightbox-open-link', (e) => {
        e.stopPropagation();
        if (screenshot.pageUrl) {
            chrome.runtime.sendMessage({
                action: ACTION_TYPES.OPEN_OR_SWITCH_TAB,
                url: screenshot.pageUrl
            });
            setTimeout(() => {
                chrome.windows.getCurrent((win) => {
                    chrome.windows.update(win.id, { focused: true });
                });
            }, 1);
        }
    });
    openLinkBtn.title = getMessage('uiButtonOpenLink');

    if (!screenshot.pageUrl) {
        openLinkBtn.disabled = true;
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.title = getMessage('uiButtonClose');
    closeBtn.innerHTML = '<span class="material-symbols-rounded">close</span>';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    actions.append(openLinkBtn, closeBtn);
    inner.append(image, actions);
    overlay.appendChild(inner);
    container.appendChild(overlay);
}

function renderNoActiveGroupState(container, model) {
    const createSection = document.createElement('section');
    createSection.className = 'section';
    createSection.innerHTML = `<h3 class="section-title"><span class="material-symbols-rounded" style="font-size:23px">add_circle</span>${getMessage('uiCreateNewShelfTitle')}</h3>`;

    const row = document.createElement('div');
    row.className = 'inline-row';
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = getMessage('uiEnterShelfNamePlaceholder');

    const btn = createButton(getMessage('uiButtonCreate'), 'btn primary', async () => {
        try {
            await sendRuntimeMessage(MESSAGE_TYPES.CREATE_GROUP, { name: input.value });
            refreshUi();
        } catch (e) { uiState.lastError = e.message; refreshUi(); }
    });

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    row.append(input, btn);
    createSection.appendChild(row);
    container.appendChild(createSection);

    const listSection = document.createElement('section');
    listSection.className = 'section scrollable';
    listSection.innerHTML = `<h3 class="section-title"><span class="material-symbols-rounded" style="font-size:23px">shelves</span>${getMessage('uiShelvesTitle')}</h3>`;

    if (!model.groups || model.groups.length === 0) {
        listSection.innerHTML += `<p class="empty">${getMessage('uiNoShelvesYet')}</p>`;
    } else {
        const list = document.createElement('div');
        list.className = 'group-list';
        model.groups.forEach(group => {
            const item = document.createElement('div');
            item.className = 'group-item';

            if (uiState.editingGroupId === group.id) {
                const rInput = document.createElement('input');
                rInput.className = 'rename-input';
                rInput.value = group.name;
                const saveBtn = createButton(getMessage('uiButtonSave'), 'btn primary', async (e) => {
                    e.stopPropagation();
                    await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, { groupId: group.id, name: rInput.value });
                    uiState.editingGroupId = null;
                    refreshUi();
                });
                const cancelBtn = createButton(getMessage('uiButtonCancel'), 'btn secondary', (e) => {
                    e.stopPropagation();
                    uiState.editingGroupId = null;
                    refreshUi();
                });
                item.append(rInput, saveBtn, cancelBtn);
            } else {
                const nameArea = document.createElement('div');
                nameArea.className = 'active-group-meta';
                nameArea.innerHTML = `
                    <span class="material-symbols-rounded shelf-icon" style="flex-shrink: 0;">library_books</span>
                    <div style="display: flex; flex-direction: column; flex: 1; min-width: 0;">
                        <span class="group-name" title="${group.name}">${group.name}</span>
                        <span class="count-pill">${getMessage('uiGroupImageCount', [String(group.count || 0)])}</span>
                    </div>`;

                const controls = document.createElement('div');
                controls.className = 'group-controls';
                controls.append(
                    createIconButton('edit', 'icon-btn', (e) => { e.stopPropagation(); uiState.editingGroupId = group.id; refreshUi(); }, getMessage('uiButtonRename')),
                    createIconButton('delete', 'icon-btn danger', async (e) => {
                        e.stopPropagation();
                        if (confirm(getMessage('uiConfirmDeleteShelf'))) {
                            await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: group.id });
                            refreshUi();
                        }
                    }, getMessage('uiButtonDeleteShelf'))
                );
                item.append(nameArea, controls);
                item.addEventListener('click', async () => {
                    await sendRuntimeMessage(MESSAGE_TYPES.SET_ACTIVE_GROUP, { groupId: group.id });
                    refreshUi();
                });
            }
            list.appendChild(item);
        });
        listSection.appendChild(list);
    }
    container.appendChild(listSection);
}

function createActiveGroupTitleSection(model) {
    const activeGroup = model.activeGroup;
    const titleSection = document.createElement('section');
    titleSection.className = 'section active-group-title-section';
    const titleRow = document.createElement('div');
    titleRow.className = 'inline-row active-group-row';

    const endBtn = createButton(getMessage('uiButtonStopSaving'), 'btn primary', async () => {
        await sendRuntimeMessage(MESSAGE_TYPES.END_SAVE_MODE);
        refreshUi();
    });

    if (uiState.editingGroupId === activeGroup.id) {
        const rInput = document.createElement('input');
        rInput.className = 'rename-input';
        rInput.value = activeGroup.name;
        const saveBtn = createButton(getMessage('uiButtonSave'), 'btn primary', async () => {
            const previousName = activeGroup.name;
            const requestedName = rInput.value;

            suppressNextLocalGroupsMetadataRefresh();
            applyGroupNameToModel(activeGroup.id, requestedName);
            uiState.editingGroupId = null;
            uiState.lastError = '';
            renderActiveGroupTitleOnly();

            try {
                const result = await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, { groupId: activeGroup.id, name: rInput.value });
                if (result?.name) {
                    applyGroupNameToModel(activeGroup.id, result.name);
                    renderActiveGroupTitleOnly();
                }
            } catch (e) {
                suppressNextGroupsMetadataRefresh = false;
                if (suppressGroupsMetadataRefreshTimer) {
                    clearTimeout(suppressGroupsMetadataRefreshTimer);
                    suppressGroupsMetadataRefreshTimer = null;
                }
                applyGroupNameToModel(activeGroup.id, previousName);
                uiState.lastError = e.message;
                renderUi();
            }
        });
        const cancelBtn = createButton(getMessage('uiButtonCancel'), 'btn secondary', () => {
            uiState.editingGroupId = null;
            renderActiveGroupTitleOnly();
        });
        titleRow.append(rInput, saveBtn, cancelBtn, endBtn);
    } else {
        const meta = document.createElement('div');
        meta.className = 'active-group-meta';
        meta.innerHTML = `
            <span class="material-symbols-rounded shelf-icon" style="font-size:32px;">library_books</span>
            <div style="display:flex; flex-direction:column; min-width:0; flex:1; overflow:hidden;">
                <strong class="group-name" style="font-size:16px;" title="${activeGroup.name}">${activeGroup.name}</strong>
                <span class="count-pill">${getMessage('uiGroupImageCount', [String(activeGroup.count || 0)])}</span>
            </div>`;

        const actions = document.createElement('div');
        actions.className = 'active-group-actions';
        actions.append(
            createIconButton('edit', 'icon-btn', () => { uiState.editingGroupId = activeGroup.id; renderActiveGroupTitleOnly(); }, getMessage('uiButtonRename')),
            createIconButton('delete', 'icon-btn danger', async () => {
                if (confirm(getMessage('uiConfirmDeleteShelf'))) {
                    await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: activeGroup.id });
                    refreshUi();
                }
            }, getMessage('uiButtonDeleteShelf')),
            endBtn
        );
        titleRow.append(meta, actions);
    }
    titleSection.appendChild(titleRow);
    return titleSection;
}

function renderActiveGroupState(container, model) {
    container.appendChild(createActiveGroupTitleSection(model));

    const screenshotsSection = document.createElement('section');
    screenshotsSection.className = 'section scrollable screenshots-section';
    screenshotsSection.innerHTML = `<h3 class="section-title"><span class="material-symbols-rounded" style="font-size:18px">image</span>${getMessage('uiSavedImagesTitle')}</h3>`;

    const paging = uiState.screenshotPaging;
    if ((model.activeGroup?.count || 0) === 0) {
        screenshotsSection.innerHTML += `<p class="empty">${getMessage('uiNoImagesInShelf')}</p>`;
    } else {
        const scroll = document.createElement('div');
        scroll.className = 'thumb-scroll';
        const grid = document.createElement('div');
        grid.className = `thumb-grid size-${uiState.thumbSize}`;
        appendScreenshotsToGrid(grid, paging.items);

        const loadStatus = document.createElement('p');
        loadStatus.className = 'empty thumb-load-status';
        loadStatus.hidden = true;

        scroll.appendChild(grid);
        scroll.appendChild(loadStatus);
        scroll.addEventListener('scroll', () => {
            const remaining = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            if (remaining < 240) {
                loadNextScreenshotPage(screenshotsSection);
            }
        });

        screenshotsSection.appendChild(scroll);

        updateScreenshotLoadStatus(screenshotsSection);
        ensureScreenshotPageLoading(screenshotsSection);
    }
    container.appendChild(screenshotsSection);
}

function renderUi() {
    const container = document.getElementById('app-container');
    container.innerHTML = '';

    if (uiState.lastError) {
        const err = document.createElement('div');
        err.className = 'status-error';
        err.textContent = uiState.lastError;
        container.appendChild(err);
    }

    if (!uiState.model) {
        const loadingText = document.createElement('p');
        loadingText.className = 'empty';
        loadingText.textContent = getMessage('uiLoadingData');
        container.appendChild(loadingText);
        return;
    }

    if (!uiState.model.activeGroupId) {
        renderNoActiveGroupState(container, uiState.model);
    } else {
        renderActiveGroupState(container, uiState.model);
    }
}

async function refreshUi() {
    try {
        uiState.model = await sendRuntimeMessage(MESSAGE_TYPES.GET_UI_MODEL);
        syncScreenshotPagingWithModel();
        //ストレージからサイズ設定を取得
        const items = await new Promise(resolve => chrome.storage.local.get(['thumbSize'], resolve));
        uiState.thumbSize = items.thumbSize || 'medium';
        uiState.lastError = '';
    } catch (e) {
        uiState.model = null;
        uiState.lastError = e.message;
    }
    renderUi();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (
        suppressNextScreenshotStorageRefresh &&
        Object.keys(changes).length === 1 &&
        changes.groupsMetadata
    ) {
        suppressNextScreenshotStorageRefresh = false;
        return;
    }

    if (
        suppressNextGroupsMetadataRefresh &&
        Object.keys(changes).length === 1 &&
        changes.groupsMetadata
    ) {
        suppressNextGroupsMetadataRefresh = false;
        if (suppressGroupsMetadataRefreshTimer) {
            clearTimeout(suppressGroupsMetadataRefreshTimer);
            suppressGroupsMetadataRefreshTimer = null;
        }
        return;
    }

    refreshUi();
});

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== EVENT_TYPES.SCREENSHOT_SAVED) return;

    suppressNextScreenshotStorageRefresh = true;
    if (!applySavedScreenshotEvent(message)) {
        refreshUi();
    }
});

function initSettings() {
    const settingsButton = document.getElementById('settingsButton');
    const settingsPanel = document.getElementById('settingsPanel');
    const btnSave = document.getElementById('saveSettingsBtn');

    if (!settingsButton || !settingsPanel || !btnSave) return;

    const elKeyImage = document.getElementById('inputKeySaveImage');
    const elKeyTab = document.getElementById('inputKeySaveTab');
    const elPromptName = document.getElementById('inputPromptForName');

    document.getElementById('settingsTitle').textContent = getMessage('uiSettingsTitle');
    document.getElementById('labelKeyImage').textContent = getMessage('uiSettingsKeyImage') + ': ';
    document.getElementById('labelKeyTab').textContent = getMessage('uiSettingsKeyTab') + ': ';
    document.getElementById('labelPromptName').textContent = getMessage('uiSettingsPromptName');

    const labelThumbSize = document.getElementById('labelThumbSize');
    if(labelThumbSize) labelThumbSize.textContent = getMessage('uiSettingsThumbSize');
    const labelSizeLarge = document.getElementById('labelSizeLarge');
    if(labelSizeLarge) labelSizeLarge.textContent = getMessage('uiThumbSizeLarge');
    const labelSizeMedium = document.getElementById('labelSizeMedium');
    if(labelSizeMedium) labelSizeMedium.textContent = getMessage('uiThumbSizeMedium');
    const labelSizeSmall = document.getElementById('labelSizeSmall');
    if(labelSizeSmall) labelSizeSmall.textContent = getMessage('uiThumbSizeSmall');

    btnSave.textContent = getMessage('uiButtonSaveSettings');

    document.getElementById('supportLabel').textContent = getMessage('uiButtonSupport');
    document.getElementById('labelBugReport').textContent = chrome.i18n.getMessage('uiBugReport') || 'Bug Report';

    settingsButton.addEventListener('click', () => {
        if (settingsPanel.style.display === 'none') {
            chrome.storage.local.get(['keySaveImage', 'keySaveTab', 'promptForName' , 'thumbSize'], (items) => {
                elKeyImage.value = items.keySaveImage || 's';
                elKeyTab.value = items.keySaveTab || 'a';
                elPromptName.checked = !!items.promptForName;

                //ラジオボタンの選択状態を復元
                const currentSize = items.thumbSize || 'medium';
                const radioSizes = document.getElementsByName('thumbSize');
                Array.from(radioSizes).forEach(radio => {
                    radio.checked = (radio.value === currentSize);
                });

                settingsPanel.style.display = 'block';
            });
        } else {
            settingsPanel.style.display = 'none';
        }
    });

    btnSave.addEventListener('click', () => {
        //選択されたラジオボタンの値を取得
        let selectedSize = 'medium';
        const radioSizes = document.getElementsByName('thumbSize');
        Array.from(radioSizes).forEach(radio => {
            if(radio.checked) selectedSize = radio.value;
        });

        const newSettings = {
            keySaveImage: elKeyImage.value.toLowerCase() || 's',
            keySaveTab: elKeyTab.value.toLowerCase() || 'a',
            promptForName: elPromptName.checked,
            thumbSize: selectedSize
        };
        chrome.storage.local.set(newSettings, () => {
            settingsPanel.style.display = 'none';
            refreshUi();
        });
    });
}

initSettings();
refreshUi();
