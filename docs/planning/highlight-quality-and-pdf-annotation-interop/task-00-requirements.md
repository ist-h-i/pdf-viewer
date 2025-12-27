# Task 00: 要件確定（互換の定義・対象範囲）

参照:

- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`
- `docs/investigations/pdf-annotation-investigation.md`
- `docs/design/highlight-design.md`

## 目的

Phase 1〜2 の実装ブレを防ぐために、互換のゴールと対応範囲を先に合意する。

## 決めること（アウトプット）

### 1) Acrobat互換の定義

- ゴールはどこまでか？
  - A. **表示できる**（Acrobat/Preview/Chrome で見える）
  - B. **編集して再保存できる**（Acrobat互換を維持したまま round-trip）

Phase 2 の現実解:

- まずは **A（表示できる＋本アプリ再取り込みで崩れない）** をゴールにする。

### 2) 対象ビューア（検証優先順位）

最低限の対象:

- Adobe Acrobat Reader（最優先）
- Chrome / Edge

不要:

- Acrobat Pro（編集検証が必要な場合）
- macOS Preview

### 3) 取り込み対象注釈（Import）

どこまで対応するかを確定する（Phase 2 のスコープ）。

推奨（最小）:

- Markup: `/Highlight`
- Comment: `/Text`

不要:

- Markup: `/Underline` `/Squiggly` `/StrikeOut`（表示互換のため）
- Popup: `/Popup`（`/Text` とペアの可能性）
- `/FreeText`（ページ上文字。現UIへどう落とすか要設計）

### 4) コメントの型（Export）

- `/Text`（付箋）: 必須
- `/FreeText`: 不要

推奨:

- 既存UIが「付箋 + 吹き出し」なので、まずは `/Text` を継続。

### 5) ラベルと選択文字列の扱い（Export/Import）

現状の不具合: `contents = marker.text || marker.label` により、ラベル編集が再取り込みで崩れる。

方針:

- `Contents`: **ユーザー編集ラベル**（`Marker.label`）
- `Subject`（または別フィールド）: **選択文字列（プレビュー）**（`Marker.text`）
- ラベルのみが要件なら、選択文字列は PDF に保存しない（互換性リスク低減）

## 受け入れ条件（このタスクの完了条件）

- Phase 1〜2 の「Done」が文章で確定している（上の 1)〜5) が埋まっている）
- 対象ビューア/対象注釈の優先順位が決まっている
- `Contents/Subject` 等のマッピング方針が決まっている
