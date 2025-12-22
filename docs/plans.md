# コーディング計画（pdf-viewer）

参照: `docs/requirement.md` / `docs/function-list.md`

## 1. 機能対応状況（設計書とのギャップ）

| ID | 機能 | 状況 | 補足 | 関連コード |
| --- | --- | --- | --- | --- |
| FR-01 | PDF 読み込み | 実装済み（要改善あり） | 同一ファイルを再選択しても再読み込みできない可能性 | `src/app/pages/viewer-shell/viewer-shell.component.ts` |
| FR-02 | PDF 表示（縦スクロール） | 実装済み |  | `src/app/pages/viewer-shell/viewer-shell.component.html` |
| FR-03 | ズーム | 実装済み（要検証） | 注釈レイヤーの追従（ズーム後のズレ）を重点確認 | `src/app/features/pdf/pdf-facade.service.ts` |
| FR-04 | ダウンロード | 実装済み |  | `src/app/features/pdf/pdf-facade.service.ts` |
| FR-05 | 全文検索＋ハイライト | 実装済み |  | `src/app/features/search/search-facade.service.ts` / `src/app/pages/viewer-shell/viewer-shell.component.ts` |
| FR-06 | 選択テキストのハイライト | 実装済み |  | `src/app/pages/viewer-shell/viewer-shell.component.ts` |
| FR-07 | コメント（追加/移動/返信/削除） | 実装済み |  | `src/app/features/annotations/annotation-facade.service.ts` / `src/app/pages/viewer-shell/viewer-shell.component.html` |
| FR-08 | OCR（擬似） | 実装済み |  | `src/app/features/ocr/ocr-facade.service.ts` |
| FR-09 | PDF 比較（テキストベース） | 部分実装 | サマリ表示のみ。左右分割表示・差分ハイライトは未実装 | `src/app/features/compare/compare-facade.service.ts` / `src/app/pages/viewer-shell/viewer-shell.component.html` |
| FR-10 | 機能フラグ | 部分実装 | サイドパネル表示のみ。コンテキストメニュー/注釈レイヤー等が未対応 | `src/app/core/feature-flags.ts` / `src/app/pages/viewer-shell/viewer-shell.component.html` |

## 2. 不具合（修正対象）

### P0（早期対応）
- **PDF 再選択で再読み込みできない**: メインのファイルピッカーで同一ファイルを再選択した際に `(change)` が発火しない可能性。`onFileChange()` で `input.value = ''` を行う。  
  - 対象: `src/app/pages/viewer-shell/viewer-shell.component.ts`
- **FeatureFlags が実質無効**: `flags.comments=false` 等でも、右クリックメニューからコメント/ハイライト追加でき、注釈が表示される。UI/イベントを機能フラグでガードする。  
  - 対象: `src/app/pages/viewer-shell/viewer-shell.component.html` / `src/app/pages/viewer-shell/viewer-shell.component.ts`

### P1（品質改善）
- **デバッグログの残存**: `pdfSource()` の `console.log` を削除（パフォーマンス/ノイズ）。  
  - 対象: `src/app/pages/viewer-shell/viewer-shell.component.ts`
- **サブスクの後始末不足**: `pageWrappers.changes.subscribe(...)` を `ngOnDestroy` で解除（または `takeUntilDestroyed`）。  
  - 対象: `src/app/pages/viewer-shell/viewer-shell.component.ts`
- **PDF worker 参照の不統一**: `CompareFacadeService` が `pdfjs-dist/build/...` を指し、設計書の「ローカル配信（assets）」方針とズレるため、`PDF_WORKER_SRC` に統一する。  
  - 対象: `src/app/features/compare/compare-facade.service.ts` / `src/app/core/pdf-worker.ts`

## 3. 未実装（設計書上は必要）

### FR-09: PDF 比較（左右分割表示・差分ハイライト）
- 左右分割で「比較元（現在表示中）」と「比較対象 PDF」を同時表示する UI
- 差分ページ/差分箇所のハイライト（テキストベース）
- 変更ページ一覧からのジャンプ（クリックで該当ページへスクロール）

### FR-10: 機能フラグの完全対応
- `search/markers/comments/ocr/compare` を個別に「機能として無効化」する（表示非表示だけでなく、操作/生成も不可にする）

## 4. コーディング計画（段階的に実装）

### Phase 1: 既存機能の不具合修正（P0/P1）
1. `onFileChange()` で `input.value = ''` を追加（同一 PDF の再選択対応）
2. `pdfSource()` の `console.log` を削除
3. `pageWrappers.changes` の購読解除（メモリリーク対策）
4. Compare の workerSrc を `PDF_WORKER_SRC` に統一

**受け入れ基準**
- 同一 PDF を連続で選択しても読み込みが走る
- コンソールに `pdfSource called` が出ない
- コンポーネント破棄時に購読/リスナーが残らない
- 比較実行後も PDF 表示/検索/注釈が継続して動作する

### Phase 2: FeatureFlags の完全対応（P0）
1. テンプレート側: コンテキストメニューの各ボタンを `flags.comments` / `flags.markers` で出し分け
2. テンプレート側: 注釈レイヤー（markers/comments の描画）を `flags.*` でガード
3. ロジック側: `addCommentFromContextMenu()` / `addHighlightFromSelection()` 等をフラグで早期 return
4. UI: `markers/comments` が両方 false の場合は「オブジェクト ON/OFF」ボタンを無効化または非表示

**受け入れ基準**
- `FEATURE_FLAGS` の DI 値で、該当機能の UI が出ず、操作してもデータが生成されない

### Phase 3: PDF 比較 UI（左右分割）MVP（P1）
1. 「比較対象 PDF」の **bytes とページ情報** を保持する状態を追加（CompareFacade または別 Facade）
2. ビューア領域を左右分割し、右側に比較対象 PDF をレンダリング（`ng2-pdf-viewer` を再利用）
3. 比較サマリ（追加/削除/変更ページ）をクリック可能にし、左右のビューアを該当ページへスクロール

**受け入れ基準**
- 比較対象 PDF を選ぶと、左右に 2 つの PDF が表示される
- 変更ページをクリックすると、左右それぞれ該当ページに移動できる

### Phase 4: 差分ハイライト（P2→要件優先なら P1）
1. **ページ単位ハイライト**（changedPages のページ枠/ラベル強調）を先に実装
2. **テキスト差分ハイライト**（文字/単語差分を rect に変換して重ねる）を実装  
   - 差分アルゴリズム（例: diff-match-patch / 自前の簡易 diff）を選定
   - 既存の `PageTextLayout` と `rectsFromOffsets()` を再利用し、左右の textLayout を取得できるようにする

**受け入れ基準**
- changedPages が左右ビューア上で視覚的に識別できる
- 差分箇所がハイライトとして表示される（少なくとも「差分がある部分」の追跡が可能）

## 5. 検証項目（最低限）
- PDF 読み込み → ズーム → 注釈（コメント/ハイライト） → ズーム → 位置ズレがない
- 検索 → ハイライト表示 → クリア → 表示が消える
- FeatureFlags を個別に false にして UI と操作の両方が無効になる
- 比較: 小さな PDF（数ページ）で追加/削除/変更ページが期待通りになる

