# 不具合内容報告書: PDF表示とハイライト位置のずれ（TextLayerスケール未設定）

## 1. 現象
- PDFページの実描画（canvas）に対して、テキスト選択のハイライトやMarker矩形が上下/左右にずれて表示される。
- ずれ量は拡大/縮小で増幅し、表組みや小さな文字で目立つ。

## 2. 再現手順
1. PDFを読み込む。
2. 文字列をドラッグ選択する。
3. 選択ハイライト表示、または「選択範囲をハイライト」を実行する。
4. 文字の実位置とハイライト矩形の位置が一致しない。

## 3. 期待結果
- canvas描画の文字位置と、TextLayer由来の選択/ハイライト矩形が一致する。

## 4. 解析結果（表示までの流れ）
- `PdfFacadeService.loadBytes()` → `renderAllPages()` でページ情報を生成する。
- `ViewerShellComponent.renderBasePages()`:
  - `pdf.renderPageToCanvas()` が `PageViewport` を使って canvas を描画。
  - `pdf.renderTextLayer()` が pdf.js `TextLayer` で `.textLayer` を生成。
  - `PageTextLayout` を `textLayouts` に保持し、選択/検索/ハイライトに利用。
- ハイライト描画:
  - 選択/検索/インポートは `HighlightRect(%)` へ正規化し、`.viewer-shell__page-overlay` に描画。

## 5. 原因
- pdf.js `TextLayer` は CSS 変数 `--scale-factor` を前提に、`font-size` や span の transform を計算する。
  - `calc(var(--scale-factor) * ...)` を使っており、`--scale-factor` が未定義だとfont-sizeが不正になる。
- 本アプリのDOMには `.pdfViewer` が無く、`pdf_viewer.css` が定義する `--scale-factor` が適用されない。
- その結果、TextLayer の font-size/transform が未スケールのままになり、
  `range.getClientRects()` 由来の矩形（選択ハイライト・Marker）が canvas 上の実描画とずれる。

## 6. 影響範囲
- テキスト選択ハイライト（OS/ブラウザの選択表示）
- `Marker` 矩形（選択/検索/インポート）
- 文字位置に依存する比較ハイライトや検索結果

## 7. 解決方針
- PDFページ描画時に `--scale-factor` を明示的に付与し、TextLayerが想定する座標系を復元する。
  - 例: `.viewer-shell__pdf-page` もしくは `.viewer-shell__pdf-pages` に
    `--scale-factor: <viewport.scale>` を `style.setProperty()` で設定する。
- ズーム変更時は該当ページの `--scale-factor` を更新する。

## 8. 確認方法
- PDF読み込み後、テキスト選択のハイライトが文字に一致すること。
- ズーム 50%/100%/200% でハイライト位置が一致すること。
- 検索/Markerの矩形が文字位置に追従すること。
