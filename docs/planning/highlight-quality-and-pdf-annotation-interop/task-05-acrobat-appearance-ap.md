# Task 05: Acrobat で見えない場合の /AP（Appearance）対応方針

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.3 / Phase 2-2）

関連コード:
- `src/app/features/pdf/pdf-facade.service.ts`（`buildAnnotatedPdfBytes()`）

## 目的
座標変換（`task-04`）を修正しても Acrobat で注釈が見えない/期待通りに描画されない場合に、追加で打てる手を整理して実装判断できる状態にする。

## 前提
- まず `task-04-viewport-coordinate-conversion.md` を完了してから判断する（座標ズレと /AP 不足が混在しうるため）。

## 想定される原因
- Acrobat は注釈辞書に /AP が無い/不十分だと描画しない（または不安定）ケースがある。
- 現状の export は注釈辞書（/Highlight, /Text）を追加しているが、/AP を生成していない。

## 対応オプション（優先順）
### Option 1: まずは検証を厚くする（実装最小）
- Acrobat Reader / Preview / Chrome での表示差を確認（どこで見えないか）
- `Rect` / `QuadPoints` / `C` / `CA` / `F` / `Contents` / `NM` 等が期待値になっているかを確認

### Option 2: pdf-lib で最小の /AP を生成する（工数: 中〜大）
検討ポイント:
- Highlight の appearance stream を自前生成（透明度・色・塗りつぶし）
- /Text はアイコン表示をどうするか（標準名 `Name` だけで表示されるか、/AP が要るか）

リスク:
- PDF仕様の低レベル実装になりやすく、互換/品質の検証コストが高い。

### Option 3: PDF.js の `saveDocument()` 系へ寄せる（工数: 中〜大、影響範囲大）
アイデア:
- PDF.js 側が生成する注釈（AnnotationEditor/annotationStorage）に乗せられるなら、/AP を含む保存に寄せられる可能性がある。
注意:
- 現状は `ng2-pdf-viewer` が Annotation Editor を無効化している（`docs/investigations/pdf-annotation-investigation.md` 参照）。

## 実装タスク（チェックリスト）
- [ ] `task-04` 完了後、Acrobat で「見える/見えない」を再現できるPDFケースを確保する
- [ ] そのケースで、Option 1 の確認を行い、座標・辞書内容が妥当かを切り分ける
- [ ] まだ不可なら、Option 2 か Option 3 の採用方針を決める（`task-00` の互換定義に合わせる）

## 受け入れ条件
- 「/AP を実装するか否か」を判断できる材料（再現PDF・確認結果・採用方針）が揃っている
- （実装に進む場合）/AP 実装タスクが別チケットとして切り出されている

