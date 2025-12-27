# Task 07: Phase 3（要件次第）作り直し判断と選択肢

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（Phase 3）
- `docs/design/highlight-design.md`（既知の制約: rects のみ保存）

## 目的
Phase 1〜2 の「止血・互換強化」では満たせない要件が出た場合に、再設計の判断と次の一手を決められる状態にする。

## Phase 1〜2 の限界（この時点でできない/やりにくい）
- ハイライトが **常にテキストに再追従**（ズーム/再描画/フォント差でもズレない）
- 取り込んだ PDF注釈を **編集して再保存**（Acrobat互換を維持）
- コメントの **スレッド/返信** をPDF注釈の返信構造へ相互変換

## 作り直し判断のトリガー（例）
- rects% ベースのままではズーム時のズレが許容できない
- PDF注釈の round-trip（編集→再保存）が必須になった
- Acrobat で作った注釈を本アプリで編集する要件が追加された

## 選択肢
### Option A: Marker を「テキストアンカー（offset）」ベースに拡張
概要:
- `Marker` に `start/end offset`（+page）を保存し、表示時に `PageTextLayout` から rects を再計算する。

メリット:
- ズーム/再描画での再追従が可能になる（textLayer が取れている前提）。

デメリット:
- フォント差・textLayer 生成差で offset がずれる可能性は残る（完全ではない）。
- 既存データ移行と、offset を持たない注釈（pdf由来等）の扱い設計が必要。

### Option B: PDF.js Annotation Editor を主軸に寄せる
概要:
- 注釈編集を PDF.js に寄せ、`saveDocument()` を基軸に PDF へ永続化する。

メリット:
- 出力互換を担保しやすい（/AP など PDF.js が生成する範囲に乗れる可能性）。

デメリット:
- `ng2-pdf-viewer` の制約（annotationEditorMode 無効化）を外す必要がある。
- `/Text`（付箋）の editor が不足する可能性がある（`/FreeText` 代替等の設計が必要）。

### Option C: pdf-lib を継続し、Appearance/メタ保持まで本格実装
メリット:
- UIは維持しつつ、注釈辞書/互換の自由度が高い。

デメリット:
- PDF仕様の低レベル実装になりがちで、検証コストが大きい。

### Option D: 商用SDK（PSPDFKit / Apryse 等）
メリット:
- 注釈互換・編集体験を短期で揃えられる可能性が高い。

デメリット:
- コスト/ライセンス/依存方針との整合が必要。

## このタスクのアウトプット（やるなら）
- Phase 3 の要件（必須/任意）を文章で確定
- Option の採用方針を決定（A/B/C/D）
- 選んだ Option の設計・移行計画を `docs/design/` に起こす（別タスク化）

