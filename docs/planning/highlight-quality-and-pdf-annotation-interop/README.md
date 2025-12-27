# ロードマップ: ハイライト精度 / ズーム追従 / PDF注釈（Adobe互換）

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`
- `docs/design/highlight-design.md`
- `docs/investigations/pdf-annotation-investigation.md`

## 解決したい問題（ユーザーフィードバック）
- 選択ハイライトが「太い/大きすぎる」（選択範囲を大幅に超える）
- ズーム時にハイライトが追従せず「小さすぎる/ズレる」
- 注釈付きPDFの出力が Adobe Reader/Acrobat と互換にならない
- ダウンロード→再取り込みでラベル表示文字が変わる
- Acrobat で追加した注釈の取り込み表示が崩れる

## ゴール（Phase 1〜2 のスコープ）
- UI: 選択ハイライトが選択範囲を大幅に超えない
- UI: ズーム（0.5〜3.0）でハイライトの位置/サイズが破綻しない
- ラベル: ダウンロード→再取り込みでラベルが保持される
- PDF: アプリ出力PDFを Adobe Reader で開くとハイライト/コメントが表示される
- PDF: Acrobat で追加した `/Highlight` と `/Text` を取り込んでも位置と内容が破綻しない

## 非ゴール（Phase 1〜2 ではやらない）
- 取り込んだPDF注釈を編集して再保存（Acrobat互換を維持したまま）
- ハイライトが常にテキストへ再追従（フォント/再描画差でもズレない）
- コメントのスレッド/返信をPDF注釈（IRT等）へ完全マッピング

## 進め方（フェーズ）
- Phase 0: 要件確定（互換の定義、対象ビューア、取り込み対象注釈）: `task-00-requirements.md`
- Phase 1（短期）: **既存データモデル（rects%）のまま止血**: `task-01..03`
- Phase 2（中期）: **Acrobat互換の入出力を固める**: `task-04..06`
- Phase 3（要件次第）: 再設計（作り直し判断）: `task-07-phase3-rebuild-options.md`

## タスク一覧（推奨順）
1. `task-00-requirements.md`（先に合意が必要）
2. `task-03-label-roundtrip.md`（確定原因・低リスクで効果大）
3. `task-01-selection-highlight-rects.md`（過大ハイライトの止血）
4. `task-02-overlay-coordinate-basis.md`（ズーム追従の止血）
5. `task-04-viewport-coordinate-conversion.md`（座標変換の根本修正）
6. `task-06-import-annotation-coverage.md`（Acrobat注釈の取り込み範囲を決めて対応）
7. `task-05-acrobat-appearance-ap.md`（座標修正後にまだ見えない場合のみ）
8. `task-07-phase3-rebuild-options.md`（必要なら）

## 検証マトリクス（最低限）
ビューア（優先順は `task-00` で確定）:
- Adobe Acrobat Reader（Windows）
- Chrome / Edge（PDF内蔵）
- macOS Preview（可能なら）

PDFケース:
- 通常（回転なし・CropBoxなし）
- `/Rotate` あり
- CropBox（MediaBoxと原点が異なる）あり
- 文字密度が高いページ（ハイライト過大/不足が目立つ）

操作:
- 選択→ハイライト追加（単一ページ / 可能なら複数ページ）
- ズーム（0.5 / 1.0 / 2.0 / 3.0）で確認
- 注釈付きダウンロード→外部ビューアで表示
- Acrobatで注釈追加→本アプリで取り込み表示

