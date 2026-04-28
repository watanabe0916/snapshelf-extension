// ウィンドウが閉じられる直前に、現在の位置とサイズをストレージに保存する
window.addEventListener('beforeunload', () => {
    chrome.storage.local.set({
        uiPanelLeft: window.screenX,
        uiPanelTop: window.screenY,
        uiPanelWidth: window.outerWidth,
        uiPanelHeight: window.outerHeight
    });
});