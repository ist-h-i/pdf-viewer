# ページ番号指定ジャンプ 仕様・詳細設計

対象: `pdf-viewer` / `docs/issues.md` 新規開発機能 **4. ページ番号指定ジャンプ**  
関連: 既存のスクロール仕様（`docs/focus-scroll-design.md`）、複数PDF切替（`docs/multi-pdf-library-design.md`）

---

## 1. ゴール/非ゴール

### ゴール
- ヘッダーにページ入力（例: `1 / 120`）を表示し、任意ページへジャンプできる
- `Enter` または「移動」でジャンプできる
- スクロールに追従して「現在ページ」が更新される
- スライダーでページングできる
- PDF切替（複数PDF）時にページ数/現在ページが切り替わる

### 非ゴール（MVP）
- 章/見出し（アウトライン）によるナビゲーション
- しおり/履歴スタック

---

## 2. UI仕様

### 2.1 ヘッダー表示（提案）
- 既存のツールバー（ズーム/オブジェクト/ダウンロード）付近に配置
- 表示要素:
  - ページ入力欄（数値入力 or テキスト入力）
  - `/ {pageCount}` の静的表示
  - 「移動」ボタン（任意。Enterだけでもよいが要件に合わせる）
  - スライダー（`type=range`）

### 2.2 ステート
- PDF未読み込み時:
  - 入力/スライダーは disabled
  - 表示は `- / -` または `0 / 0`
- 読み込み済み:
  - `currentPage` を常に 1..pageCount にクランプして表示

---

## 3. 入力仕様

### 3.1 受理する入力
- 数値（全角は半角に正規化できると望ましい）
- 入力は「表示用文字列」と「確定したページ番号」を分けて扱う（不正入力でもUIが壊れないようにする）

全角→半角の例:
- `１２３` → `123`

### 3.2 範囲外/不正
- `0` 以下 → `1`
- 最大ページ超え → `pageCount`
- 空/非数:
  - 入力を元に戻す（=直前の `currentPage` を表示）

---

## 4. 実装設計（ViewerShellComponent）

### 4.1 追加する状態（例）
- `currentPage = signal(1)`（確定ページ）
- `pageInput = signal('1')`（入力欄の文字列）
- `isJumping = signal(false)`（必要なら。scrollの追従更新との競合回避に使う）

`pageCount` は既存 `pdf.pageCount()` を参照する。

### 4.2 ジャンプ処理
既存の `scrollToPage(pageNumber)` を使用する（`docs/focus-scroll-design.md` と整合）。

ジャンプトリガー:
- 入力欄 `keydown.enter`
- 「移動」ボタン `click`
- スライダー `change`（ドラッグ中は `input` で表示だけ更新し、確定でスクロールする方針が軽い）

### 4.3 スクロール追従（現在ページの更新）
更新頻度を抑えるため、既存のスクロールRAF（`scheduleScrollSync('base')`）に寄せて rAF 内で更新する。

判定方法（提案: 中央基準）:
1. スクロールコンテナ（`pdfScrollContainer`）の可視領域中央 `centerY = scrollTop + clientHeight / 2` を求める
2. `pageOverlays()`（pageNumber, top, height の配列）から、`centerY` に最も近いページを選ぶ
   - `overlays` は `pageNumber` 順なので、`top` を使って二分探索（将来最適化）可能
3. `currentPage` を更新し、`pageInput` も `String(currentPage)` に同期する

> `pageOverlays` は `syncDomRefs()` で更新されるため、未構築のタイミングでは更新しない（空配列なら何もしない）。

### 4.4 PDF切替時の初期化
- 新しいPDFを選択した直後に:
  - `currentPage=1`
  - `pageInput='1'`
- ページ数表示は `pdf.pageCount()` の更新に追従する

---

## 5. スライダー仕様

HTML:
- `type="range"`
- `min=1`
- `max=pdf.pageCount()`
- `value=currentPage`

イベント:
- `input`: 表示だけ更新（`pageInput` を反映）
- `change`: そのページにジャンプ（`scrollToPage`）

---

## 6. 受け入れ条件（`docs/issues.md`対応）
- 任意ページに数秒以内でジャンプできる（極端に重いPDFは除く）
- 不正入力時に破綻せず、ユーザに分かるフィードバックがある（=入力が元に戻る/丸められる）
- スクロール/表示に追従して現在ページが更新される
- PDF切替時にページ入力欄が正しく切り替わる（ページ数/現在ページ）

