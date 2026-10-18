# Sainte Devote

[English Version](README.md)

Sainte Devote は、Rust、Tauri 2、Monaco Editor で構築された軽量なクロスプラットフォーム Markdown エディタです。

https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92

## 機能

-   **コマンドパレット (`Cmd/Ctrl + P`)**: 操作コマンドへのアクセス、タブの切り替え、および全タブを対象としたキーワード検索（該当行へのジャンプ）が可能です。
-   **シンタックスハイライト＆プレビュー**:
    -   **エディタ**: Monaco Editor を搭載し、Markdown やコードの編集に対応。
    -   **プレビュー**: `highlight.js` によるコードブロックのハイライト表示、ワンクリックのコードコピーボタン、および GitHub 形式のアラート（`[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`）に対応。
-   **エクスポート**: 現在のウィンドウで開いている全てのタブを一つの `.zip` ファイルとしてまとめて保存できます。
-   **ファイル連携**:
    -   ダイアログ、ドラッグ＆ドロップ、最近使ったファイル、Finder / Explorer から `.md` / `.markdown` / `.txt` を直接開けます。
    -   ファイルに紐付いたタブは、入力のたびにディスクへ自動保存されます。
    -   他のプログラムによるファイルの変更を検知し、開いているタブへ自動反映します。編集中に外部変更が来た場合は「Reload from disk / Keep my version」の選択バナーを表示し、ファイルがディスク上から削除された場合は Save As するまで自動保存を停止します。
-   **タブ＆ウィンドウ管理**:
    -   ドラッグ＆ドロップによる並べ替えと、インラインでのタブリネーム。
    -   IndexedDB によるウィンドウ単位の作業内容の自動保存。
    -   新規ウィンドウの作成（`Cmd/Ctrl + Shift + N`）、タブの右クリックメニュー「Open in New Window」、およびタブをウィンドウ外へドラッグして新しいウィンドウとして切り出す・別の Sainte Devote ウィンドウへドロップして統合するマルチウィンドウ操作に対応。
    -   **アーカイブ（Archived Tabs）**: 内容のあるスクラッチタブを閉じた際、内容を破棄せず自動的にアーカイブ（最大 50 件）へ退避します。タブバー右端のアーカイブボタンまたはコマンドパレット（`Open Archived Tabs`）から、いつでも復元（Restore）や完全削除が可能です。
-   **UI 設定**:
    -   タブバーの水平スクロール。
    -   コンテキストメニューによるタブ操作。
    -   エディタとプレビューの切り替え。
-   **タイトルバー**: アプリ UI と一体化したフレームレスタイトルバー（ウィンドウ操作および検索トリガーを含む）。
-   **設定 (`Cmd/Ctrl + ,`)**: エディタおよびプレビューのフォント（種類・サイズ）、テーマに加え、macOS では **Window Opacity**（ウィンドウ不透明度: 30〜100%）および **Window Blur**（背景ブラー: `Off` / `Dense` / `Sheer`）を変更可能。歯車アイコン・コマンドパレット（`Open Settings`）・ショートカットから開けます。
-   **テーマ**: **システム / ライト / ダーク** を選択可能。システムは OS 設定に連動し、ライト・ダークは固定表示。設定画面またはコマンドパレット（`Theme: Use System / Light / Dark`）から切替できます。

## インストール

[Releases](https://github.com/izumiz-dev/sainte-devote/releases) ページから、お使いの OS に合わせた最新のインストーラー／パッケージをダウンロードしてください。

-   **macOS**: `.dmg`（macOS 12 以降が必要）
-   **Windows**: `.exe`（NSIS インストーラー）
-   **Linux**: `.AppImage` または `.deb`

## 開発・ビルド

### 開発用ローカル実行

ソースコードからローカルで実行する場合:

1.  リポジトリをクローン:
    ```bash
    git clone git@github.com:izumiz-dev/sainte-devote.git
    cd sainte-devote
    ```
2.  依存関係をインストール:
    ```bash
    pnpm install
    ```
3.  実行:
    ```bash
    pnpm tauri:dev
    ```

### ビルド

対象OS上で `pnpm tauri:build` を実行します。Tauriの設定により、次の形式を生成します。

-   **macOS**: `.app` / `.dmg`
-   **Windows**: NSISインストーラー
-   **Linux**: AppImage / Debianパッケージ

macOS版の動作要件はmacOS 12以降です。

ビルド済みファイルは `src-tauri/target/release/bundle` 以下に出力されます。

変更を完了する前に次の検証を実行します。

```bash
pnpm check:tauri
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:frontend
```

## Electron版からの移行

Electron版とTauri版ではWebViewのデータ保存領域が異なるため、Electron版のスクラッチタブは
自動移行されません。アップグレード前にElectron版の **Export All Tabs (.zip)** を実行し、
ZIPをバックアップとして保管してください。すでに`.md`、`.markdown`、`.txt`として保存した
実ファイルは、アプリのビルド処理によって変更・削除されません。

未バンドルの`pnpm tauri:dev`と、macOSへインストールした`.app`も別のWebKit保存領域を使います。
**Export All Tabs** は今開いているウィンドウのタブだけを書き出します。dev版から
インストール版へ切り替える前に、ウィンドウごとにZIP Exportしてください。同じ
`dev.izumiz.sainte-devote` identifierを維持したインストール版同士の置き換えではデータが
保持されますが、identifierを変更すると別の保存領域になります。

アップグレード時、スクラッチタブは新しいデータベース `SainteDevoteWorkspaces` にコピーされ、
以前のデータベースは残ります。アップグレード前にウィンドウごとに Export してください。
古い 2.0.x はアップグレード前のスクラッチタブを表示できます。アップグレード後に作ったタブは
新しいデータベースにだけ入ります。

## 設定

`monacorc.json` を編集することで、フォントサイズやテーマ、その他 Monaco Editor の詳細設定を変更できます。

## ライセンス

MIT ライセンス。
