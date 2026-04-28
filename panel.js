// panel.js を以下にすべて置き換えてください。
const MESSAGE_TYPES = {
    GET_UI_MODEL: 'CLIPSHELF_GET_UI_MODEL',
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

const uiState = {
    model: null,
    editingGroupId: null,
    lastError: '',
    lightboxUrl: null
};

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

// openLightbox 関数を完全に上書き
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

    // ボタン配置用のコンテナ
    const actions = document.createElement('div');
    actions.className = 'lightbox-actions';

    // リンクを開くボタン
    const openLinkBtn = createButton(getMessage('uiButtonOpenLink'), 'btn lightbox-open-link', (e) => {
        e.stopPropagation();
        if (screenshot.pageUrl) {
            // 背景スクリプトの既存の openOrSwitchTab 機能を呼び出す
            chrome.runtime.sendMessage({
                action: ACTION_TYPES.OPEN_OR_SWITCH_TAB,
                url: screenshot.pageUrl
            });

            // ブラウザのタブ移動完了を待ってから、独立ウィンドウを再度フォーカス（前面へ）する
            setTimeout(() => {
                chrome.windows.getCurrent((win) => {
                    chrome.windows.update(win.id, { focused: true });
                });
            },1); // 0.15秒後に前面へ戻す
        }
    });
    openLinkBtn.title = getMessage('uiButtonOpenLink');

    // URLがない場合は無効化
    if (!screenshot.pageUrl) {
        openLinkBtn.disabled = true;
    }

    // 閉じるボタン
    const closeBtn = createButton('×', 'lightbox-close', (e) => {
        e.stopPropagation();
        overlay.remove();
    });
    closeBtn.title = getMessage('uiButtonClose');

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // 配置
    actions.append(openLinkBtn, closeBtn);
    inner.append(image, actions);
    overlay.appendChild(inner);
    container.appendChild(overlay);
}

function renderNoActiveGroupState(container, model) {
    const createSection = document.createElement('section');
    createSection.className = 'section';
    createSection.innerHTML = `<h3 class="section-title">${getMessage('uiCreateNewShelfTitle')}</h3>`;

    const row = document.createElement('div');
    row.className = 'inline-row';
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = getMessage('uiEnterShelfNamePlaceholder');
    
    const btn = createButton(getMessage('uiButtonCreate'), 'btn', async () => {
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
    listSection.innerHTML = `<h3 class="section-title">${getMessage('uiShelvesTitle')}</h3>`;

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
                const saveBtn = createButton(getMessage('uiButtonSave'), 'btn', async (e) => {
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
                nameArea.innerHTML = `<span class="group-name">${group.name}</span><span class="count-pill">${getMessage('uiGroupImageCount', [String(group.count || 0)])}</span>`;
                
                const controls = document.createElement('div');
                controls.className = 'group-controls';
                controls.append(
                    createButton(getMessage('uiButtonRename'), 'btn secondary', (e) => { e.stopPropagation(); uiState.editingGroupId = group.id; refreshUi(); }),
                    createButton(getMessage('uiButtonDeleteShelf'), 'btn danger', async (e) => {
                        e.stopPropagation();
                        if (confirm(getMessage('uiConfirmDeleteShelf'))) {
                            await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: group.id });
                            refreshUi();
                        }
                    })
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

function renderActiveGroupState(container, model) {
    const activeGroup = model.activeGroup;
    const titleSection = document.createElement('section');
    titleSection.className = 'section';
    const titleRow = document.createElement('div');
    titleRow.className = 'inline-row active-group-row';

    const endBtn = createButton(getMessage('uiButtonStopSaving'), 'btn secondary', async () => {
        await sendRuntimeMessage(MESSAGE_TYPES.END_SAVE_MODE);
        refreshUi();
    });
    
    const deleteBtn = createButton(getMessage('uiButtonDeleteShelf'), 'btn danger', async () => {
        if (confirm(getMessage('uiConfirmDeleteShelf'))) {
            await sendRuntimeMessage(MESSAGE_TYPES.DELETE_GROUP, { groupId: activeGroup.id });
            refreshUi();
        }
    });

    if (uiState.editingGroupId === activeGroup.id) {
        const rInput = document.createElement('input');
        rInput.className = 'rename-input';
        rInput.value = activeGroup.name;
        const saveBtn = createButton(getMessage('uiButtonSave'), 'btn', async () => {
            await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, { groupId: activeGroup.id, name: rInput.value });
            uiState.editingGroupId = null;
            refreshUi();
        });
        const cancelBtn = createButton(getMessage('uiButtonCancel'), 'btn secondary', () => {
            uiState.editingGroupId = null;
            refreshUi();
        });
        titleRow.append(rInput, saveBtn, cancelBtn, endBtn, deleteBtn);
    } else {
        const meta = document.createElement('div');
        meta.className = 'active-group-meta';
        meta.innerHTML = `<strong class="group-name">${activeGroup.name}</strong><span class="count-pill">${getMessage('uiGroupImageCount', [String(activeGroup.count || 0)])}</span>`;
        
        const actions = document.createElement('div');
        actions.className = 'active-group-actions';
        actions.append(
            createButton(getMessage('uiButtonRename'), 'btn secondary', () => { uiState.editingGroupId = activeGroup.id; refreshUi(); }),
            endBtn,
            deleteBtn
        );
        titleRow.append(meta, actions);
    }
    titleSection.appendChild(titleRow);
    container.appendChild(titleSection);

    const screenshotsSection = document.createElement('section');
    screenshotsSection.className = 'section scrollable';
    screenshotsSection.innerHTML = `<h3 class="section-title">${getMessage('uiSavedImagesTitle')}</h3>`;

    if (!model.screenshots || model.screenshots.length === 0) {
        screenshotsSection.innerHTML += `<p class="empty">${getMessage('uiNoImagesInShelf')}</p>`;
    } else {
        const scroll = document.createElement('div');
        scroll.className = 'thumb-scroll';
        const grid = document.createElement('div');
        grid.className = 'thumb-grid';

        model.screenshots.forEach(screenshot => {
            const item = document.createElement('div');
            item.className = 'thumb-item';
            
            const img = document.createElement('img');
            img.src = screenshot.imageDataUrl;
            img.alt = getMessage('uiSavedImageThumbnailAlt');
            
            const delBtn = createButton('×', 'thumb-delete', async (e) => {
                e.stopPropagation();
                await sendRuntimeMessage(MESSAGE_TYPES.DELETE_SCREENSHOT, { id: screenshot.id });
                refreshUi();
            });
            delBtn.title = getMessage('uiDeleteImageTitle');
            
            const meta = document.createElement('span');
            meta.className = 'thumb-meta';
            meta.textContent = new Date(screenshot.timestamp).toLocaleString();

            item.append(img, delBtn, meta);
            item.addEventListener('click', () => openLightbox(screenshot));
            grid.appendChild(item);
        });
        scroll.appendChild(grid);
        screenshotsSection.appendChild(scroll);
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
        uiState.lastError = '';
    } catch (e) {
        uiState.model = null;
        uiState.lastError = e.message;
    }
    renderUi();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') refreshUi();
});

refreshUi();