# Task 06: Acrobat 注釈取り込みの対応範囲を固めて実装する

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.5 / Phase 2）
- `docs/planning/highlight-quality-and-pdf-annotation-interop/task-00-requirements.md`

関連コード:
- `src/app/features/pdf/pdf-facade.service.ts`（`readPdfAnnotations()`）

## 目的
Acrobat で追加した注釈を本アプリで取り込んだ際に、欠落や崩れが起きないよう「対応する subtype と復元ルール」を決めて実装する。

## 前提
- 座標変換は `task-04` を前提にする（座標が合わない状態で subtype を増やしても品質が上がらない）。

## 対象範囲（`task-00` の決定に従う）
最低限（推奨）:
- `/Subtype /Highlight` → `Marker`（read-only, `origin='pdf'`）
- `/Subtype /Text` → `CommentCard`（read-only, `origin='pdf'`）

追加候補:
- `/Subtype /Popup`（Text のポップアップ。内容/タイトルの復元に使う可能性）
- Markup: `/Underline` `/Squiggly` `/StrikeOut`
- `/Subtype /FreeText`（ページ上文字）

## 方針（Phase 2）
### 1) subtype ごとのマッピングを明文化する
例（暫定案。確定は `task-00`）:
- Highlight系:
  - `/Highlight` は矩形化して `Marker` として描画
  - `/Underline` `/Squiggly` `/StrikeOut` は「取り込みはするが表示は highlight と同等（または別スタイル）」のどちらかを決める
- Text系:
  - `/Text` は `CommentCard` へ（anchor は rect の中心）
  - `/Popup` は親注釈と紐付け、`Contents` の優先順位を決める（Popup側に本文があるケースの吸収）
- FreeText:
  - 既存UIへどう落とすか（CommentCardで代替 / read-only でページ上に文字表示する 等）を決める

### 2) 取り込みの組み立てを「1パス→2パス」へ
`getAnnotations()` が返す配列の順序や id の持ち方次第で、親子（Text↔Popup）が混在しうる。
- 1パス: annotation を subtype/id/parentId（相当）で収集
- 2パス: ペアリングして最終的な Marker/Comment を生成

## 実装タスク（チェックリスト）
- [ ] `task-00` の決定に従い、対応 subtype 一覧をコードとドキュメントに反映する
- [x] `/Text` + `/Popup` の関係を考慮して import できるようにする（可能な範囲で）
- [ ] Markup subtype（Underline等）を追加する場合は、UI上の表現を決めてから実装する
- [x] 取り込み注釈は `origin='pdf'` として read-only を維持する（Phase 2 のスコープ）

## 受け入れ条件
- Acrobat で追加した注釈を取り込んでも、少なくとも `/Highlight` と `/Text` が欠落せず、位置と内容が破綻しない
- 対応外 subtype は「無視」か「限定対応」かが仕様として明確

