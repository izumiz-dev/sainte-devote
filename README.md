# Sainte Devote

Sainte Devote は、シンプルな Monaco Editor ベースのテキストエディタです。Electron を使用して構築されており、クロスプラットフォームで動作します。

## 特徴

- シンプルで使いやすいインターフェース
- Monaco Editor の強力な編集機能
- ダークモードとライトモードの切り替え
- クロスプラットフォーム対応（macOS、Windows、Linux）

## インストール

1. このリポジトリをクローンします： `git clone git@github.com:izumiz-dev/sainte-devote.git`
2. プロジェクトディレクトリに移動します： `cd sainte-devote`
3. 依存関係をインストールします： `npm install`
4. アプリケーションをビルドするには：

- macOS: `npm run build:mac`
- Windows: `npm run build:win`
- Linux: `npm run build:linux`

4. `dist`フォルダにビルド済みファイルが格納されます

## 設定

エディタの設定は`monacorc.json`ファイルで管理されています。このファイルを編集することで、フォントサイズ、テーマ、その他のエディタ設定をカスタマイズできます。

## ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。
