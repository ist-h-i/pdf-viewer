# PDF Annotation（コメント/ハイライト）技術導入調査

作成日: 2025-12-23  
対象リポジトリ: `pdf-viewer`（Angular / `ng2-pdf-viewer` / `pdfjs-dist`）

## 1. 調査結果（技術導入は可能か）

### 結論
- **可能**です。`pdfjs-dist@4.8.69`（PDF.js）には **Annotation（既存注釈）の読み取り/描画** と、限定的ですが **新規注釈の作成（Annotation Editor）** と **PDFへの保存（`PDFDocumentProxy.saveDocument()`）** の仕組みがあります。
- ただし現状の実装は、`ng2-pdf-viewer@10.4.0` が **Annotation Editor を無効化（`AnnotationEditorType.DISABLE`）** しており、そのままでは「PDFに注釈オブジェクトを書き込む」導線を作れません。
- 以前はページごとに `<pdf-viewer [show-all]=false>` を複数生成していましたが、現在は `<pdf-viewer [show-all]=true>` の単一インスタンスに整理済みです。Annotation Editor ベースでいく場合は、引き続き `ng2-pdf-viewer` 側の `annotationEditorMode` 無効化解除が前提になります。

### 何が「PDF annotation」か（整理）
PDFの注釈は PDF 内部のオブジェクト（`/Type /Annot`）で、代表例は以下です。
- **ハイライト**: `/Subtype /Highlight`（`/QuadPoints` による強調領域、色 `C`、透明度 `CA`、コメント `Contents` 等）
- **コメント（付箋）**: `/Subtype /Text`（ページ上のアイコン＋ポップアップ、本文 `Contents`）
- **フリーテキスト**: `/Subtype /FreeText`（ページに直接テキストを描画する注釈）
- **返信/スレッド**: `InReplyTo (IRT)` 等で関連付け可能（ビューア側対応がまちまち）

### PDF.js（`pdfjs-dist@4.8.69`）でできること
- **既存注釈の取得**: `PDFPageProxy.getAnnotations()`（既存PDFに入っている注釈の配列を取得可能）
- **保存**: `PDFDocumentProxy.saveDocument()`（フォーム入力や Annotation Editor の変更を反映したPDFバイト列を取得可能）
- **Annotation Editor**: `AnnotationEditorType` として `HIGHLIGHT / FREETEXT / INK / STAMP` が存在（=少なくともハイライトは editor 対応の範囲）
  - 一方で、一般的な「付箋コメント（/Text 注釈）」をそのまま作る editor モードは見当たりません（少なくとも公開されている `AnnotationEditorType` には含まれない）。

### 現状スタックにおける制約
- `ng2-pdf-viewer` は内部で `pdfjs-dist/web/pdf_viewer.mjs` の `PDFViewer` を使っていますが、viewer オプションで `annotationEditorMode: DISABLE` を設定しており、**注釈作成機能が使えない**状態です。
- 現行のコメント/ハイライトは **PDFに書き込まれない**（=外部PDFビューアで見えない）カスタムオーバーレイ実装です。
  - ハイライト: `Marker`（`HighlightRect[]`）を `div.highlight` のオーバーレイで描画（選択/検索で方式統一）
  - コメント: `CommentCard` を基にしたアンカー/吹き出しの重畳表示

## 2. 実装方法（候補）

### 方針A: PDF.js Annotation Editor を有効化して「注釈=PDFのオブジェクト」として扱う
目的: アプリ内でも「PDF注釈」として編集し、保存/ダウンロードでPDFに埋め込む。

やること（概要）:
1. **Viewer構成を1つのPDFDocumentに集約**する  
   現状はページごとに `<pdf-viewer>` を生成しており、注釈保存の前提（単一 `PDFDocumentProxy` の `annotationStorage` へ集約）と相性が悪いです。  
   - 例: `ng2-pdf-viewer` を **`[show-all]=true` の単一インスタンス**に寄せる、または `pdfjs-dist/web` を直接使うカスタムViewerに移行する。
2. `ng2-pdf-viewer` の `annotationEditorMode` 強制 `DISABLE` を解除（fork/patch 等）し、初期値を `NONE` にする  
3. UI（ボタン/ショートカット）で `pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.HIGHLIGHT }` 等を切り替え
4. ダウンロード時に `pdfDocument.saveDocument()` の返す bytes を使って保存する（未変更なら従来どおり元PDF）

コメント対応の考え方:
- Editorが `/Text` 注釈（付箋）を直接作れない場合、まずは **`FreeText` 注釈**で代替するか、別方式（方針B）と組み合わせます。

メリット:
- 「注釈をPDFに保持」しやすい（`saveDocument()` に乗る）
- 将来、外部ビューア互換を担保しやすい

デメリット:
- `ng2-pdf-viewer` の fork/patch と viewer 構成変更が必要（影響範囲が大きい）
- コメント（付箋）やスレッド等、やりたい注釈タイプが editor で不足する可能性

### 方針B: 現行UIは維持し、ダウンロード時にPDFへ「注釈オブジェクト」を書き込む（PDF編集ライブラリ併用）
目的: UI/UXは現状のまま、**出力PDFだけ注釈を持つ**ようにする（導入コストを下げる）。

やること（概要）:
1. 現行の `Marker` / `CommentCard` を「PDF注釈」に変換する
   - ハイライト: 既存の矩形（`HighlightRect`）を、ページViewport経由で PDF座標へ変換し、`/Subtype /Highlight`（`QuadPoints`）を生成
   - コメント: `CommentCard.anchorX/Y` を PDF座標へ変換し、`/Subtype /Text`（付箋）または `/Subtype /FreeText` を生成
2. 生成した注釈を PDF に追加して新しい bytes を作成し、`downloadCurrentPdf()` の出力に使う

補足:
- PDF.js 単体で「任意の注釈辞書を追加」する公開APIは前提にしづらいため、実装の現実解としては `pdf-lib` 等のPDF編集ライブラリで注釈辞書を構築するのが安全です（低レベル実装は必要）。

メリット:
- Viewer構成を大きく変えずに「注釈付きPDF出力」を実現できる
- コメント（付箋）等、注釈タイプを広く扱える余地がある

デメリット:
- 注釈辞書（`QuadPoints`/`Rect`/色/透明度など）を自前で正しく組み立てる必要がある
- 既存の「コメントスレッド」をPDF注釈の返信構造へ落とす場合は追加設計が必要

### 方針C: 商用SDKを採用（PSPDFKit / Apryse(PDFTron) 等）
目的: 注釈編集・スレッド・インポート/エクスポート互換を短期間で揃える。  
本リポジトリの方針（ローカル処理・依存最小）と相反する可能性があるため、費用/ライセンスを含め別途判断。

## 3. 既存実装との差分

| 観点 | 既存（カスタムオーバーレイ） | PDF Annotation 導入後 |
| --- | --- | --- |
| データの実体 | アプリ内 state（`AnnotationFacadeService` 等） | PDF内オブジェクト（`/Annot`）＋必要ならアプリ側メタ |
| 座標系 | ページDOM基準の正規化（0..1 や 0..100%） | PDFユーザ空間（pt、原点は基本左下） |
| ハイライト | `Marker`（rects）を `div.highlight` で重畳（選択/検索共通） | `/Highlight`（`QuadPoints`）として保持し、ビューアは注釈レイヤで描画 |
| コメント | アンカー＋吹き出し＋スレッド（独自UI） | `/Text`（付箋）or `/FreeText` 等。スレッドはPDFの返信構造へ落とす設計が必要 |
| 永続化/共有 | リロードで消える（永続化・エクスポートは要件外） | PDFに保存すれば他ビューアでも可視（互換性の範囲あり） |
| ダウンロード | `originalFileBytes` をそのまま保存 | `saveDocument()` または編集後bytesを保存 |

## 4. 修正方針（推奨の進め方）

### Step 0: 期待値を確定（最重要）
以下を先に決めると実装ブレが減ります。
- 「コメント」は **付箋（/Text）** が必須か？ それとも **ページに文字が出る（/FreeText）** でもよいか？
- スレッド（返信）はPDF注釈に落とす必須要件か？（必須なら `IRT` 等の設計が必要）
- 目的は「アプリ内で編集」か「注釈付きPDFの出力」か（後者のみなら方針Bが最短）

### Step 1（小さく価値を出す）: 注釈付きPDFダウンロード
- 既存UIのまま、`downloadCurrentPdf()` を「注釈付きPDF」に切り替えられるようにする（機能フラグや別ボタンでも可）
- まずは以下に絞る:
  - ハイライト: 既存の矩形情報 → `/Highlight` へ変換
  - コメント: `title + messages` → `Contents` に集約して `/Text` or `/FreeText`

影響範囲（想定）:
- `src/app/features/pdf/pdf-facade.service.ts`（ダウンロードbytesの生成）
- `src/app/features/annotations/annotation-facade.service.ts`（注釈取得APIの拡張が必要なら）
- `src/app/pages/viewer-shell/viewer-shell.component.ts`（ハイライト/コメントの取り出し口整備）

### Step 2（中期）: Viewer構成の整理（必要なら）
- Annotation Editor を採用するなら、ページごとの `<pdf-viewer>` 複数生成を見直し、1ドキュメントに集約する（※現行は `<pdf-viewer [show-all]=true>` の単一インスタンス構成に整理済み）
- ハイライトは Marker 方式に統一済み（DOM ラップ依存は解消済み）

### Step 3（将来）: PDF注釈の読み込み・UI統合
- `page.getAnnotations()` で既存注釈を読み込み、アプリの表示（独自UI or PDF.js注釈UI）へ統合
- 既存の `CommentCard` スレッドとPDF注釈返信構造のマッピング方針を確定する

## 5. 実装状況（2025-12-24）
- 方針: **方針B（PDF編集ライブラリ併用）** を採用
- Step 1: 実装済み。`pdf-lib` で注釈辞書を組み立て、`downloadCurrentPdf()` の出力に反映（`src/app/features/pdf/pdf-facade.service.ts` / `src/app/pages/viewer-shell/viewer-shell.component.ts`）。
- Step 2: Annotation Editor は未対応（`ng2-pdf-viewer` 側の `annotationEditorMode` は無効のまま）。ただし Viewer は単一インスタンス構成に整理済み（`src/app/pages/viewer-shell/viewer-shell.component.html`）。
- 付随対応: 選択ハイライトも `Marker`（rects）方式に統一済み（DOM ラップ方式は廃止）。
- Step 3: 実装済み。`readPdfAnnotations()` でPDF注釈を読み込み、`AnnotationFacadeService` に統合して read-only 表示（`src/app/features/pdf/pdf-facade.service.ts` / `src/app/features/annotations/annotation-facade.service.ts` / `src/app/pages/viewer-shell/viewer-shell.component.ts`）。
