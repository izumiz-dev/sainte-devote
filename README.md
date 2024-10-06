# Sainte Devote

Sainte Devote は、シンプルな Monaco Editor ベースのテキストエディタです。Electron を使用して構築されており、クロスプラットフォームで動作します。

<p align="center">
  <img src="https://github.com/user-attachments/assets/bb68bdb4-943d-4f10-b678-adc8e1374a7e" width="150" alt="アプリアイコン">
</p>


## 特徴

- シンプルで使いやすいインターフェース
- Monaco Editor の強力な編集機能
- ダークモードとライトモードの切り替え
- クロスプラットフォーム対応（macOS、Windows、Linux）


<p align="center">
  <img src="https://github.com/user-attachments/assets/5e1659e4-4e45-4d6b-b6d1-9f3ca91d8eec" width="800" alt="スクリーンショット">
</p>



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
