# Sainte Devote

[English Version](README.md)

Sainte Devote は、Monaco Editor をベースにしたマルチタブ型 Markdown エディタです。Electron を使用して構築されています。

https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92

## 機能

-   **コマンドパレット (`Cmd/Ctrl + P`)**: 操作コマンドへのアクセス、タブの切り替え、および全タブを対象としたキーワード検索（該当行へのジャンプ）が可能です。
-   **シンタックスハイライト**:
    -   **エディタ**: Monaco Editor を搭載し、Markdown やコードの編集に対応。
    -   **プレビュー**: `highlight.js` によるコードブロックのハイライト表示。
-   **エクスポート**: 全てのタブを一つの `.zip` ファイルとしてまとめて保存できます。
-   **ファイル連携**:
    -   ダイアログ、ドラッグ＆ドロップ、最近使ったファイル、Finder / Explorer から `.md` / `.markdown` / `.txt` を直接開けます。
    -   ファイルに紐付いたタブは、入力のたびにディスクへ自動保存されます。
    -   他のプログラムによるファイルの変更を検知し、開いているタブへ自動反映します。編集中に外部変更が来た場合は「Reload from disk / Keep my version」の選択バナーを表示し、ファイルがディスク上から削除された場合は Save As するまで自動保存を停止します。
-   **タブ管理**:
    -   ドラッグ＆ドロップによる並べ替え。
    -   クリックによるタブのリネーム。
    -   IndexedDB による作業内容の自動保存。
-   **UI 設定**:
    -   タブバーの水平スクロール。
    -   コンテキストメニューによるタブ操作。
    -   エディタとプレビューの切り替え。
-   **タイトルバー**: アプリ UI と一体化したフレームレスタイトルバー（ウィンドウ操作および検索トリガーを含む）。
-   **設定 (`Cmd/Ctrl + ,`)**: エディタのフォント、プレビューのフォント（種類・サイズ）、テーマをユーザーが変更可能。歯車アイコン・コマンドパレット（`Open Settings`）・ショートカットから開けます。
-   **テーマ**: **システム / ライト / ダーク** を選択可能。システムは OS 設定に連動し、ライト・ダークは固定表示。設定画面またはコマンドパレット（`Theme: Use System / Light / Dark`）から切替できます。

## 使い方

### インストール

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
    pnpm dev
    ```

### ビルド

-   **macOS**: `pnpm build:mac`
-   **Windows**: `pnpm build:win`
-   **Linux**: `pnpm build:linux`

macOS版の動作要件はmacOS 12以降です。

ビルド済みファイルは `dist` フォルダに出力されます。

## 設定

`monacorc.json` を編集することで、フォントサイズやテーマ、その他 Monaco Editor の詳細設定を変更できます。

## ライセンス

MIT ライセンス。
