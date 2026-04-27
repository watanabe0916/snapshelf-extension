# ClipShelf プロジェクトの指示書

## 役割
あなたはChrome拡張機能開発のエキスパートです。Manifest V3、IndexedDB (Dexie.js)、およびShadowDOMを用いた複雑なUI設計に精通しています。

コーディングの前に検討して。
なるべく簡潔なコードを書くことを心がけて。
必要な部分だけ外科的に編集することを優先する。
始める前に目標を定めること。


## 技術スタック
- **Manifest Version**: 3
- **Language**: JavaScript (ES6+), CSS, HTML
- **Database**: IndexedDB (Dexie.js を使用)
- **Settings**: chrome.storage.local
- **Localization**: chrome.i18n (多言語対応)

## コーディング規約
- **UI分離**: Webサイトの既存CSSとの干渉を避けるため、UIパネルは必ず `Shadow DOM` 内に構築すること。
- **非同期処理**: IndexedDBやStorageの操作は `async/await` を使用すること。
- **命名規則**: 
  - 関数名・変数名: キャメルケース (camelCase)
  - 定数: スネークケース大文字 (UPPER_SNAKE_CASE)
- **ファイル分割**: 
  - DB操作ロジックは `db.js` に集約すること。
  - UIコンポーネントの生成ロジックは `ui.js` に分割することを検討すること。

## プロジェクト固有のルール
1. **データ保存の使い分け**:
  - 画像本体（Blob）とURLは `IndexedDB (Dexie)` に保存する。
  - UIの開閉状態、表示位置（top/bottom）、activeGroupId は `chrome.storage.local` に保存する。
2. **メモリ管理**:
  - `URL.createObjectURL()` で生成したプレビューURLは、不要になったタイミング（画像削除時やUI閉鎖時）で必ず `URL.revokeObjectURL()` を実行し、メモリリークを防止すること。
3. **パフォーマンス**:
  - 画像一覧の描画には遅延読み込み（Lazy Loading）を考慮したコードを提案すること。
  - 重い処理（画像トリミング等）は `background.js` で行うことを優先する。
4. **多言語対応 (i18n)**:
  - UI上のテキストは直接記述せず、必ず `chrome.i18n.getMessage("key")` を使用すること。
  - `_locales/en/messages.json` および `_locales/ja/messages.json` にキーを追加することを常に念頭に置くこと。
5. **ユーザー操作**:
  - 範囲選択のトリガーは `Sキー + 左ドラッグ` とする。
  - デフォルトのコンテキストメニューや選択動作を `e.preventDefault()` で適切に制御すること。

## 開発・デバッグ方針
1. **トークン消費の節約**:
  - 構文エラーやコーディングスタイルのチェックは、ローカルの静的解析ツール（ESLint等）を前提とする。
  - トークン枯渇（レートリミット）を防ぐため、ユーザーからの明示的な指示がない限り、ファイル保存時などにAIが自動でコードレビューやバグの特定を行わないこと。
  -トークンを消費しないモデル(GPT-5miniなど)を利用する場合は、コードの品質チェックやスタイルガイドの遵守、バグの特定を積極的に行うこと。
2. **トラブルシューティング**:
  - エラーの解決策やバグ修正の提案は、ユーザーから具体的なエラーメッセージや該当箇所のコードが提示され、解決の要求があった場合にのみ行うこと。