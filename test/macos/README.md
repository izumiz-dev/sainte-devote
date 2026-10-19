# macOS E2E 動作検証(`test/macos/`)

ビルド済みの `Sainte Devote.app` を **macOS のアクセシビリティ API 経由で実際に操作**し、
ファイルの読み書き・オープン・保存・セッション復元・競合検出・**複数ウィンドウ**を検証する
E2E テストです。

手動でしか確認できなかった領域を、再現可能なスクリプトに落とすことが目的です。
アプリを自動操作するため、**実行のたびにアプリを起動し直し、終了時に片付けます**。

## 前提

| 要件 | 備考 |
|---|---|
| macOS | アクセシビリティ API を使うため。他 OS では実行できません |
| Python 3.10+ | **標準ライブラリのみ**。追加インストール不要 |
| アクセシビリティ権限 | システム設定 > プライバシーとセキュリティ > アクセシビリティ に、実行元のターミナル等を追加 |
| ビルド済みの .app | 先に `pnpm build:mac` |

権限が無い場合は実行前に検出して、対処方法を表示して終了します。

## 使い方

```bash
pnpm build:mac                 # 先にビルド
pnpm test:e2e:mac              # 全 Tier を実行(所要 15〜20 分)
pnpm test:e2e:mac --tier 1     # Tier 1 だけ(引数はそのまま script に渡ります)
python3 test/macos/verify_e2e.py --only T2-02
python3 test/macos/verify_e2e.py --keep    # 作業ディレクトリを残す
python3 test/macos/verify_e2e.py --app "/path/to/Sainte Devote.app"
```

| オプション | 説明 |
|---|---|
| `--app PATH` | 検証対象の .app。既定は `src-tauri/target/release/bundle/macos/Sainte Devote.app` |
| `--tier TEXT` | グループ名で絞る(`1` / `2` / `3` / `4`)。Tier 4 は複数ウィンドウを開きます |
| `--only ID` | ケース ID で絞る(例 `T1-08`) |
| `--keep` | 作業ディレクトリを残す(失敗時は常に残ります) |
| `--keep-shots` | 成功時もスクリーンショットを残す |
| `--no-build-check` | ビルド存在チェックを飛ばす |

> ⚠️ **実行中はアプリのウィンドウに触らないこと。** 自動操作を奪われ、
> 全ケースが偽の失敗になります(実際に 1 回全滅しました)。マシンを占有するので、
> 他の作業と並行しないでください。
>
> 実行前に `pkill -x sainte-devote` で残骸プロセスを消すのが安全です
> (残っていると別プロファイルのウィンドウを触って偽の失敗になります)。

## 実行の仕組み

- **ビルド済みバイナリを直接起動**します(`pnpm tauri:dev` は不要)。
  実行ファイル名は **`sainte-devote`**(Cargo パッケージ名。`productName` の
  `Sainte Devote` とは違う)。AX 上のプロセス名も同じです。
  ハーネスは `.app/Contents/MacOS/` から実行ファイルを自動検出するので、
  `productName` と Cargo 名が違っても動きます。
- **プロファイルは `CFFIXED_USER_HOME` で隔離**します。`open -a` は
  LaunchServices 経由で環境変数を渡せないため、隔離したいときはバイナリを直接起動します。
  (`open -a` は T1-09「ウィンドウ 0 からの復帰」で**意図的に**使います。)
- **ウィンドウタイトルは `<アクティブタブ名> — Sainte Devote`** です。
  つまりタイトル = アクティブタブの観測点になります。
- 各ケースの要所でスクリーンショットを撮ります(全画面ではなく
  ウィンドウ矩形指定なので、他のウィンドウは混ざりません)。
- 内容の検証は **AX → ディスク → ZIP** の順に優先します。
  エディタのバッファは AX からは信用できず(仮想スクロール)、
  ディスク上の実ファイルか `File > Export All Tabs (.zip)` の展開結果で確かめます。

## 分離(実データを触りません)

- アプリは `CFFIXED_USER_HOME=<一時ディレクトリ>` で起動します。
  IndexedDB の未保存タブ・最近使ったファイル・設定はすべてそこに入り、
  **実プロファイル (`~/Library/Application Support/dev.izumiz.sainte-devote`) は変更されません。**
- 操作対象のファイルはすべて一時的な作業ディレクトリ内に作られます。
- Tier ごとに新しいプロファイルで起動するので、「Untitled N」の採番も毎回決定的です。
- 成功時は作業ディレクトリを削除、失敗時は調査用に残してパスを表示します。

> 注意: 一時ディレクトリは `Path.resolve()` で `/private/var/...` に正規化しています。
> macOS の `/var` は `/private/var` へのシンボリックリンクで、アプリは
> **パス中にシンボリックリンクがあると読み書きを拒否する**ため、`/var/...` のままだと
> 全ケースが失敗します。

## 構成

| ファイル | 役割 |
|---|---|
| `harness.py` | 汎用部品。AppleScript 実行、アクセシビリティツリー、ネイティブパネル操作、クリップボード入力、ファイル/ZIP による検証 |
| `scenarios.py` | テストケース定義(Tier 1〜3)とフィクスチャ |
| `verify_e2e.py` | エントリポイント。事前チェック、グループ実行、レポート |

アプリ固有の値はほぼ `harness.py` に集約しています。

## テスト一覧

### Tier 1 — コア(読み書き・開く・保存・セッション復元)

| ID | 内容 |
|---|---|
| T1-01 | 新規プロファイルで 1 ウィンドウ / タブ `Untitled 1` |
| T1-02 | ダイアログから開く → タブ名と内容 |
| T1-03 | 2 つ目のファイルを開くとタブが増える |
| T1-04 | 既に開いているファイルを再度開くと重複せずフォーカス |
| T1-05 | `Cmd+S` で編集がディスクに反映される |
| T1-06 | `Cmd+S` なしでもオートセーブが反映される |
| T1-07 | Save As でファイル生成 + タブ名がファイル名に再バインド |
| T1-12 | `Cmd+W` でタブが閉じ、タイトルが隣へ移る |
| T1-08 | 再起動で**未保存タブ**が内容ごと復元され、**ファイルタブは自動で開かれない** |
| T1-09 | ウィンドウ 0 から Dock 相当の再表示でワークスペースが復元される |
| T1-11 | 空ファイル / 大きいファイルが開ける |
| T1-10 | コマンドライン引数のファイルがタブになる |

### Tier 2 — 外部同期・競合

| ID | 内容 |
|---|---|
| T2-01 | 未編集タブは外部変更を黙って取り込む(バナー無し) |
| T2-02 | 同時書き込みで `changed on disk` バナーが出る |
| T2-03 | `Reload from disk` で外部版を取り込む |
| T2-04 | `Keep my version` でローカル版をディスクに書く |
| T2-05 | 外部削除で `was deleted on disk` 通知 |
| T2-06 | 編集なしで再作成されたファイルは黙って取り込む |
| T2-07 | (参考)オートセーブと watcher のレース。再現しなくても失敗扱いにしない |

### Tier 3 — セキュリティ境界

| ID | 内容 |
|---|---|
| T3-01 | シンボリックリンクのパスを渡しても開かない |
| T3-04 | 許可外拡張子(`.png`)のパスを渡しても開かない |
| T3-02 | Save As で非 Markdown ファイルを作れない(パネルのフィルタが `.md` に書き換える) |
| T3-03 | 最近使ったファイルから開いたタブは読み取り専用で、編集してもディスクに書かれない |

T3-01 / T3-04 は**ダイアログではなく argv** で渡します。ファイルピッカーは
そもそも symlink や `.png` を選べないため、ダイアログ経由では「ピッカーが拒否した」
ことしか分からず Rust 側の検証を素通りします。2 つ目のプロセスは single-instance
プラグイン経由で `session::resolve_argv_paths` → `validate_readable_path` に届くので、
実際のバリデータを検証できます。

### Tier 4 — マルチウィンドウ

| ID | 内容 | 期待結果 |
|---|---|---|
| T4-01 | `Cmd+Shift+N` で新規ウィンドウ | 新ウィンドウの先頭タブが**共有カウンタの次の番号**(`Untitled 2`)。両ウィンドウの ZIP 出力は**自分のタブだけ**を含む |
| T4-02 | 2 ウィンドウで同一ファイル | タブが重複せず、**持ち主のウィンドウが前面に来る**。要求側にタブは増えず、書き込み権限も失われない |
| T4-03 | 2 回目の起動でファイルを送る | 既存の**どちらか 1 つ**にだけタブが増え、3 枚目のウィンドウは作られない |
| T4-04 | アーカイブ(trash) | 未保存タブを閉じると内容ごと退避され、`Restore` で同じ内容が戻る。**空のタブは退避されない** |
| T4-05 | 設定の永続化 | Editor Font Size の変更が再起動後も保持される |
| T4-06 | メニュー/ショートカットの宛先 | `Cmd+N` / `Cmd+W` は**フォーカス中のウィンドウだけ**に効く |
| T4-07 | ウィンドウのライフサイクル | 片方を閉じてもプロセスは生存し、残りは無傷。最後を閉じるとウィンドウ 0 で生存し、Dock 相当の再表示で**残っていたワークスペース**が戻る |

複数ウィンドウを実際に立ち上げるフローはこの 7 件でカバーしています。
`window_registry` のロジック(所有権・ルーティング・タブ転送の単一スロット)は
Rust のユニットテストも直接カバーしています。

実装上の前提(コード上の根拠):

| 項目 | 根拠 |
|---|---|
| 新規ウィンドウ | `menu.rs` の `new-window` → `session::spawn_editor_window(anchor = menu_target())` |
| メニューの宛先 | `window_registry.rs` の `menu_target()` = フォーカス MRU の先頭 |
| 所有権ルーティング | `window_registry.rs` の `route_open()` → 既存オーナーへ `transferred`。`owns_path()` が受け渡しの前提 |
| ワークスペース分離 / 共有カウンタ / 共有ゴミ箱 | `workspace-store.js`(`workspaces` ストア、`meta.untitledCounter`、ワークスペース非依存の `trash` ストア) |
| ウィンドウを閉じる | `lib.rs` の `CloseRequested`(`has_other_alive_windows` のときだけ renderer に確認) |

#### ウィンドウ間のタブ移動(D&D)は自動化できません

WKWebView はページのドラッグをネイティブドラッグセッションに昇格させるため、
ページ側には `dragstart` / `dragend` しか届かず、ドロップ位置は Rust 側の
`DragDropEvent` に来ます。これを自動化するには合成マウスイベント(CGEvent)で
実ドラッグを作るしかありませんが、**この環境では合成イベント自体がアプリに
配送されない**ことを実測で確認しました:

- `AXIsProcessTrusted()` は True、カーソルは指定座標へ移動する(送信は成功)
- 送信先は正しい: AX の `position`/`size` と `CGWindowListCopyWindowInfo` の
  ウィンドウ矩形が完全に一致(例 `120,620,1000,700`)
- それでもタブバーの `New tab` の合成クリックでタブが増えず、
  **タイトルバー(ネイティブ部分)の合成クリックでもウィンドウが前面に来ない**
  (`AXMain` が false のまま)

よって D&D の UI ケースは追加していません。受け渡しの規則は Rust ユニットテスト
(`tab_drag_merges_into_the_dropping_window_only_once` /
`a_self_drop_is_reported_so_the_source_can_detach` /
`destroying_the_source_window_clears_its_drag` /
`a_recent_merge_blocks_a_racing_detached_duplicate` /
`clear_tab_drag_only_drops_the_owning_window_drag`)が担保します。

手動で確認するときは、次の 3 つを見てください(いずれも**実マウス**が必要です)。

1. 同じウィンドウ内のタブバーで並べ替え → タブ順が入れ替わる
2. タブを**ウィンドウの外**(デスクトップや他アプリ)へドロップ → 新しいウィンドウに切り離される
3. タブを**もう 1 つのウィンドウのタブバー**へドロップ → そのウィンドウへ合流し、元からは消える

## AX(アクセシビリティ)ツリーの構造

WebView の中身が露出しています。実際に使える具体パス:

| 対象 | AX パス |
|---|---|
| タブバーのコンテナ | `UI element 1 of scroll area 1 of group 1 of group 1 of window N` |
| タブ(1 つずつボタン) | 上記コンテナの `buttons`。**name が `"<タブ名> Close tab"`** |
| 新規タブ `+` | 同じ buttons の中で name が `New tab` |
| アーカイブ | 同じ buttons の中で name が `Archived Tabs` |
| プレビュー/編集トグル | button 1(description が `Toggle Preview/Editor`) |
| 設定ギア | button 2(description が `Settings (Ctrl+,)`) |
| **Monaco のエディタ** | `text area 1 of group 1 of <タブバーのコンテナ>` |

### 操作の実装メモ(触る前に読む)

- **文字入力に `keystroke "text"` を使わない。** 日本語 IME が有効な環境では
  合成文字が変換されて壊れます。クリップボードに入れて `Cmd+V` で貼り付けます。
  ショートカット(`Cmd+S` 等)は IME の影響を受けないので `keystroke` で構いません。
- **バッファを決定的に置換する定型**: AX で Monaco を `focused` にする →
  `Cmd+A` → クリップボードから `Cmd+V`。カーソル位置に依存しません。
  座標クリック(`click at`)は error -25208 で失敗します。
- **ネイティブの Open/Save パネルはシートとして出ます。** 対象を選べないと
  パネルが開いたまま残り、以降のキー操作を全部吸って**大量の偽の失敗**を生みます。
  モーダルの判定は `count of sheets of window N > 0`(`name of every window` は
  増えないのでウィンドウ数では判定できません)。各ケースの開始前に
  `ensure_no_panel()` で必ず確認し、残っていれば Escape で復帰させます。
- パネルの操作は *フォルダへ移動*(`Cmd+Shift+G`)→ パス貼付 → Return → Return。
  置換確認を避けたいときは**事前に対象ファイルを消しておく**。
- **通知の読み取りに `entire contents` を使わない。**
  `every X of entire contents of Y` は AppleScript error -1700 になり、
  `try` で囲んでいると**空リストが返るだけ**で気付けません
  (初版はこれで通知を一切読めていないことに気付きませんでした)。
  正しくは「タブコンテナ直下の `groups` を1段だけ降りて `static texts` を集める」。
  この 1 段の降下で、エディタ本文より浅い位置にある通知だけを狙い撃てます。
- **素の通知は3秒で消えます**(`showNotification`)。0.4秒間隔でポーリングすること。
  競合バナー(`showActionNotification`)は自動では消えません。
- **競合バナーのボタンは `buttons of <コンテナ>` に入ります**(件数が 6 → 8 に増える)。
  `entire contents` で探す必要はありません。
- **読み取り専用タブの名前は `alpha.md🔒`** です(`main.css` の CSS `::after`)。
  タブ名は**部分一致で探してください**(`find_tab` / `focus_tab_matching`)。
- ⚠️ **AX のタブ名とウィンドウタイトルは一致しません。** 🔒 は CSS の `::after`
  なので AX のタブ名にだけ乗り、ウィンドウタイトルは `tabData[tabId].title` 由来で
  `alpha.md` のままです。比較時は 🔒 を落とすこと(`App.focus_tab` はそうしています)。
- タブ名の ` Close tab`(9 文字)を削ると末尾に**半角スペースが残る**ので `strip()` すること。
  `New tab` / `Archived Tabs` が混ざらないよう、`" Close tab"` で終わるものだけに絞る。
- AppleScript のリスト→文字列化は区切りが曖昧なので、**`linefeed` で自前連結**して
  Python 側で split する。
- アプリ起動直後は AX ツリーが**未整備**です。タブボタンが出るまで最大 40 秒待ちます。
- **エディタの内容はアクセシビリティツリーからは読めません(信用しない)**。
  検証は「ディスク上のファイル」か `File > Export All Tabs (.zip)` の展開結果で行います。
  ZIP のエントリ名は `<タブ名>.md` なので、タブ `alpha.md` は `alpha.md.md` になり、
  空白は `_` に置換されます(同名衝突時は `_1.md`)。
- **ウィンドウの並びは z オーダーです。** `window 1` が最前面で、新規ウィンドウは
  必ず `window 1` として現れます。`AXRaise` で並びが変わるので **index を持ち越さない**
  こと(`window_snapshot()` で引き直すか、`raise_window_with_tab()` でタブ名から前面化)。
- **フォーカスとメニューの宛先は一致します。** `AXRaise` + `frontmost` の後は、
  キーストロークもメニュー項目も raise したウィンドウに届きます
  (`menu_target()` がフォーカス MRU を見るため)。実測: raise 後の
  `File > New Tab` は raise した側にタブが増えます。
- **新規ウィンドウは AX が未整備**です。タブバーが出るまで待つこと
  (`wait_for_new_window()`)。
- **設定モーダルの数値入力は入れ子が深く、`text fields of window 1` では取れません。**
  `entire contents` を**いったん変数に代入してから**走査し、`class is text field` で
  絞ります。`repeat with e in (entire contents of window 1)` と**インラインで書くと
  何も見つかりません**(実測)。
  - `set value of e to "29"` は**黙って無視されます**。`set focused of e to true` →
    `Cmd+A` → クリップボード貼付で入れてください(`settings_set_font_size()`)。
- **アーカイブのポップオーバー**は同じ `buttons` に `Clear All` / `Close` /
  `Restore` / `×` を追加します。開いている判定は `Clear All` の有無で行うと確実です
  (設定モーダルにも `Close` があるため)。

### メニューとショートカット

| 操作 | メニュー | ショートカット |
|---|---|---|
| 新規タブ | File > New Tab | `Cmd+N` |
| 新規ウィンドウ | File > New Window | `Cmd+Shift+N` |
| 開く | File > Open File... | `Cmd+O` |
| 保存 | File > Save | `Cmd+S` |
| 名前を付けて保存 | File > Save As... | `Cmd+Shift+S` |
| タブを閉じる | File > Close Tab | `Cmd+W` |
| ウィンドウを閉じる | File > Close Window | `Cmd+Shift+W` |
| 全タブを書き出す | File > Export All Tabs (.zip) | `Cmd+Shift+E` |
| コマンドパレット | — | `Cmd+P` |
| 設定 | — | `Cmd+,` |

### 競合バナーが出る条件(`renderer.js` の `handleExternalFileContent()`)

```js
const hasPendingLocalEdit = Boolean(autosaveTimers[tabId]) || hasLocalEditsWhileMissing;
if (!hasPendingLocalEdit && !conflictTabs.has(tabId)) {
  applyExternalContent(tabId, content);   // 黙って取り込む
  return;
}
// ここで "changed on disk" バナー
```

競合バナーが出るのは次のどちらかです。

- **(A) オートセーブ保留中** — 編集後 **300ms** で発火しますが、watcher のデバウンスは
  **200ms**(`file_sync.rs: CHANGE_CHECK_DEBOUNCE`)なので、外部書き込みのタイミングに
  依存します。アプリ自身のオートセーブが外部書き込みを上書きしてしまうと、
  watcher は既知ハッシュを読んで**フィルタ**するため、決定的な再現は不可能です
  (参考ケース T2-07)。
- **(B) ファイル消失中に編集した** — `fileMissing` の間はオートセーブが止まるので、
  **競合するものがない = 決定的に再現できます**。手順:
  1. ファイルを開く(書き込み可)
  2. 外部で**削除** → `"X" was deleted on disk` 通知、`fileMissing = true`
  3. エディタで編集 → `hasLocalEditsWhileMissing = true`
  4. 外部で**再作成** → `file-changed-externally` → **バナー確定**

Tier 2 はこの **(B) を主経路**(T2-02)にしています。

### 実測した通知文言

- `File saved: <ファイル名>`
- `"<ファイル名>" changed on disk. Keep your edits or reload?`
- `"<ファイル名>" was deleted on disk — use Save As to re-save`
- `Opened read-only — use Save As to enable autosave`

## 既知の仕様として確認したこと

- **ファイルタブは再起動で復元されません。** `scratchTabsForStore()` が
  `filePath` を持つタブを除外しているためで、再起動時にユーザー操作なしで
  書き込み権限を与えないセキュリティ方針と整合します。T1-08 はこの挙動を明示的に検証します。
  (「再起動で開いていたファイルが消える」と感じるなら仕様相談の余地があります。)
- **Save As で非 Markdown ファイルは作れません。** Save ダイアログが
  `add_filter(["md","markdown","txt"])` を持つため、パネルが拡張子を `.md` に
  書き換えてからアプリに渡します(`blocked.png` と指定すると `blocked.md` ができます)。
  `validate::with_default_extension`(拡張子を付与する側の防御)は
  UI からは到達しない二重防御です。
- **最近使ったファイルから開いたタブは書き込み不可です。** `open_recent` は
  `grant_write = false` で開くため、編集しても autosave は走らず、`Cmd+S` は
  Save As パネルを開きます(T3-03 で実証)。
- **競合バナーは自動では消えません**(`showActionNotification`)。ボタンを押すか、
  同じタブへの新しい外部変更で差し替わるまで残ります。
- **ウィンドウ 0 の状態でもプロセスは生存し続けます**(macOS 仕様、`prevent_exit`)。
  `RunEvent::Reopen`(Dock クリック / `open -a`)で復帰します。
- **ワークスペースはウィンドウごと、番号とゴミ箱は共有です。**
  - `Untitled N` は `meta` ストアの共有カウンタ由来なので、別ウィンドウで作った
    タブと番号が重複しません(T4-01 / T4-06)。
  - アーカイブ(`trash` ストア)はワークスペースに紐付かないため、**別のウィンドウで
    閉じたタブが、どのウィンドウの `Archived Tabs` からも見えます**。`Restore` すると
    **クリックしたウィンドウに**タブが移ります(`restoreTrashItem` → `addTab`)。
  - 保存前の状態は window ごとの ZIP 出力でも確認できます(T4-01)。
- **他のウィンドウが生きている状態でウィンドウを閉じると、そのワークスペースは破棄されます。**
  未保存タブは内容のあるものだけアーカイブへ退避され(`handleWindowCloseRequested`)、
  ワークスペース自体は削除されます。**最後の 1 枚**を閉じたときだけは renderer を
  介さずそのまま閉じるため、ワークスペースが残り、次の再表示で復元されます(T4-07)。

## 実行結果

2026-10-19 / `main` = `6d2db9a` / v2.2.1(aarch64)/ macOS 26 で実行。

### E2E

| Tier | 結果 |
|---|---|
| Tier 1 — コア(読み書き・開く・保存・セッション復元) | **12 / 12 PASS** |
| Tier 2 — 外部同期・競合検出 | **7 / 7 PASS**(T2-07 のレースも再現) |
| Tier 3 — セキュリティ境界 | **4 / 4 PASS** |
| Tier 4 — マルチウィンドウ | **7 / 7 PASS** |
| **合計** | **30 / 30 PASS** |

全 Tier の通し実行で 20 分前後かかります(その間マシンを占有します)。

**アプリ側のバグは 0 件**でした。途中で落ちた 5 件はすべてテスト側の原因
(期待値の誤り 2 件、ハーネスの通知読み取りバグ 1 件、ランナーのプロファイル共有バグ 1 件、
AX タブ名とウィンドウタイトルの不一致 1 件)で、修正して再実行しています。

Tier 4 を追加したときもテスト側で 2 件落ちました(`App.ARCHIVE_BUTTON` の参照ミス)。
修正後の再実行で 7/7、その後の全 Tier 通しで 30/30 です。

### 静的検証(同じリビジョン)

| 項目 | 結果 |
|---|---|
| `pnpm lint:tauri` | ✅ 警告 0 |
| `pnpm test:frontend` | ✅ 12/12 |
| `cargo fmt -- --check` | ✅ exit 0 |
| `cargo check` | ✅ exit 0 |
| `cargo clippy --all-targets --all-features -- -D warnings` | ✅ exit 0 |
| `cargo test` | ✅ 50 passed / 0 failed |
