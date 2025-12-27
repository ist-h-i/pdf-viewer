# Task 01: 選択ハイライトの矩形化を改善（過大ハイライト止血）

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.1）
- `docs/design/highlight-design.md`

関連コード:
- `src/app/pages/viewer-shell/viewer-shell.component.ts`（`addHighlightFromSelection()` / `rectsFromRange()` / `rectsFromOffsetsInLayout()`）

## 目的
選択範囲ハイライトが「太い/大きすぎる」問題を、現行データモデル（rects%）のまま改善する。

## 背景（原因仮説）
- `Range.getClientRects()` は、PDF.js textLayer の `span` 実装やブラウザ差分により、部分選択でも span 全体の rect を返しうる。
- rect の後処理（0..100クランプ、重複除去、近接マージ）が無く、視覚的に過大になりやすい。

## 方針（Phase 1）
### 1) offset ベースの矩形化へ寄せる（可能な範囲で）
- 既に `PageTextLayout`（`textLayouts`）と `rectsFromOffsetsInLayout()` があるため、**選択ハイライトでも同じロジックへ寄せる**。
- `addHighlightFromSelection()` の「単一ページ選択」では `selectionOffsets` を持てるため、`rectsFromOffsetsInLayout()` を優先する。

### 2) rect 整形（sanitize）を導入する
`HighlightRect[]` を描画に回す直前（生成直後）に必ず整形する。
- 0..100 へクランプ（はみ出し rect を抑制）
- 近接/重複 rect の統合（同一行・同一色の連続をマージ）
- 0幅/0高の除去（現状もあるが、整形後も保証）

## 実装タスク（チェックリスト）
- [x] `addHighlightFromSelection()` の単一ページ選択で、`offsets && layout` がある場合は `rectsFromOffsetsInLayout(layout, start, end)` を優先する
- [x] `Range.getClientRects()` フォールバックは残す（`layout` 未取得時・複数ページ選択時）
- [x] rect 整形ユーティリティ（例: `sanitizeHighlightRects(rects)`）を追加する
  - [x] clamp（`left/top/width/height` を 0..100）
  - [x] 重複除去（同値 or 近似同値）
  - [x] 近接マージ（同一行の連続矩形を統合）
- [x] `collectSelectionRectsByPage()` にも同じ整形を適用する（複数ページ選択時の rects を過大にしない）

## 受け入れ条件
- 典型的なPDFで、単語/部分選択のハイライトが「行全体」になりにくい
- 行内で不自然に太い矩形が連続して見えるケースが減る
- 既存の検索ハイライト（`rectsFromOffsetsInLayout`）に悪影響がない

## 検証手順（手動）
- 文字が詰まった段落で「単語の一部」を選択→ハイライト追加→過大にならない
- 連続する複数行を選択→ハイライト追加→矩形が不自然に太くならない
- 既存の検索ハイライトが従来どおり表示される

