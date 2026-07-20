# Rust 書き換え計画(Tauri 2 ハイブリッド)

作成日: 2026-07-12 / ブランチ: `rust-rewrite`

## 方針とゴール

Electron の main プロセス(`src/main.js`, 910行)の役割を **Rust + Tauri 2** で書き直し、
レンダラー(`src/renderer.js`, 2,225行 + Monaco / marked / DOMPurify / highlight.js)は
OS WebView 上でほぼそのまま流用する。

主目的(優先順):

1. **配布サイズ・メモリ削減** — Chromium 同梱をやめ OS WebView を使う(バンドル ~100MB → 数MB 級)
2. **Electron 依存脱却・保守性** — Electron のメジャーバージョン追従・セキュリティ境界管理からの解放
3. 温度感は**実験** — main ブランチの Electron 版は完成するまで温存し、いつでも戻れる段階的計画にする

### 非ゴール

- フルネイティブ Rust GUI(egui / iced / Slint)への移行。Monaco を失いエディタ再実装になるため対象外
- Markdown レンダリングの Rust 化(comrak 等)。marked + DOMPurify をフロントに残し Rust 側は薄く保つ
- IndexedDB / localStorage の置き換え。WebView のストレージをそのまま使う

## 実現可能性調査の結論(2026-07 時点)

- **Tauri 2 は成熟**: 2024-10 に stable、現行 2.9.x。ファイル関連付け(macOS `RunEvent::Opened`)、
  シングルインスタンス、ネイティブメニュー、dmg/nsis/AppImage/deb バンドル、notarization まで揃う
- **前例あり**: Tauri 製 Markdown エディタ(MarkPad 等)が file association + single-instance 連携を実装済み
- **WebView 差異が最大リスク**: macOS = WKWebView、Windows = WebView2(Chromium 系)、
  Linux = WebKitGTK(遅い・癖あり)。現行は全 OS Chromium なので、特に macOS/Linux で挙動確認が必須
- 参考: [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/) /
  [Webview Versions](https://v2.tauri.app/reference/webview-versions/) /
  [File Associations](https://v2.tauri.app/learn/mobile-file-associations/)(デスクトップ節あり) /
  [MarkPad (Tauri 製 Markdown エディタ)](https://github.com/lezli01/markpad)

## アーキテクチャ対応表

| 現行 (Electron) | 移行後 (Tauri 2) |
| --- | --- |
| `main.js` — main プロセス | `src-tauri/src/` の Rust モジュール群 |
| `preload.js` — `contextBridge` + IPC allowlist | 廃止。`window.__TAURI__`(`withGlobalTauri: true`)+ capabilities で権限を宣言的に制限 |
| `ipcMain.on/handle`(12ch) | `#[tauri::command]` + `emit`(renderer 向けイベント) |
| `dialog.showOpenDialog / showSaveDialog` | `tauri-plugin-dialog`(Rust 側から呼ぶ) |
| `fs.watch`(親ディレクトリ監視)+ sha256 フィルタ | `notify` クレート + `sha2`。ロジックはそのまま移植 |
| JSZip(ZIP エクスポート) | `zip` クレート |
| `nativeTheme` → `theme-changed` | `WindowEvent::ThemeChanged` → emit |
| `shell.openExternal` + protocol allowlist | `open` クレート。**http/https/mailto の allowlist 判定は Rust コマンド内に温存** |
| `app.requestSingleInstanceLock` + `second-instance` | `tauri-plugin-single-instance`(argv 受け渡し込み) |
| macOS `open-file` イベント | `RunEvent::Opened { urls }` |
| `app.addRecentDocument` + 独自 recent-files.json | 独自 JSON は同形式で移植(`app_data_dir`)。OS ネイティブの最近使った書類は当面見送り |
| `monacorc.json` を main が読み `monaco-settings` 送信 | Tauri resource として同梱し、Rust コマンドで読んで返す |
| `will-navigate` / `setWindowOpenHandler` 遮断 | Tauri は外部ナビゲーションをデフォルト拒否 + CSP。リンクは従来どおり renderer → `open_external` コマンド |
| electron-builder(dmg/nsis/AppImage/deb, notarize) | `tauri bundler`(同等のターゲットをサポート) |
| electronmon ホットリロード | `pnpm tauri dev`(フロント自動リロード + Rust 再ビルド) |

### 移植必須のセキュリティ資産(main.js 由来)

Rust 側でも同じ性質を保証する。むしろ型で守りやすくなる部分:

- `validateReadableFilePath` / `validateWritableFilePath` / `validateExportFilePath`
  (拡張子 allowlist、UNC 拒否、パス中のシンボリックリンク検査、NUL 拒否)
- `O_NOFOLLOW` 相当の open(Unix: `OpenOptionsExt::custom_flags(libc::O_NOFOLLOW)`。
  Windows は reparse point 検査で代替)
- `activeFilePaths` による**書き込み許可セット**(ユーザーのファイル選択ジェスチャを経たパスのみ autosave 可、
  recent からの再オープンは read-only)→ `Mutex<HashSet<PathBuf>>` を Tauri managed state に
- DOMPurify サニタイズはフロント側でそのまま継続

## リポジトリ構成案

Electron と Tauri の二重運用はしない。**このブランチ上で Electron 構成を置き換え**、
main ブランチが Electron 版のまま残ることで併走を実現する。

```
src-tauri/
  Cargo.toml
  tauri.conf.json        # identifier は dev.izumiz.sainte-devote を継続
  capabilities/main.json # webview に許可する API の宣言
  src/
    main.rs / lib.rs     # setup, RunEvent::Opened, single-instance, renderer_ready キュー
    validate.rs          # パス検証(上記セキュリティ資産)
    files.rs             # open/save/autosave/recent/dropped コマンド群
    file_sync.rs         # notify + sha256 + debounce + focus 再チェック
    export.rs            # ZIP エクスポート
    menu.rs              # ネイティブメニュー(PredefinedMenuItem + カスタム → menu-action emit)
    settings.rs          # monacorc.json 読み込み
frontend/                # 旧 index.html + renderer.js + main.css の移設先
  index.html
  renderer.js
  tauri-bridge.js        # 旧 window.electron API を __TAURI__ 上に再実装する互換シム
  vendor/                # scripts/vendor.mjs が node_modules からコピー(monaco, marked, dompurify, hljs, github-markdown-css)
scripts/vendor.mjs
package.json             # pnpm は残す(フロント依存管理 + @tauri-apps/cli)
```

- レンダラーは `window.electron.send/on/invoke` を呼び続け、差分は `tauri-bridge.js` に閉じ込める
  (renderer.js 本体の変更は D&D・renderer-ready まわりの最小限に抑える)
- `index.html` が `node_modules/` を直接参照している箇所は `vendor/` 参照に変更
  (DOMPurify → AMD loader の**読み込み順は維持**)
- D&D は Electron の `webUtils.getPathForFile` が使えないため、Tauri の
  `onDragDropEvent`(パスは Rust 経由で届く)に置き換え。ドロップオーバーレイ表示も
  `drag-enter` / `drag-leave` イベント駆動に変更

## フェーズ計画

各フェーズは `pnpm tauri dev` での手動確認を基本とし、Rust の純粋ロジックには単体テストを追加する。

### 実装状況（2026-07-20）

- **Phase 0: Go 判定** — WKWebView 上で Monaco、日本語 IME、IndexedDB/localStorage の再起動後復元、
  ショートカット、macOS overlay タイトルバーとドラッグ、ファイル D&D を実機確認済み。
- **Phase 1: 完了** — `frontend/`、vendor 資産、Electron 互換の `tauri-bridge.js`、テーマ・設定を実装。
- **Phase 2: 完了** — open/save/autosave/recent/D&D/argv/Finder/renderer-ready キューを実装。
  single-instance の第二起動ファイル転送とパッケージ時の `.md` / `.markdown` file association を実機確認済み。
- **Phase 3: 完了** — `file_sync.rs` に親ディレクトリ監視、SHA-256 自己書き込み抑制、
  200ms debounce、読み込みリトライ、削除通知、フォーカス再確認、close 時の監視解除を実装。
  direct write、atomic rename、削除/再作成、自己書き込み抑制、unwatch、フォーカス復帰を実機確認済み。
  削除中に編集した場合だけ競合とし、未編集なら再作成内容をサイレント復元する。
  direct write、atomic rename、削除/再作成、自己書き込み抑制、unwatch の Rust テストを追加。
- **Phase 4: 完了** — preview と Monaco の Cmd+Click を Rust の http/https/mailto allowlist 経由で開く。
  ネイティブメニューと Rust `zip` クレートによる全タブ ZIP エクスポートを実装・実機確認済み。
- **Phase 5: 最終検証中** — CSP、file association、macOS/Windows/Linux 別 bundle 設定、Tauri CI を実装。
  Electron 構成・依存・CI を削除し、tag release workflow を Tauri の DMG/NSIS/AppImage/deb へ切り替えた。
  macOS debug/release `.app` と DMG の生成、`Info.plist`、DMG checksum・内容を確認済み。
  Tauri dev と installed release は別のWebKit領域になること、同一identifierのrelease版置き換えでは
  release側データが保持されることを実機確認済み。署名・notarization、Windows/Linuxインストーラー、
  バージョン 2.0.0 は未検証・未完了。
- 品質ゲート: `pnpm check:tauri`（frontend lint、fmt、check、Clippy）と Rust テスト 14 件を追加。

### Phase 0 — スパイク & Go/No-Go 判定(タイムボックス: 1セッション)

`create-tauri-app` で骨組みを作り、既存 index.html + Monaco を WKWebView で表示するだけの検証。

確認項目(**ひとつでも致命的なら中止して main に戻る**):

- [x] Monaco が `tauri://` カスタムプロトコル配信で起動する(AMD loader / web worker。
      vendor 資産を実ファイルへコピーすることで WKWebView から読み込み)
- [x] **日本語 IME 入力**が WKWebView 上の Monaco で問題ないか(変換・確定・インライン表示)
- [x] IndexedDB / localStorage がアプリ再起動を跨いで永続するか
- [x] ファイル D&D でパスが取得できるか（オーバーレイ表示と内容の読み込みを実機確認）
- [x] Cmd+P / Cmd+N 等のショートカットが WebView に届くか
- [x] macOS overlay タイトルバー(`titleBarStyle: Overlay`)で現行の見た目に近づくか

### Phase 1 — フロントエンド移植

- `frontend/` へ移設、`vendor.mjs` 作成、`tauri-bridge.js` 実装
- Rust: `get_monaco_settings` コマンド(monacorc.json + theme + platform)、theme-changed emit
- ゴール: スクラッチタブ・プレビュー・パレット・設定・テーマ切替が全部動く(ファイル I/O なし)

### Phase 2 — ファイル I/O

- コマンド: `open_file_dialog` / `save_file_as` / `save_file_to_path`(activeFilePaths 認可付き)/
  `close_file` / `get_recent_files` / `open_recent_file`(read-only)/ D&D オープン
- 起動経路: argv、`RunEvent::Opened`(macOS 関連付け)、single-instance 第二起動、
  `renderer_ready` までのキューイング(`flushPendingFileOpens` 相当)
- ウィンドウタイトル更新(macOS represented filename は ns_window 直叩きが必要なら後回し可)

### Phase 3 — 外部変更検知

- `notify` で親ディレクトリ監視、200ms debounce、sha256 自己書き込みフィルタ、
  読み取り前の再検証、リトライ、`file-changed-externally` / `file-removed-externally` emit
- ウィンドウフォーカス時の全ファイル再チェック(`WindowEvent::Focused`)
- ゴール: VS Code 等で編集 → サイレントリロード / 競合バナーが現行同様に動く

### Phase 4 — メニュー・外部リンク・エクスポート

- ネイティブメニュー(`PredefinedMenuItem` + カスタム項目 → `menu-action` emit)。
  Electron の `role: reload/zoom` 系に相当がないものは JS 実装 or 削除を判断
- `open_external`(allowlist 判定を Rust で)、ZIP エクスポート(`zip` クレート)
- Windows タイトルバー: `titleBarOverlay` 相当がないため**当面ネイティブ装飾で妥協**
  (現行 Linux と同じ扱い)。カスタム化は移行完了後の改善項目

### Phase 5 — パッケージングとパリティ確認

- アイコン、file associations(`.md` / `.markdown`)、dmg + notarize、nsis、AppImage/deb
- macOSではdevが`~/Library/WebKit/sainte-devote`、installed releaseが
  `~/Library/WebKit/dev.izumiz.sainte-devote`を使うため、切替前のZIP Exportを案内。
  同一identifierのrelease版置き換えではrelease側のIndexedDB/localStorageが保持されることを確認
- README(en/ja)更新、バージョン 2.0.0
- パリティチェックリスト(現行機能の全項目を手動確認)→ 合格したら main へマージ判断

## 現在の検証コマンド

```bash
pnpm lint          # Tauri frontend と補助スクリプト
pnpm check:tauri   # Tauri frontend lint + cargo fmt/check/clippy
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri:dev     # 実アプリでの手動パリティ確認
```

Rust 単体テストは Save As の拡張子補完、外部 URL allowlist、SHA-256 ハッシュに加え、
外部ファイル監視の direct write、atomic rename、削除/再作成、own-write 抑制、unwatch を対象とする。
外部ファイル監視は上記ケースと競合バナーをすべて実機確認済み。

macOS の release build は Cargo 1.97.0 の deferred debuginfo stripping で proc-macro 読み込みが
失敗するため、`Cargo.toml` の `[profile.release]` で `strip = false` を明示する。

## リスクと対応

| リスク | 影響 | 対応 |
| --- | --- | --- |
| WKWebView での Monaco IME / worker 問題 | 致命的(エディタの根幹) | Phase 0 の Go/No-Go 項目。ダメなら中止 |
| Linux WebKitGTK の性能・癖 | 中(Linux は副次ターゲット) | 劣化は許容。main の Electron 版が残るので致命傷にならない |
| **既存ユーザーのスクラッチタブが移行されない**(Electron と Tauri で IndexedDB の実体が別) | 中 | 旧版の「Export All Tabs (.zip)」で退避 → 新版で開く手順を README に明記。自動移行は作らない |
| Windows の titleBarOverlay 非対応 | 小(見た目のみ) | ネイティブ装飾で出荷、後日カスタムタイトルバー検討 |
| Electron `role:` メニューの非互換(reload/zoom 等) | 小 | 開発用途中心なので削減方向で整理 |
| Rust 学習コスト・ビルド環境(cargo, mise への rust 追加) | 小〜中 | Phase 0 で体感してから判断 |

## 規模感

- Rust: 目安 1,000〜1,500 行(main.js 910 行の移植 + Tauri ボイラープレート)
- フロント差分: `tauri-bridge.js` 新規 ~150 行 + renderer.js の D&D / ready まわり数十行
- Phase 0–1 で全体の実現性が確定する。以降は淡々と移植
