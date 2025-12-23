# 調査報告書: 右サイドの「ハイライト」リストに追加されない

作成日: 2025-12-23  
対象: `pdf-viewer`（右サイドパネルのハイライト一覧）

## 1. 事象
PDF 上でテキスト選択 → 右クリック → 「選択範囲をハイライト」を実行すると、PDF 上にはハイライトが表示されるが、画面右側の「ハイライト」リスト（件数/一覧）に反映されない。

## 2. 期待動作 / 実際の動作
- 期待動作: ハイライト追加後、右サイドのハイライト件数が増え、該当ページのセクション内に項目が追加される。
- 実際の動作: 件数が 0 のままで、一覧にも項目が追加されない（PDF 上のハイライト表示はされる）。

## 3. 影響範囲
- 右サイドの「ハイライト」パネル（一覧/件数/削除）に、ユーザーが追加した「選択範囲ハイライト」が表示されない。
- 一覧からの削除もできない（そもそも一覧に出ないため）。

## 4. 調査結果（原因）
### 4.1 ハイライトは 2 系統の状態を持っている
`docs/highlight-design.md` に記載の通り、本アプリの「ハイライト」は実装上 2 系統に分かれる。
- **選択範囲ハイライト（ユーザー操作）**: `.textLayer` の DOM を `span.text-highlight` でラップし、`ViewerShellComponent` 内の `textHighlights` に（page/start/end/color）を保持する方式。
- **検索結果ハイライト（自動）**: `Marker`（rects）を `AnnotationFacadeService` に保持し、`div.highlight` の矩形オーバーレイで描画する方式。

### 4.2 右サイドの「ハイライト」一覧は `Marker` を見ている
右サイドパネルの実装は、`AnnotationFacadeService.userMarkers()`（= selectionHighlights）を元にセクションを構築している。
- `highlightSections` は `this.annotations.userMarkers()` をグルーピングしている  
  - `src/app/pages/viewer-shell/viewer-shell.component.ts:206`
- 件数表示は `annotations.markerCount()`（= selectionHighlights の件数）  
  - `src/app/pages/viewer-shell/viewer-shell.component.html:411`
- つまり、この一覧は **Marker（selectionHighlights）に追加されたものだけ** を表示する。

### 4.3 「選択範囲をハイライト」は `Marker` を追加していない
コンテキストメニュー「選択範囲をハイライト」の実体は `addHighlightFromSelection()` であり、ここでは `AnnotationFacadeService.addMarker()` を呼ばず、`textHighlights` に追加して `.textLayer` DOM を直接ラップしている。
- `addHighlightFromSelection()`  
  - `src/app/pages/viewer-shell/viewer-shell.component.ts:789`
- `textHighlights`（選択範囲ハイライトの保管先）  
  - `src/app/pages/viewer-shell/viewer-shell.component.ts:240`
- `addTextHighlight()`（`textHighlights` への追加）  
  - `src/app/pages/viewer-shell/viewer-shell.component.ts:1393`

一方、右サイド一覧が見ている `userMarkers` は `AnnotationFacadeService.selectionHighlights` であり、ここには値が追加されない。
- `userMarkers = selectionHighlights.asReadonly()`  
  - `src/app/features/annotations/annotation-facade.service.ts:15`
- `addMarker()`（selectionHighlights を増やす入口）  
  - `src/app/features/annotations/annotation-facade.service.ts:21`

## 5. 結論（根本原因）
右サイドの「ハイライト」リストは **Marker（selectionHighlights）** を表示対象にしているが、ユーザーが追加する「選択範囲ハイライト」は **textHighlights（DOM ラップ方式）** に保存され、Marker としては追加されない。  
そのため、ハイライトを追加しても右サイド一覧に反映されない。

## 6. 対応方針案（修正案）
### 案 A: 右サイド一覧を `textHighlights` ベースにする（現行仕様に合わせる）
- 右サイドのデータソースを `AnnotationFacadeService` ではなく `ViewerShellComponent.textHighlights`（または Facade に移管した同等データ）に変更する。
- `TextHighlightRange` に一覧表示用の情報を追加する（例: `text?: string` / `createdAt?: number`）。
- 削除は `textHighlights` から range を除去し、該当ページの `.textLayer` を `applyStoredTextHighlights()` で再適用（＝一度 `clearTextHighlights()` してから再描画）する。
- メリット: 既存の「ズーム/再レンダリングに追従する」DOM ラップ方式を維持できる。
- デメリット: `ViewerShellComponent` のローカル状態に寄るため、一覧操作（削除/編集）を拡張するなら Facade への移管が望ましい。

### 案 B: 「選択範囲ハイライト」も `Marker` として保存する（方式統一）
- `addHighlightFromSelection()` のタイミングで、選択範囲の rects を算出して `AnnotationFacadeService.addMarker(..., source='selection')` を呼ぶ。
- 右サイド一覧は現状のまま使える。
- メリット: 一覧/削除/ドラッグ等の UI 拡張がしやすい。
- デメリット: 現在の選択範囲ハイライトは「文字に追従」する設計（offset 保存）なので、Marker（rect）方式へ統一すると再レンダリング/ズーム時の再計算設計が必要になる。

### 案 C: ハイブリッド（表示は DOM、メタ情報だけ Facade へ）
- ハイライト表示自体は `textHighlights` のまま維持しつつ、一覧に必要なメタ情報（id/page/color/text/start/end）だけを Facade に別シグナルで保持する。
- 一覧からの削除は「Facade のメタを削除」→「textHighlights も同期して削除」する。
- メリット: 表示方式を変えずに一覧 UI を実現できる。
- デメリット: 二重管理になり、同期不整合のケアが必要。

## 7. 推奨（次アクション）
短期で目的（右サイド一覧に追加・削除）を達成するなら **案 A** が最短。  
将来的に「ドラッグ移動」「図形ハイライト」「永続化」まで見据えるなら **案 B / C** を含め再設計が妥当。

