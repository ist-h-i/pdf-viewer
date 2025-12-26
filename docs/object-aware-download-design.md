# オブジェクトON/OFFに応じたPDF再出力（ダウンロード） 詳細設計

対象: `pdf-viewer` / `docs/issues.md` 新規開発機能 **3. オブジェクト状態の有無でPDFをダウンロード（再出力）**  
関連: 注釈入出力の背景（`docs/pdf-annotation-investigation.md`）、ハイライト（`docs/highlight-design.md`）、コメント（`docs/comment-design.md`）

---

## 1. ゴール/非ゴール

### ゴール
- ヘッダーの「オブジェクト ON/OFF」を「出力モード」にも反映し、以下を実現する
  - **OFF**: 原本（原本相当）をダウンロード
  - **ON**: 現在のオブジェクト状態をPDF注釈として埋め込み、ダウンロード
- ダウンロードファイル名をモードで分ける
  - 原本: `{base}.original.pdf`
  - オブジェクトあり: `{base}.annotated.pdf`
- 生成に時間がかかる場合でも、ユーザが状況を把握できる（ローディング/無効化）

### 非ゴール（MVP）
- 既存PDFに含まれる注釈（インポート注釈）の除去（=「完全に注釈なしPDF」の生成）
  - 本機能の「原本相当」は「アプリ側の注釈を追加しない」意味とする

---

## 2. 「オブジェクト」の定義（要件準拠）

要件上のオブジェクト:
- 選択範囲ハイライト（ユーザー作成）
- 検索ワードハイライト（検索結果）
- コメントボックス（ユーザー作成）

注意:
- PDF内にもともと入っている注釈（`readPdfAnnotations()`でインポートされる `origin='pdf'`）は原本に含まれるため、OFFでも残る（MVPの非ゴール範囲）。

---

## 3. 出力仕様

### 3.1 出力対象
- 常に「現在選択中のPDF」（`PdfFacadeService` の current）

### 3.2 出力モード判定
- `objectsEnabled = showObjects()`（既存のUIトグルを採用）
- `canAnnotate = flags.annotatedDownload`（既存 feature flag）

出力モード:
- `objectsEnabled && canAnnotate` → annotated 出力
- それ以外 → original 出力（注釈生成はしない）

### 3.3 ファイル名
`pdf.pdfName()` からベース名を作り、サフィックスを付与する。

ルール:
- `base = pdfName` から拡張子 `.pdf`（大文字小文字無視）を除去
- original: `${base}.original.pdf`
- annotated: `${base}.annotated.pdf`

例:
- `report.pdf` → `report.original.pdf` / `report.annotated.pdf`
- `report.v2.PDF` → `report.v2.original.pdf` / `report.v2.annotated.pdf`

---

## 4. 実装設計（既存コードへの具体的な差分）

### 4.1 `PdfFacadeService.downloadCurrentPdf()` の拡張
現状は `currentName()` をそのまま `link.download` に使うため、呼び出し側でファイル名を差し替えられない。

提案:
```ts
type PdfDownloadOptions = {
  includeAnnotations?: boolean;
  annotations?: PdfAnnotationExport;
  fileNameOverride?: string; // 追加
};
```

挙動:
- `fileName = options.fileNameOverride ?? currentName() ?? 'document.pdf'`

### 4.2 `ViewerShellComponent.downloadPdf()` の変更
- `includeAnnotations` を `flags.annotatedDownload && showObjects()` に変更
- `fileNameOverride` をモードに応じて付与
- 注釈生成中の UX:
  - `isDownloading = signal(false)` を追加し、実行中はボタンを disabled にする
  - 失敗時は既存の `console.warn` + 原本フォールバック（`PdfFacadeService` 側）でよい

### 4.3 エクスポートする注釈（`buildAnnotationExport()`）
現行はユーザー作成注釈のみ（selection markers + user comments）。
要件に合わせ、検索ハイライトも含める。

提案（出力対象）:
- markers:
  - `source='selection'` のユーザー作成 marker（既存 `exportMarkers()`）
  - `source='search'` の marker（`AnnotationFacadeService.allMarkers()` から抽出）
  - ただし `origin='pdf'` は除外（重複注釈を避ける）
- comments:
  - ユーザー作成コメントのみ（既存 `exportComments()`）

疑似コード:
```ts
const markers = this.annotations
  .allMarkers()
  .filter(m => m.origin !== 'pdf')
  .filter(m => m.source === 'selection' || m.source === 'search');
```

> 検索ハイライトはページ単位で複数rectを持つため、出力サイズが増える。大量ヒット時の挙動は「ローディング表示」と「ユーザの明示操作（ダウンロード）」で吸収する。

---

## 5. ローディング/進捗

MVP:
- `download` ボタン押下後、`isDownloading=true` の間はボタンを disabled
- ヘッダー右側に `ダウンロード中...` 表示（既存のステータスピルと同様の表現）

将来:
- 注釈生成（pdf-lib）に進捗が出せない場合でも、「キャンセル」ボタンの実装は可能
  - `PdfFacadeService` 側で `AbortController` を持つ（ただし pdf-lib は中断が難しいため、UI側で結果を破棄する方式）

---

## 6. 受け入れ条件（`docs/issues.md`対応）
- ON/OFFで出力結果が変わることがユーザに確認できる（ファイル名サフィックスで判別可能）
- ON時に注釈付きPDFが確実にダウンロードされ、Adobe Readerで開ける
- OFF時に注釈生成を行わず原本相当がダウンロードされる

