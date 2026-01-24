# Sainte Devote

Sainte Devote は、シンプルな Monaco Editor ベースのテキストエディタです。Electron を使用して構築されており、クロスプラットフォームで動作します。



https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92


## 特徴

- シンプルで使いやすいインターフェース
- Monaco Editor の強力な編集機能
- ダークモードとライトモードの切り替え
- クロスプラットフォーム対応（macOS、Windows、Linux）

## インストール

1. このリポジトリをクローンします： `git clone git@github.com:izumiz-dev/sainte-devote.git`
2. プロジェクトディレクトリに移動します： `cd sainte-devote`
3. 依存関係をインストールします： `pnpm install`
4. アプリケーションをビルドするには：

- macOS: `pnpm build:mac`
- Windows: `pnpm build:win`
- Linux: `pnpm build:linux`

4. `dist`フォルダにビルド済みファイルが格納されます

## 設定

エディタの設定は`monacorc.json`ファイルで管理されています。このファイルを編集することで、フォントサイズ、テーマ、その他のエディタ設定をカスタマイズできます。

## ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。
