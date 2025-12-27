# 調査・修正方針: ハイライト精度 / ズーム追従 / PDF注釈（Adobe互換）

作成日: 2025-12-27  
対象リポジトリ: `pdf-viewer`（Angular / pdfjs-dist / pdf-lib）

## 0. 目的
ユーザーからの評価が低い「ハイライト機能」について、現状実装のどこに不具合要因があるかを整理し、修正方針（必要なら要件再定義）を決める。

このドキュメントは「まず直すべき不具合」と「作り直しが必要な領域」を切り分けるための調査メモ兼方針案です。

## 1. 現状実装（要点）
関連設計:
- `docs/design/highlight-design.md`（Marker 方式・%座標）
- `docs/investigations/pdf-annotation-investigation.md`（PDF注釈方針）

主要コード:
- ハイライト描画/選択/一覧: `src/app/pages/viewer-shell/viewer-shell.component.*`
- ハイライト状態管理: `src/app/features/annotations/annotation-facade.service.ts`
- PDF注釈の入出力（Import/Export）: `src/app/features/pdf/pdf-facade.service.ts`

ポイント:
- ハイライトは `Marker`（`HighlightRect[]`）の矩形オーバーレイで描画。
  - `HighlightRect` はページに対する **%（0..100）**。
- 選択ハイライト追加は `Range.getClientRects()` で矩形化して `AnnotationFacadeService.addMarker()`。
- PDFダウンロード時は `pdf-lib` で `/Subtype /Highlight`（`QuadPoints`）や `/Subtype /Text` を追加して保存。
- PDF取り込み時は `pdfjs-dist` の `page.getAnnotations()` から `highlight/text/freetext` を抽出し、Marker/Comment に変換して read-only 表示。

## 2. ユーザーフィードバック（原文）
- ハイライトの大きさが大きすぎてハイライトすべき範囲を大幅に超えている
- PDFの表示倍率を大きくしたときにハイライトの大きさが追従できておらず、ハイライトが小さすぎてハイライトの範囲が足りていない
- ダウンロードしたPDFのアノテーションが正しく登録できていないため、Adobeアクロバットリーダーアプリとの互換性がない
- ダウンロードしたPDFを再度表示に取り込むとコメントやハイライトのラベルに表示されている文字の内容が変わっている
- Adobeアクロバットリーダーアプリでマーカーを追加したりコメントを追加した後にこのアプリに取り込むとハイライトマーカーやコメントが正しく表示されない

## 3. 原因仮説（コード上の根拠つき）
### 3.1 ハイライトが「大きすぎる」
仮説A（濃厚）: **選択範囲→矩形化が粗い**
- 選択ハイライトは `ViewerShellComponent.rectsFromRange()` が `Range.getClientRects()` をそのまま %化して保持している。
- PDF.js の textLayer は `span` が transform/absolute で配置されるため、ブラウザ実装によっては「部分選択」でも rect が span 全体になり、選択より広い矩形が返ることがある。

仮説B: **矩形の後処理（クランプ/マージ）が不足**
- `HighlightRect` は 0..100 にクランプされておらず、ページ外にはみ出す rect がそのまま描画され得る。
- 同一行・近接矩形のマージがないため、結果が視覚的に“太く/広く”見える可能性。

対応方針（後述）:
- 選択は `Range.getClientRects()` ではなく、既に検索で利用している `PageTextLayout`（start/end offset）ベースで矩形化する（可能なら）  
  → 既存コードに `rectsFromOffsetsInLayout()` があるため、ロジック統一が可能。
- 最終的に描画に回す前に rect のクランプ・整形（マージ/重複除去）を入れる。

### 3.2 ズーム時にハイライトが追従せず「小さすぎる」
仮説A（濃厚）: **オーバーレイと textLayer/canvas の基準矩形がズレる**
- textLayer は `syncTextLayerScale()` で「canvas が CSS によりリサイズされた場合」でも追従するようになっている。
- 一方、ハイライトの正規化やページオーバーレイは `resolvePageContentRect(pageElement)`（page 要素基準）で計算している。
- canvas 側が `max-width` などで縮む/伸びるケースで、page 要素の client box と canvas の実表示サイズが一致しないと、ハイライトの %→px 変換がズレて「追従していない」ように見える。

仮説B: **“矩形のみ保存”の仕様限界が顕在化**
- `docs/design/highlight-design.md` の既知制約通り、選択ハイライトは rects のみ保存であり、再レンダリング（ズーム/再描画）で textLayer 側の字詰めが変わるとズレる。
- 目立つのが「拡大時」。文字配置の誤差が拡大され、範囲不足に見える可能性がある。

対応方針（後述）:
- “基準矩形”を canvas（表示実寸）に統一する（page ではなく canvas rect を基準に %化/オーバーレイ配置）。
- 仕様としてズーム追従精度を上げたい場合は、Marker に「テキストアンカー（offset）」を持たせ、ズーム後に `PageTextLayout` から rects を再計算する方式へ寄せる（作り直し寄り）。

### 3.3 ダウンロードPDFが Adobe Reader と互換にならない
仮説A（濃厚）: **PDF注釈座標系の取り扱いが不十分（CropBox/Rotate 等）**
- Export は `pdf-lib` 側でページサイズ（`page.getSize()`）を 0..width/height の単純座標として扱い、%→PDF座標へ変換している。
- Import も `viewport.width/height` を 0..width/height とみなし、`QuadPoints/Rect` を単純に正規化している。
- しかし実際のPDFはページ原点が (0,0) とは限らず（CropBox のオフセット等）、/Rotate が入ることもあり、**“単純0..W/H変換”では Acrobat とズレる/見えない**ケースが出る。

仮説B: **Appearance（/AP）不足**
- Acrobat 側は注釈の /AP（appearance stream）が無い/不十分な場合、表示しない（または期待通りに描画しない）ケースがある。
- 現状の Export は注釈辞書（/Highlight, /Text）を追加しているが、/AP を生成していない。

対応方針（後述）:
- まず座標変換を PDF.js の `PageViewport` 変換（`convertToViewportPoint` / `convertToPdfPoint`）に寄せて CropBox/Rotate を吸収する。
- それでも Acrobat で見えない場合のみ、/AP を最小実装する（または PDF.js の `saveDocument()` 経由へ切替）。

### 3.4 再取り込みで「ラベル文字が変わる」
原因（確定）: **Export が label を優先せず text を優先している**
- ダウンロード用 `buildAnnotationExport()` は `contents = marker.text || marker.label` になっている。
- Marker のラベルは編集可能だが、`marker.text`（選択文字列プレビュー）が存在すると **ラベル編集が export に反映されない**。
- Import は `annotation.contents` を `marker.label` にマッピングしているため、再取り込み時にラベルが「選択文字列」に置き換わって見える。

対応方針（後述）:
- Export の `contents` は `label` 優先にする（`label || text`）。
- 可能なら PDF注釈の `Contents/Subject` などに役割を分けて保持（例: `Contents=label`, `Subject=selectedText`）し、Import 時に復元する。

### 3.5 Acrobat で追加した注釈を取り込むと表示が崩れる
仮説A（濃厚）: **Import の座標変換が Acrobat の注釈と合っていない**
- `readPdfAnnotations()` は `highlight/text/freetext` を見ているが、座標は “単純 0..W/H 正規化”。
- Acrobat の注釈（特に回転ページやCropBoxあり）を正しく %へ落とせず、結果として位置/サイズが崩れる可能性。

仮説B: **注釈の組（Text + Popup）や派生 subtype の扱い不足**
- Acrobat の Text 注釈は Popup とペアになっていることがある（`/Subtype /Popup`）。
- highlight も “highlight 以外の markup（underline/squiggly/strikeout）” が混ざると、現状の抽出では欠落する。

対応方針（後述）:
- まず座標変換を viewport 変換へ。
- 取り込み対象 subtype の要件を決めた上で、必要な subtype（Popup/Underline 等）を追加対応。

## 4. 修正方針（推奨ロードマップ）
### Phase 1（短期）: 既存仕様のまま不具合を止血
狙い: “今のデータモデル（rects%）”のまま、ユーザー体感の悪いズレ/過大を抑える。

1) **選択ハイライトの矩形化を改善**
- `Range.getClientRects()` 依存を減らし、可能なら `PageTextLayout`（offset）ベースで矩形化する。
- rect 整形（0..100 クランプ、重複除去、同一行の近接 rect マージ）を追加する。

2) **基準矩形（%化の基準）を統一**
- “page要素”ではなく “canvas（表示実寸）”を基準矩形にする案を検討し、textLayer/overlay/selection の計算を揃える。
- ズーム/リサイズ後に `pageOverlays` 再計算が確実に走ることを確認（`syncDomRefs()` の呼ばれ方/タイミング）。

3) **ラベルの再取り込み不具合を修正**
- Export: `contents` は `label` 優先（`label || text`）。
- Import: `Contents/Subject` 等のどのフィールドから label/text を復元するかを整理し、ラベルが勝手に置き換わらないようにする。

### Phase 2（中期）: Acrobat 互換の注釈入出力を固める
狙い: “出力PDFを Acrobat で開ける/取り込みも破綻しない”を現実的に達成する。

1) **座標変換を PageViewport 変換に寄せる**
- Import: `QuadPoints/Rect`（PDF座標）→ `viewport.convertToViewportPoint` → %へ正規化。
- Export: % → viewport座標 → `viewport.convertToPdfPoint` → PDF座標（pdf-lib で辞書生成）。
  - これにより CropBox/Rotate/オフセット差を吸収できる。

2) **Acrobat で見えない場合の /AP 対応**
- まず座標変換修正後に Acrobat/Preview/Chrome で表示検証。
- まだ不可の場合、Highlight/Text 注釈の /AP（appearance stream）を最小実装するか、PDF.js の `saveDocument()` 方式へ切替を検討する。

### Phase 3（要件次第）: “作り直し”判断ポイント
次が要件に含まれる場合は、既存の Marker オーバーレイ方式だけでは限界が出るため、要件定義から再設計を推奨。

- 取り込んだ PDF注釈を編集して再保存したい（Acrobat互換を維持したまま）
- ハイライトが「常にテキストに再追従」してほしい（ズーム/再描画/フォント差でもズレない）
- コメントを PDFの “付箋（/Text）” として相互編集したい（スレッド/返信も含む）

この場合の選択肢:
- A) PDF.js Annotation Editor を主軸に寄せる（対応可能な注釈種別に制約あり）
- B) 引き続き pdf-lib だが、Appearance/座標変換/メタ保持を本格実装する（工数大）
- C) 商用SDK（PSPDFKit / Apryse 等）導入（コスト/ライセンス要検討）

## 5. 追加で決めるべき要件（確認事項）
最短で品質を上げるため、以下を先に合意したい。

1) ラベルと選択文字列の扱い
- ラベル（ユーザー編集）を PDFに保存して再取り込みで復元する必要があるか？
- 選択文字列（プレビュー）は PDFに保存する必要があるか？（不要なら保存しない方が互換面で安全）

2) Acrobat互換の定義
- “表示できる”がゴールか、“編集して戻せる”まで必要か？
- 対象ビューア: Adobe Acrobat Reader / Acrobat Pro / macOS Preview / Chrome / Edge など、優先順位は？

3) 取り込み対象注釈
- highlight のみか、underline/squiggly/strikeout も同等に扱うか？
- コメントは /Text（付箋）だけでよいか、/FreeText（ページ上文字）も必要か？

## 6. 検証観点（受け入れ条件案）
UI（アプリ内）:
- 選択ハイライトが選択範囲を大幅に超えない（行内の過大幅が発生しない）
- ズーム（0.5〜3.0）でもハイライトの位置/サイズが破綻しない
- ラベル編集後にダウンロード→再取り込みしてもラベルが保持される

PDF入出力:
- アプリで作成した注釈付きPDFを Adobe Reader で開くとハイライト/コメントが表示される
- Acrobat で追加した highlight(/Highlight)・付箋(/Text) を取り込んでも位置と内容が破綻しない

