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
        isTabSaveKeyDown: false,
    };

    let currentActiveShelfId = null;
    let settingKeySaveImage = 's';
    let settingKeySaveTab = 'a';
    let settingPromptForName = false;

    // キーが離されるのを待機するための変数
    let pendingCapture = null;

    function normalizeStorageId(value) {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    function hasActiveShelfId() {
        return Boolean(currentActiveShelfId);
    }

    chrome.storage.local.get([
        STORAGE_KEYS.ACTIVE_SHELF_ID,
        'keySaveImage',
        'keySaveTab',
        'promptForName'
    ], (result) => {
        currentActiveShelfId = normalizeStorageId(result[STORAGE_KEYS.ACTIVE_SHELF_ID]);
        settingKeySaveImage = (result.keySaveImage || 's').toLowerCase();
        settingKeySaveTab = (result.keySaveTab || 'a').toLowerCase();
        settingPromptForName = !!result.promptForName;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            if (changes[STORAGE_KEYS.ACTIVE_SHELF_ID]) {
                currentActiveShelfId = normalizeStorageId(changes[STORAGE_KEYS.ACTIVE_SHELF_ID].newValue);
                if (!hasActiveShelfId()) {
                    resetSelectionInteractionState();
                }
            }
            if (changes.keySaveImage) settingKeySaveImage = (changes.keySaveImage.newValue || 's').toLowerCase();
            if (changes.keySaveTab) settingKeySaveTab = (changes.keySaveTab.newValue || 'a').toLowerCase();
            if (changes.promptForName) settingPromptForName = !!changes.promptForName.newValue;
        }
    });

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
        overlay.style.touchAction = 'none';
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
        keyboardState.isTabSaveKeyDown = false;
        pendingCapture = null;
    }

    function askForImageName() {
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const defaultName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

        if (!settingPromptForName) return defaultName;

        const promptMsg = chrome.i18n.getMessage('uiPromptEnterName') || "保存する画像の名前を入力してください:";
        const userInput = window.prompt(promptMsg, defaultName);

        if (userInput === null) return null;
        return userInput.trim() || defaultName;
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

        try {
            if (event.target && typeof event.target.setPointerCapture === 'function') {
                event.target.setPointerCapture(event.pointerId);
            }
        } catch (e) {
        }
    }

    function endSelection() {
        selectionState.isDragging = false;
        selectionState.activeShelfId = null;
        removeOverlay();

        try {
            document.documentElement.releasePointerCapture(event?.pointerId);
        } catch (e) { }
    }

    function scheduleSelectionCapture(rect, activeShelfId) {
        // OSのキー操作が完全に完了するのを待つため僅かな遅延を入れる
        setTimeout(() => {
            const customName = askForImageName();
            if (customName === null) return;

            window.setTimeout(() => {
                chrome.runtime.sendMessage({
                    type: MESSAGE_TYPES.CAPTURE_SELECTION,
                    activeShelfId,
                    pageUrl: window.location.href,
                    customName: customName,
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
        }, 10);
    }

    function captureFullTab() {
        const activeShelfId = currentActiveShelfId;
        if (!activeShelfId) return;

        setTimeout(() => {
            const customName = askForImageName();
            if (customName === null) return;

            const rect = {
                x: 0,
                y: 0,
                width: window.innerWidth,
                height: window.innerHeight
            };

            window.setTimeout(() => {
                chrome.runtime.sendMessage({
                    type: MESSAGE_TYPES.CAPTURE_SELECTION,
                    activeShelfId: activeShelfId,
                    pageUrl: window.location.href,
                    customName: customName,
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
        }, 10);
    }

    function finalizeSelection(eventX, eventY) {
        if (!selectionState.isDragging) return;
        selectionState.isDragging = false;

        try {
            if (pointerId !== undefined && document.documentElement.hasPointerCapture(pointerId)) {
                document.documentElement.releasePointerCapture(pointerId);
            }
        } catch (e) { }

        const finalX = Number.isFinite(eventX) ? eventX : selectionState.lastX;
        const finalY = Number.isFinite(eventY) ? eventY : selectionState.lastY;
        const activeShelfId = selectionState.activeShelfId || currentActiveShelfId;
        selectionState.activeShelfId = null;

        removeOverlay();

        const rect = getRectFromPoints(selectionState.startX, selectionState.startY, finalX, finalY);
        if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) return;
        if (!activeShelfId) return;

        if (keyboardState.isSelectionKeyDown) {
            // キーがまだ押されている場合はキャプチャを保留
            pendingCapture = { rect, activeShelfId };
        } else {
            scheduleSelectionCapture(rect, activeShelfId);
        }
    }

    function isEditableTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    }

    function handleKeyDown(event) {
        if (!hasActiveShelfId() || isEditableTarget(event.target)) return;

        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

        if (key === settingKeySaveImage) {
            event.preventDefault();
            event.stopPropagation();
            keyboardState.isSelectionKeyDown = true;
            keyboardState.isSelectionKeyPressed = true;
        } else if (key === settingKeySaveTab) {
            if (!event.repeat) {
                event.preventDefault();
                event.stopPropagation();
                keyboardState.isTabSaveKeyDown = true;
            }
        }
    }

    function handleKeyUp(event) {
        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

        if (key === settingKeySaveImage) {
            keyboardState.isSelectionKeyDown = false;
            keyboardState.isSelectionKeyPressed = false;

            if (selectionState.isDragging) {
                event.preventDefault();
                event.stopPropagation();
                finalizeSelection();
            } else if (pendingCapture) {
                // キーが離されたタイミングで保留していたキャプチャを実行
                event.preventDefault();
                event.stopPropagation();
                const { rect, activeShelfId } = pendingCapture;
                pendingCapture = null;
                scheduleSelectionCapture(rect, activeShelfId);
            }
        } else if (key === settingKeySaveTab) {
            if (keyboardState.isTabSaveKeyDown) {
                keyboardState.isTabSaveKeyDown = false;
                event.preventDefault();
                event.stopPropagation();
                captureFullTab();
            }
        }
    }

    function handlePointerDown(event) {
        if (!hasActiveShelfId() || event.button !== 0 || !keyboardState.isSelectionKeyPressed || selectionState.isDragging) return;
        event.preventDefault();
        event.stopPropagation();
        beginSelection(event, currentActiveShelfId);
    }

    function handlePointerMove(event) {
        if (!hasActiveShelfId() || !selectionState.isDragging) return;
        /*if ((event.buttons & 1) === 0) {
            finalizeSelection();
            return;
        }*/
        event.preventDefault();
        event.stopPropagation();
        updateOverlayRect(event.clientX, event.clientY);
    }

    function handlePointerUp(event) {
        if (!hasActiveShelfId() || !selectionState.isDragging) return;
        event.preventDefault();
        event.stopPropagation();
        finalizeSelection(event.clientX, event.clientY, event.pointerId);
    }

    function handlePointerCancel(event) {
        if (!hasActiveShelfId() || !selectionState.isDragging) return;
        event.preventDefault();
        event.stopPropagation();
        endSelection();
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
        keyboardState.isTabSaveKeyDown = false;
        if (selectionState.isDragging) endSelection();
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.action === ACTION_TYPES.FORCE_DISABLE_SELECTION) {
            resetSelectionInteractionState();
        }
    });

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    document.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
    document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    document.addEventListener('pointerup', handlePointerUp, { capture: true, passive: false });
    document.addEventListener('pointercancel', handlePointerCancel, { capture: true, passive: false });
    document.addEventListener('dragstart', blockNativeSelectionWhileDragging, true);
    document.addEventListener('selectstart', blockNativeSelectionWhileDragging, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('blur', handleWindowBlur, true);

})();