# Task 03: ラベルの round-trip を修正（ダウンロード→再取り込みで文字が変わる）

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.4）

関連コード:
- Export:
  - `src/app/pages/viewer-shell/viewer-shell.component.ts`（`buildAnnotationExport()`）
  - `src/app/features/pdf/pdf-facade.service.ts`（`buildAnnotatedPdfBytes()`）
- Import:
  - `src/app/features/pdf/pdf-facade.service.ts`（`readPdfAnnotations()`）

## 目的
ユーザーが編集したラベルが、ダウンロード→再取り込みで「選択文字列に置き換わる」不具合を解消する。

## 原因（確定）
`buildAnnotationExport()` が `contents = marker.text || marker.label` となっており、`marker.text` が存在するとラベル編集が export に反映されない。

## 方針（Phase 1）
- `Contents` に入れるのは **ラベル（ユーザー編集）を優先**する（`label || text`）。
- 必要なら（要件次第）、選択文字列（プレビュー）を `Subject` 等の別フィールドに保持して復元できるようにする（`task-00` で合意）。

## 実装タスク（チェックリスト）
- [ ] `buildAnnotationExport()` を `contents = label || text` に修正する
- [ ] 取り込み側で `Contents/Subject` のマッピングを整理する
  - `label`: `Contents`（優先）
  - `text`: `Subject`（または `Contents` フォールバック）
- [ ] コメント（`/Text`）についても、タイトル/本文の復元ルールを整理し、再取り込みで内容が変わらないことを保証する

## 受け入れ条件
- ハイライトのラベルを編集 → 注釈付きPDFをダウンロード → 再取り込みしてもラベルが保持される
- 既存PDFの取り込み（`origin='pdf'`）で、`Contents` が意図せず `label` に上書きされない

## 検証手順（手動）
- 選択→ハイライト追加→ラベル編集
- 注釈付きPDFをダウンロード
- そのPDFを再取り込みして、ラベル表示が変わっていないことを確認

