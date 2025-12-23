# ハイライト機能 仕様・設計（外部開発者向け）

対象: `pdf-viewer`（FR-06 選択テキストのハイライト / FR-05 検索結果ハイライト）  
主な実装: `src/app/pages/viewer-shell/viewer-shell.component.*`, `src/app/features/annotations/annotation-facade.service.ts`, `src/app/core/models.ts`

## 1. 概要（ハイライトの種類）
本アプリの「ハイライト」は、目的別に 2 系統の実装を持ちます。

1) **選択範囲ハイライト（ユーザー操作）**  
PDF.js のテキストレイヤ（`.textLayer`）DOM を部分的に `span.text-highlight` でラップして背景色を付与します。  
→ テキストに追従し、ズーム等でテキストレイヤが再描画されても再適用されるよう、**オフセット（start/end）** をインメモリ保持します。

2) **検索結果ハイライト（自動）**  
ページ上に `div.highlight`（absolute）を重畳表示します（rect の集合）。  
→ テキストレイアウトを DOM からキャプチャし、検索クエリに一致する矩形群を算出します。

補足:
- 比較機能の差分表示も `div.diff-highlight`（absolute）で同系統の矩形描画です（FR-09 関連）。

## 2. ユーザー仕様（UI/UX）

### 2.1 選択範囲ハイライト
- ページ上のテキストをドラッグ選択 → 右クリック → コンテキストメニュー「選択範囲をハイライト」
- ハイライト色はスウォッチで選択（RGBA、半透明）
- クリック時に Selection が消えるブラウザ挙動を考慮し、右クリック時点の Selection オフセットを保持して適用する

### 2.2 検索結果ハイライト
- サイドパネル「全文検索」で検索実行すると、ヒット箇所がページ上に自動ハイライトされる
- 検索結果リストはページへのアンカーリンクを提供（矩形算出は Viewer 側で独立に行う）

## 3. データモデル
型定義: `src/app/core/models.ts`

### 3.1 HighlightRect（矩形）
`HighlightRect` はページ上の矩形を **パーセンテージ（0..100）** で表現します。

- `left/top/width/height`: ページ DOMRect を基準に正規化した割合

### 3.2 Marker（矩形の集合 = ハイライトの描画単位）
`Marker` はハイライト矩形群とメタ情報のまとまりです。

- `page`: ページ番号（1 始まり）
- `rects`: `HighlightRect[]`
- `color`: 塗り色（CSS color）
- `label`: ラベル（任意）
- `source`: `'search' | 'selection'`
- `text?`: 元テキスト（任意、主に検索クエリ等）

注: 現状 UI は **検索結果ハイライト** を `Marker(source='search')` として描画します。  
`Marker(source='selection')` はドラッグ移動のコードパスを持ちますが、UI からは生成していません（拡張ポイント）。

### 3.3 PageTextLayout（テキスト→矩形マッピング）
`PageTextLayout` はページのテキストレイヤ DOM から抽出した「連結テキスト」と、その部分矩形への対応表です。

- `text`: `.textLayer` 内の全 TextNode を連結した文字列（区切り文字なし）
- `spans`: `TextSpanRects[]`（各 TextNode の start/end オフセットと `DOMRect[]`）

このレイアウトにより「(start,end) のオフセット範囲 → 矩形群」を高速に求めます。

## 4. アーキテクチャ（責務分割）

### 4.1 状態: AnnotationFacadeService（Marker の保管）
実装: `src/app/features/annotations/annotation-facade.service.ts`

- `searchHighlights`: 検索ハイライト用 `Marker[]`
- `selectionHighlights`: ユーザー作成マーカー用 `Marker[]`（現状 UI 未使用）
- `allMarkers`: 上記の合算
- `markersByPage(page)`: ページ別にフィルタ

検索は `setSearchHighlights(markers)` で一括置換します。

### 4.2 表示・計算: ViewerShellComponent
実装: `src/app/pages/viewer-shell/viewer-shell.component.ts` / `.html` / `.scss`

#### 4.2.1 テキストレイヤ参照の解決
`ng2-pdf-viewer` の `(text-layer-rendered)` から `.textLayer` 要素を取得し、以下を保持します。

- `textLayerElementMap: Map<pageNumber, HTMLElement>`
- `textLayouts: Map<pageNumber, PageTextLayout>`

ライブラリ側のイベント構造差分を吸収するため、`resolveTextLayerElement()` は複数の候補（`event.source.*` / `event.target` / `pageElement.querySelector('.textLayer')`）を順に探索します。

#### 4.2.2 選択範囲ハイライト（DOM ラップ＋オフセット保持）
選択範囲の永続化は「ページ内の連結テキスト上のオフセット」で行います。

- 右クリック時:
  - `getValidSelection(page)` で選択が当該ページの `.textLayer` 内にあることを検証
  - `getSelectionOffsets(page, selection)` で `{start,end}` を算出し、コンテキストメニュー state に保持
- 適用時:
  - `textHighlights[page]` に `{start,end,color}` を追加（インメモリ）
  - `createRangeFromOffsets(layer, start, end)` で DOM Range を再構築
  - `applyHighlightToRange(layer, range, color)` で TextNode を split しつつ `span.text-highlight` でラップ

再描画対応:
- `onTextLayerRendered(page)` で `applyStoredTextHighlights(page, layer)` を呼び、
  - 既存の `span.text-highlight` を unwrap（`clearTextHighlights()`）
  - `textHighlights[page]` を順に再適用

#### 4.2.3 検索結果ハイライト（矩形重畳）
検索時、ページごとに「クエリ一致位置の矩形群」を算出し `Marker(source='search')` として描画します。

- 矩形算出: `collectRectsForQuery(page, query)`
  1) `PageTextLayout` があれば `layout.text` を `indexOf` し、`rectsFromOffsets()` で矩形へ変換（高速）
  2) なければ `.textLayer` を TreeWalker で走査して一致範囲ごとに Range を作り、`range.getClientRects()` をページ座標へ正規化（フォールバック）
- 描画: `.page` 内に `div.highlight` を rect 数だけ配置（`left/top/width/height` を `%` 指定）

## 5. スタイル上の注意（視認性）
`ng2-pdf-viewer` はデフォルトで `.textLayer { opacity: .2 }` を持つため、半透明ハイライトが「反映されていない」ように見えることがあります。  
本アプリは `src/app/pages/viewer-shell/viewer-shell.component.scss` で `opacity: 1 !important` に上書きし、視認性を担保しています。

関連メモ: [bug-report-selection-highlight-disabled.md](bug-report-selection-highlight-disabled.md)

## 6. フィーチャーフラグと表示制御
- `flags.markers=false` の場合:
  - コンテキストメニューのハイライト操作は無効
  - ページ上の `Marker` 描画は行われない
- `showObjects()` はオーバーレイ（`div.highlight` など）に対して有効で、`.textLayer` 内の `span.text-highlight` は別系統（現状は非連動）です。

## 7. 既知の制約と拡張ポイント

### 7.1 DOM ラップ方式の制約
- `.textLayer` の DOM 構造に依存するため、PDF.js / `ng2-pdf-viewer` のアップデートで破綻しうる
- ハイライトの追加は TextNode の分割を伴うため、件数が増えると DOM が肥大化する（必要なら上限/圧縮/別方式を検討）

### 7.2 Marker（矩形）方式の拡張
`AnnotationFacadeService.addMarker(page, rects, ..., source='selection')` を使うと、任意の矩形ハイライトを追加できます。  
`ViewerShellComponent` には `source='selection'` をドラッグ移動する処理が実装済みのため、UI を足すだけで「ユーザーマーカーを動かす」機能に拡張可能です。
