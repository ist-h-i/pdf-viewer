# フォーカス（選択）とスクロール（ジャンプ）仕様

対象: `pdf-viewer`（FR-05 検索 / FR-06 ハイライト / FR-07 コメント）  
主な実装: `src/app/pages/viewer-shell/viewer-shell.component.*`

関連: [highlight-design.md](highlight-design.md), [comment-design.md](comment-design.md)

## 1. 目的
右サイドパネルの一覧（検索結果 / ハイライト / コメント）やページ上のオーバーレイを選択したときに、該当位置へスムーズにスクロールし、選択状態を UI 全体で同期させます。

本仕様でいう「フォーカス」は **選択状態の更新（Selected）＋該当位置へのスクロール（Scroll）** を指します。

## 2. 対象（フォーカス可能な要素）
### 2.1 検索結果（SearchHit）
- 右サイド「全文検索」のヒット一覧
- データ: `SearchHit`（`src/app/core/models.ts`）
- 実装: `focusSearchHit(hit)`

### 2.2 ハイライト（Marker）
- 右サイド「ハイライト」一覧
- ページ上の矩形ハイライト（`.highlight`）およびラベル（`.highlight-label`）
- データ: `Marker`（`src/app/core/models.ts`）
- 実装: `focusMarker(marker)`

### 2.3 コメント（CommentCard）
- 右サイド「コメント一覧」
- ページ上のコメントアンカー（`.comment-anchor`）および吹き出し（`.comment-bubble`）
- データ: `CommentCard`（`src/app/core/models.ts`）
- 実装: `focusComment(comment)`

## 3. UI/UX 仕様
### 3.1 共通
- フォーカス対象を選択すると、可能な範囲で **該当位置が画面中央付近に来るように** スムーズスクロールする。
- 選択状態は「ページ上のオーバーレイ」と「右サイドの一覧」で同期する。
- 選択状態は排他とする（Marker と Comment を同時選択しない）。
  - Marker 選択時: `selectedMarkerId` を更新し、`selectedCommentId` を `null` にする
  - Comment 選択時: `selectedCommentId` を更新し、`selectedMarkerId` を `null` にする

### 3.2 検索結果 → スクロール
ユーザー操作:
- 右サイド「全文検索」のヒット行（`p{page}: {context}`）をクリック/Enter

期待動作:
1. 該当ページに **検索ハイライト（`source='search'` の Marker）** が存在する場合:
   - その Marker を選択状態にし、Marker 位置へスクロールする
   - リンクのデフォルト遷移（`#page-*`）は抑止する（JS でセンタリングするため）
2. Marker が見つからない場合:
   - 該当ページへスクロールする（可能ならセンタリング、不可なら通常のアンカー遷移にフォールバック）

補足（現行データ構造の制約）:
- `SearchHit` はページ内オフセット（match 位置）を保持しないため、同一ページ内の複数ヒットを個別に狙ってスクロールすることはしない。
- 検索ハイライトはページ単位の `Marker`（複数一致 rect を内包）として描画されるため、スクロール先は「ページ内の一致群の外接矩形の中心」になる。

### 3.3 ハイライト → スクロール
ユーザー操作:
- 右サイド「ハイライト」一覧の項目をクリック/Enter
- ページ上のハイライト矩形/ラベルをクリック

期待動作:
- 対象 Marker を選択状態にし、Marker 位置へスクロールする。
- `origin='pdf'`（インポート注釈）などの読み取り専用 Marker も、選択とスクロールは可能とする（削除や移動は別仕様）。

### 3.4 コメント → スクロール
ユーザー操作:
- 右サイド「コメント一覧」の項目をクリック/Enter
- ページ上のコメントアンカー/吹き出しをクリック

期待動作:
- 対象 Comment を選択状態にし、コメント吹き出し位置へスクロールする。
- 読み取り専用 Comment も、選択とスクロールは可能とする（編集や削除は別仕様）。

### 3.5 選択を発火しないクリック（一覧内の操作ボタン等）
一覧の項目内にボタン/入力がある場合、意図しない「選択→スクロール」を発火させない。

例:
- ハイライト項目の「削除」ボタン
- コメント項目の「削除」ボタン
- コメント吹き出し内の title 編集 input / 返信 textarea / 各種ボタン

## 4. スクロール仕様（技術）
### 4.1 基本方針
フォーカス時のスクロールは次の優先順位で行う。

1) **対象オブジェクトの DOMRect を取得できる場合**: `scrollViewerToRect(rect)` でセンタリングスクロール  
2) **対象ページ要素を取得できる場合**: `scrollToPage(page)` でページへスクロール  
3) 上記が難しい場合: ブラウザの標準挙動（アンカー遷移等）にフォールバック

### 4.2 Marker のスクロール先
`scrollMarkerIntoView(marker)` のスクロール先は、次のいずれかで決める。

- 優先: `.highlight[data-marker-id="..."]`（および `.highlight-label`）の `getBoundingClientRect()` を収集し、外接矩形へマージ
- フォールバック: `Marker.rects`（%）とページ DOMRect から外接矩形を復元

### 4.3 Comment のスクロール先
`scrollCommentIntoView(comment)` のスクロール先は、次のいずれかで決める。

- 優先: `.comment-bubble[data-comment-id="..."]` の `getBoundingClientRect()`
- フォールバック: `bubbleX/bubbleY`（正規化座標）と `bubbleWidth/bubbleHeight`（px）から吹き出し矩形を推定

### 4.4 スクロールコンテナ
センタリングスクロールは「ページ全体」ではなく、ビューアのスクロールコンテナ（`.viewer-grid`）に対して行う。

- 目的: 右サイドパネルやトップバーがあるレイアウトでも、フォーカス対象を安定して画面中央へ寄せる
- 実装: `scrollViewerToRect(rect)` が `scrollTo({ behavior: 'smooth' })` を用いてスクロール量を算出する

## 5. 受け入れ条件（チェックリスト）
- 検索結果をクリックすると、該当ページへジャンプし、検索ハイライトが選択状態になる。
- ハイライト一覧の項目をクリック/Enterすると、該当ハイライトへジャンプし、ページ上のハイライトも選択状態になる。
- コメント一覧の項目をクリック/Enterすると、該当コメントへジャンプし、ページ上のコメントも選択状態になる。
- 選択は Marker/Comment で排他になり、片方を選択するともう片方の選択は解除される。
- 一覧内の削除ボタンや入力 UI を操作しても、意図しないジャンプが発生しない。

