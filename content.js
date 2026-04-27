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

const STORAGE_KEYS = {
    IS_UI_OPEN: 'isUiOpen',
    UI_POSITION: 'uiPosition',
    ACTIVE_GROUP_ID: 'activeGroupId',
    GROUPS_METADATA: 'groupsMetadata',
};

const MIN_SELECTION_SIZE = 1;
const OVERLAY_Z_INDEX = 2147483646;
const UI_Z_INDEX = 2147483647;
const UI_HOST_ID = 'clipshelf-ui-host';

const selectionState = {
    isSelecting: false,
    startX: 0,
    startY: 0,
    overlayElement: null,
};

const keyboardState = {
    isSelectionKeyPressed: false,
};

const uiState = {
    hostElement: null,
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
                    reject(new Error(response?.error || 'Background request failed.'));
                    return;
                }

                resolve(response.data);
            },
        );
    });
}

function normalizeUiPosition(value) {
    return value === 'top' ? 'top' : 'bottom';
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
    if (!uiState.hostElement) {
        return;
    }

    if (uiState.uiPosition === 'top') {
        uiState.hostElement.style.top = '8px';
        uiState.hostElement.style.bottom = '';
    } else {
        uiState.hostElement.style.top = '';
        uiState.hostElement.style.bottom = '8px';
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
			width: min(100%, 1060px);
			margin-inline: auto;
			border: 1px solid var(--line);
			border-radius: 18px;
			background: linear-gradient(155deg, #fff8ec 0%, #eef5ff 52%, #f4fff9 100%);
			box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
			backdrop-filter: blur(4px);
			display: flex;
			flex-direction: column;
            max-height: min(34vh, 300px);
			overflow: hidden;
		}

		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
            padding: 7px 10px;
			border-bottom: 1px solid var(--line);
			background: linear-gradient(90deg, rgba(255, 255, 255, 0.55) 0%, rgba(239, 246, 255, 0.72) 100%);
            font-size: 13px;
			font-weight: 700;
			letter-spacing: 0.02em;
		}

        .panel-title {
            font-size: 13px;
            font-weight: 700;
            line-height: 1.2;
        }

		.panel-pos {
            font-size: 10px;
			color: var(--muted);
			font-weight: 600;
			background: rgba(255, 255, 255, 0.85);
			border: 1px solid var(--line);
			border-radius: 999px;
            padding: 1px 6px;
		}

		.panel-body {
            padding: 8px;
			overflow: auto;
			display: grid;
            gap: 8px;
		}

		.section {
			border: 1px solid var(--line);
            border-radius: 10px;
            padding: 8px;
			background: var(--card);
		}

		.section-title {
            margin: 0 0 6px;
            font-size: 12px;
			color: var(--muted);
			font-weight: 700;
			letter-spacing: 0.01em;
		}

		.inline-row {
			display: flex;
			align-items: center;
            gap: 6px;
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
            gap: 6px;
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }

        .active-group-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

		.input,
		.rename-input {
            min-width: 140px;
			flex: 1;
			border: 1px solid #cdd8e9;
			border-radius: 9px;
            padding: 7px 9px;
            font-size: 12px;
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
            padding: 6px 9px;
            font-size: 11px;
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
            gap: 6px;
		}

		.group-item {
			border: 1px solid #d5dfef;
			background: rgba(255, 255, 255, 0.9);
			border-radius: 10px;
            padding: 7px;
			display: grid;
            gap: 6px;
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
            gap: 6px;
			min-width: 0;
		}

		.group-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
            font-size: 13px;
			font-weight: 700;
		}

		.count-pill {
            font-size: 10px;
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
            gap: 5px;
			flex-wrap: wrap;
		}

		.thumb-grid {
			display: grid;
            grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
            gap: 8px;
        }

        .thumb-scroll {
            max-height: 132px;
            overflow-y: auto;
            padding-right: 2px;
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
            padding: 3px 5px 5px;
            font-size: 9px;
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
			font-size: 12px;
			line-height: 1.5;
			margin: 0;
		}

		.status-error {
			border: 1px solid rgba(194, 65, 12, 0.3);
			color: #9a3412;
			background: rgba(255, 237, 213, 0.8);
			border-radius: 9px;
			padding: 8px 10px;
			font-size: 12px;
			font-weight: 600;
		}

		.footer-actions {
			display: flex;
			gap: 8px;
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
            background: rgba(15, 23, 42, 0.96);
            border-color: rgba(226, 232, 240, 0.75);
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
        }

        .lightbox-close:hover {
            background: rgba(194, 65, 12, 0.95);
        }

		@keyframes fadeIn {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		@media (max-width: 680px) {
			.panel {
                max-height: 50vh;
			}

			.thumb-grid {
				grid-template-columns: repeat(auto-fill, minmax(94px, 1fr));
			}

            .thumb-scroll {
                max-height: 114px;
            }

			.thumb-item img {
                height: 68px;
			}

			.btn {
                padding: 6px 8px;
			}

			.panel-header {
                padding: 6px 8px;
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

function renderNoActiveGroupState(panelBody, model) {
    const createSection = document.createElement('section');
    createSection.className = 'section';

    const createTitle = document.createElement('h3');
    createTitle.className = 'section-title';
    createTitle.textContent = 'Create a new shelf';
    createSection.appendChild(createTitle);

    const createRow = document.createElement('div');
    createRow.className = 'inline-row';

    const groupNameInput = document.createElement('input');
    groupNameInput.className = 'input';
    groupNameInput.placeholder = 'Enter shelf name';
    groupNameInput.maxLength = 80;

    const createButtonElement = createButton('Create', 'btn', () => {
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
    listSection.className = 'section';

    const listTitle = document.createElement('h3');
    listTitle.className = 'section-title';
    listTitle.textContent = 'Shelves';
    listSection.appendChild(listTitle);

    const groups = Array.isArray(model.groups) ? model.groups : [];
    if (groups.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'empty';
        emptyText.textContent = 'No shelves yet. Please create one from the form above.';
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

            const saveRename = createButton('Save', 'btn', () => {
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
            count.textContent = `${group.count} images`;

            head.append(name, count);
        }

        const controls = document.createElement('div');
        controls.className = 'group-controls';

        if (uiState.editingGroupId === group.id) {
            const cancelRename = createButton('Cancel', 'btn secondary', () => {
                uiState.editingGroupId = null;
                renderUiPanel();
            });
            controls.appendChild(cancelRename);
        } else {
            const renameButton = createButton('Rename', 'btn secondary', () => {
                uiState.editingGroupId = group.id;
                renderUiPanel();
            });

            const deleteButton = createButton('Delete this shelf', 'btn danger', () => {
                const confirmed = window.confirm('Delete this shelf. Saved images will also be deleted.');
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
    image.alt = 'ClipShelf saved image';

    image.src = imageSource;
    uiState.lightboxUrl = imageSource.startsWith('blob:') ? imageSource : null;

    const actions = document.createElement('div');
    actions.className = 'lightbox-actions';

    const openLinkButton = createButton('Open link', 'btn lightbox-open-link', () => {
        if (typeof screenshot.pageUrl === 'string' && screenshot.pageUrl.length > 0) {
            window.open(screenshot.pageUrl, '_blank', 'noopener,noreferrer');
        }
    });

    if (!screenshot.pageUrl) {
        openLinkButton.disabled = true;
    }

    const closeButton = createButton('×', 'lightbox-close', () => {
        closeLightbox();
    });
    closeButton.title = 'Close';

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
        fallback.textContent = 'Failed to load active shelf information.';
        panelBody.appendChild(fallback);
        return;
    }

    const titleSection = document.createElement('section');
    titleSection.className = 'section';

    const titleRow = document.createElement('div');
    titleRow.className = 'inline-row active-group-row';

    const endSaveButton = createButton('Stop saving', 'btn secondary', () => {
        void withUiMutation(async () => {
            await sendRuntimeMessage(MESSAGE_TYPES.END_SAVE_MODE);
        });
    });

    const deleteGroupButton = createButton('Delete this shelf', 'btn danger', () => {
        const confirmed = window.confirm('Delete this shelf. Saved images will also be deleted.');
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

        const saveRename = createButton('Save', 'btn', () => {
            void withUiMutation(async () => {
                await sendRuntimeMessage(MESSAGE_TYPES.RENAME_GROUP, {
                    groupId: activeGroup.id,
                    name: renameInput.value,
                });
            });
        });

        const cancelRename = createButton('Cancel', 'btn secondary', () => {
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
        count.textContent = `${activeGroup.count || 0} images`;

        const renameButton = createButton('Rename', 'btn secondary', () => {
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
    screenshotsSection.className = 'section';

    const screenshotsTitle = document.createElement('h3');
    screenshotsTitle.className = 'section-title';
    screenshotsTitle.textContent = 'Saved images';
    screenshotsSection.appendChild(screenshotsTitle);

    const screenshots = Array.isArray(model.screenshots) ? model.screenshots : [];
    if (screenshots.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'empty';
        emptyText.textContent = 'No images in this shelf yet. Hold the S key and left-drag to save.';
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
            image.alt = 'Saved image thumbnail';

            const imageSource = resolveScreenshotImageSource(screenshot);
            if (imageSource) {
                image.src = imageSource;
            } else {
                image.alt = 'Failed to load image data.';
            }

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'thumb-delete';
            deleteButton.textContent = '×';
            deleteButton.title = 'Delete this image';

            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                void withUiMutation(async () => {
                    await sendRuntimeMessage(MESSAGE_TYPES.DELETE_SCREENSHOT, { id: screenshot.id });
                });
            });

            const meta = document.createElement('span');
            meta.className = 'thumb-meta';
            meta.textContent = new Date(screenshot.timestamp).toLocaleString('en-US');

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

    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = 'ClipShelf';

    const positionLabel = document.createElement('span');
    positionLabel.className = 'panel-pos';
    positionLabel.textContent = uiState.uiPosition === 'top' ? 'Docked Top' : 'Docked Bottom';

    header.append(title, positionLabel);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    panel.appendChild(body);

    renderErrorBanner(body);

    if (!uiState.model) {
        const loadingText = document.createElement('p');
        loadingText.className = 'empty';
        loadingText.textContent = 'Loading data...';
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
        uiState.lastError = '';
        applyUiHostPosition();
        renderUiPanel();
    } catch (error) {
        uiState.model = null;
        uiState.lastError = error?.message || 'Failed to load UI data.';
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
        uiState.lastError = error?.message || 'Operation failed.';
        renderUiPanel();
    }
}

async function openUiPanel() {
    uiState.isUiOpen = true;
    ensureUiHost();
    await refreshAndRenderUi();
}

function closeUiPanel() {
    uiState.isUiOpen = false;
    uiState.model = null;
    uiState.editingGroupId = null;
    uiState.lastError = '';

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

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.UI_POSITION)) {
        uiState.uiPosition = normalizeUiPosition(changes[STORAGE_KEYS.UI_POSITION].newValue);
        applyUiHostPosition();
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.IS_UI_OPEN)) {
        const shouldOpen = Boolean(changes[STORAGE_KEYS.IS_UI_OPEN].newValue);
        if (shouldOpen) {
            void openUiPanel();
        } else {
            closeUiPanel();
        }
        return;
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
}

function handleRuntimeMessage(message) {
    if (!message || message.type !== EVENT_TYPES.SCREENSHOT_SAVED) {
        return;
    }

    if (!uiState.isUiOpen) {
        return;
    }

    if (
        message.groupId &&
        uiState.model?.activeGroupId &&
        message.groupId !== uiState.model.activeGroupId
    ) {
        return;
    }

    void refreshAndRenderUi();
}

async function initializeUiState() {
    try {
        const values = await getLocalStorage([STORAGE_KEYS.IS_UI_OPEN, STORAGE_KEYS.UI_POSITION]);
        uiState.uiPosition = normalizeUiPosition(values[STORAGE_KEYS.UI_POSITION]);

        if (values[STORAGE_KEYS.IS_UI_OPEN]) {
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
    if (isEditableTarget(event.target)) {
        return;
    }

    if (isSelectionShortcutKey(event)) {
        keyboardState.isSelectionKeyPressed = true;
    }
}

function handleKeyUp(event) {
    if (isSelectionShortcutKey(event)) {
        keyboardState.isSelectionKeyPressed = false;
    }
}

function resetSelectionShortcutState() {
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
    if (!selectionState.overlayElement) {
        return;
    }

    selectionState.overlayElement.remove();
    selectionState.overlayElement = null;
}

function beginSelection(event) {
    selectionState.isSelecting = true;
    selectionState.startX = event.clientX;
    selectionState.startY = event.clientY;

    const overlay = createSelectionOverlay();
    selectionState.overlayElement = overlay;
    document.documentElement.appendChild(overlay);
    updateOverlayRect(event.clientX, event.clientY);
}

function endSelection() {
    selectionState.isSelecting = false;
    removeOverlay();
}

function sendSelectionToBackground(rect) {
    chrome.runtime.sendMessage(
        {
            type: MESSAGE_TYPES.CAPTURE_SELECTION,
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
        () => {
            if (chrome.runtime.lastError) {
                console.warn('ClipShelf: failed to send selection message:', chrome.runtime.lastError.message);
            }
        },
    );
}

function handleMouseDown(event) {
    if (event.button !== 0 || !keyboardState.isSelectionKeyPressed || selectionState.isSelecting) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    beginSelection(event);
}

function handleMouseMove(event) {
    if (!selectionState.isSelecting) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    updateOverlayRect(event.clientX, event.clientY);
}

function handleMouseUp(event) {
    if (!selectionState.isSelecting) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rect = getRectFromPoints(
        selectionState.startX,
        selectionState.startY,
        event.clientX,
        event.clientY,
    );

    endSelection();

    if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
        return;
    }

    sendSelectionToBackground(rect);
}

function blockNativeSelectionWhileDragging(event) {
    if (!selectionState.isSelecting) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
}

function handleWindowBlur() {
    resetSelectionShortcutState();

    if (selectionState.isSelecting) {
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
window.addEventListener('blur', handleWindowBlur, true);
window.addEventListener('beforeunload', () => {
    resetSelectionShortcutState();
    closeLightbox();
    revokeAllObjectUrls();
});

chrome.storage.onChanged.addListener(handleStorageChanged);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);
void initializeUiState();