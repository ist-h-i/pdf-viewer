# Task 04: 座標変換を PageViewport 変換に寄せる（CropBox/Rotate 対応）

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.3 / 3.5 / Phase 2）
- `docs/investigations/pdf-annotation-investigation.md`

関連コード:
- `src/app/features/pdf/pdf-facade.service.ts`
  - Import: `readPdfAnnotations()` / `buildHighlightRectsFromAnnotation()` / `buildImportedComment()`
  - Export: `buildAnnotatedPdfBytes()` / `buildHighlightGeometry()` / `buildCommentRect()`

## 目的
PDF注釈の座標系を「単純 0..W/H 変換」から脱却し、CropBox/Rotate 等があるPDFでも Acrobat 互換の位置で入出力できるようにする。

## 背景（原因仮説）
- Export/Import が `page.getSize()` や `viewport.width/height` を「原点0・回転なし」とみなしており、CropBox オフセットや回転ページでズレる可能性が高い。

## 方針（Phase 2）
PDF.js の `PageViewport` を座標変換の基準にする。

- Import:
  - PDF座標（`Rect` / `QuadPoints`）を `viewport.convertToViewportPoint(x, y)` で viewport 座標へ変換
  - viewport 座標を `%（0..100）` に正規化して `HighlightRect` / `CommentCard.anchorX/Y` に落とす

- Export:
  - `%` → viewport 座標（`x = left% * viewport.width`, `y = top% * viewport.height`）へ変換
  - `viewport.convertToPdfPoint(x, y)` でPDF座標へ変換して `Rect/QuadPoints` を生成

## 実装タスク（チェックリスト）
- [x] Import:
  - [x] `QuadPoints` の各点（pdfX,pdfY）を viewport 点へ変換し、viewport 上の bbox を取り `%` rect を作る
  - [x] `Rect` しか無い場合も、4隅を変換して bbox を取り `%` rect を作る（回転時の順序差を吸収）
- [x] Export:
  - [x] `HighlightRect` を viewport→pdf に変換して `QuadPoints` を作る（rect 単位、または統合bbox＋複数QuadPoints）
  - [x] 注釈辞書の `Rect` は `QuadPoints` 全体の bbox で生成する
- [x] コメント（/Text）の位置も viewport 変換へ寄せる（少なくとも中心点の変換を統一）
- [ ] 回転/CropBox のあるPDFで、Import/Export の両方を手動検証する

## 受け入れ条件
- アプリ出力PDFを Acrobat Reader で開くと、ハイライト/コメントの位置が期待通りに見える
- Acrobat で追加した `/Highlight` `/Text` を取り込んでも、位置/サイズが大きく崩れない

## 検証手順（手動）
- rotate/CropBox ありPDFで、アプリでハイライト・コメント追加→ダウンロード→Acrobatで表示
- Acrobat側で同PDFにハイライト・付箋追加→本アプリで取り込み→位置/内容を確認

