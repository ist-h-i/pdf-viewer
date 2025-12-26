# PDFドラッグ&ドロップ取り込み 仕様・詳細設計

対象: `pdf-viewer` / `docs/issues.md` 新規開発機能 **1. PDFのドラッグ&ドロップ取り込み**  
関連: 複数PDFライブラリ化（`docs/multi-pdf-library-design.md`）

---

## 1. ゴール/非ゴール

### ゴール
- OS から PDF ファイルを **ドラッグ&ドロップ**して読み込みできる
- ドラッグ中に **ドロップ可能領域をハイライト**し、ユーザに操作可能であることを示す
- **PDF以外は拒否**し、ユーザに分かるフィードバックを出す
- 複数ファイルのドロップは「複数PDFライブラリ」の仕様に従って **追加読み込み**する

### 非ゴール（MVP）
- PDF 以外（URL、フォルダ、画像等）の取り込み
- 取り込み中のキャンセル（将来拡張として設計は記載）
- サーバアップロード/永続化

---

## 2. UI仕様

### 2.1 ドロップ可能領域
- 優先: `ViewerShellComponent` の **ビューア領域**（例: `.viewer-shell__viewer`）
- 代替: 画面全体（`document` または `.viewer-shell` ルート）にイベントを張り、ビューア外でも受ける

> 指針: 実装を単純にするため、イベントは `document` に張りつつ「ハイライト表示はビューア領域に重ねる」のが安定。

### 2.2 ドラッグ中の表示
- ドラッグ中（ファイルが領域上にある）:
  - 透過オーバーレイ（枠/背景の強調）
  - 文言例: `PDFをここにドロップ`
  - `dropEffect='copy'` を指定し、OSカーソルが「コピー」になるようにする

### 2.3 ドロップ時の挙動
- PDF を受理した場合:
  - ライブラリに追加（複数PDFが有効な場合）
  - 追加した PDF を選択状態にし、表示を切り替える
  - 読み込み中は既存の `pdf.isLoading()` 表示（ヘッダーの「読み込み中...」）を利用

### 2.4 エラー表示
- PDF 以外をドロップ:
  - トースト（推奨）またはヘッダーのエラーピル（既存の `pdf.lastError()`）で「PDF以外は取り込めません」を表示
- PDFとして読み込めない（破損/暗号化等）:
  - `PdfFacadeService` のエラーを表示（既存の `pdf.lastError()`）し、**既存の表示は維持**

---

## 3. 入力仕様（ファイル判定）

### 3.1 受理条件
- `file.type === 'application/pdf'` を優先
- `file.type` が空/不明な場合は拡張子で補助判定:
  - `/.pdf$/i.test(file.name)`

### 3.2 複数ファイル
- `DataTransfer.files` の順序で処理し、ライブラリへ順次追加する
- 「追加時は選択状態にする」の規則に従い、結果として **最後に追加したPDF**が選択状態になる

---

## 4. 実装設計（Angular）

### 4.1 追加する状態（ViewerShellComponent）
- `isDragOver = signal(false)`（ドラッグ中オーバーレイ表示）
- `dragCounter = 0`（`dragenter` / `dragleave` のネスト対策）

> `dragenter` は子要素の出入りでも発火するため、カウンタ方式で「本当に領域外に出た」タイミングを検出する。

### 4.2 追加するDOM/テンプレート
- `.viewer-shell__viewer` の直下に、`@if (isDragOver())` でオーバーレイ要素を配置
- オーバーレイは `pointer-events: none`（イベント阻害を避ける）

### 4.3 イベントハンドリング
推奨: `document` に対する `addEventListener` を `ngAfterViewInit` で登録し、`ngOnDestroy` で解除。

取り扱うイベント:
- `dragenter`: ファイルドラッグなら `dragCounter++`、`isDragOver=true`
- `dragover`: `preventDefault()`、`dataTransfer.dropEffect='copy'`
- `dragleave`: `dragCounter--`、0 になったら `isDragOver=false`
- `drop`: `preventDefault()`、`dragCounter=0`、`isDragOver=false`、`File[]` を抽出して取り込み処理へ

ファイルドラッグ判定（例）:
- `event.dataTransfer?.types?.includes('Files')`

### 4.4 取り込み処理（複数PDFライブラリ連携）
- ライブラリ導入後:
  - `PdfLibraryFacadeService.addFiles(files)` を呼ぶ
- ライブラリ未導入（暫定）:
  - `pdf.loadFile(files[0])` で単一置換（現行挙動）

---

## 5. 例外/エッジケース

- ブラウザ外（SSR）: `isPlatformBrowser` ガードで何もしない
- `DataTransferItem` が `kind='file'` 以外（URL等）: 無視
- 同時に複数のドラッグ操作: `dragCounter` を `0` で強制リセット（drop時）

---

## 6. 将来拡張（キャンセル）

要件にある「巨大ファイル時のキャンセル」を実装する場合:
- `PdfFacadeService.loadFile()` を `loadingTask = pdfjs.getDocument(...)` を保持する形に変更
- UI から `loadingTask.destroy()` を呼べる `cancelLoading()` を用意
- キャンセル時は `pdf.isLoading=false` にし、既存表示を維持

---

## 7. 受け入れ条件（`docs/issues.md`対応）
- PDFをドロップすると表示が切り替わる（初回取り込みとして動作）
- PDF以外は取り込まれず、ユーザに分かる形で通知される
- 複数PDFをドロップした場合はライブラリに追加され、最後に追加したPDFが表示される

