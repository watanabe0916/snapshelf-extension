# ClipShelf Extension

ClipShelf is a Chrome extension (Manifest V3) designed to help users capture, organize, and manage cropped screenshots and page URLs into named collections called "Shelves".

## Project Overview

- **Purpose:** Efficiently capture and categorize visual information from the web.
- **Main Technologies:**
    - **JavaScript:** Vanilla JS for logic and UI interaction.
    - **Database:** [Dexie.js](https://dexie.org/) (wrapper for IndexedDB) for storing screenshots and metadata.
    - **UI/UX:** HTML5, CSS3 (with CSS Variables), and Material Symbols for icons.
    - **Architecture:** Chrome Extension Manifest V3 (Service Worker, Content Scripts, Side Panel/Action UI).

## Architecture & File Structure

- `manifest.json`: Extension configuration, permissions, and entry points.
- `background.js`: The Service Worker. Manages the extension lifecycle, handles messaging between components, performs tab captures, and manages state in `chrome.storage`.
- `content.js`: Injected into web pages. Handles area selection logic (dragging to crop) and keyboard shortcuts.
- `db.js`: Database schema and helper functions for Dexie.js.
- `panel.html` & `panel.js`: The main user interface for managing shelves, viewing saved images, and adjusting settings.
- `lib/`: Contains external libraries (`dexie.min.js`).
- `_locales/`: I18n support for multiple languages (EN, JA, DE, ES, FR, KO, ZH).
- `icons/`: Extension icons in various sizes.

## Building and Running

### Development
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked** and select the root directory of this project.

### Building
Currently, there is no build or compilation step. The project uses standard web technologies that the browser can execute directly.

### Testing
- **Manual Testing:** Open the extension UI, create a shelf, and use the shortcut keys (default 'S' + drag) to capture screenshots.
- **TODO:** Implement automated tests for core database logic and messaging.

## Development Conventions

- **Internationalization:** Always use `chrome.i18n.getMessage` for UI strings. Add new strings to all files in `_locales/`.
- **State Management:** Use `chrome.storage.local` for simple settings and `db.js` (IndexedDB) for large data like images.
- **Messaging:** Use the defined `MESSAGE_TYPES`, `EVENT_TYPES`, and `ACTION_TYPES` constants to maintain consistency in communication between `background.js`, `content.js`, and `panel.js`.
- **Styling:** Use CSS variables defined in `:root` of `panel.html` for consistent colors, spacing, and rounding.
- **Error Handling:** Use `try...catch` for database operations and provide user feedback via the UI state.
