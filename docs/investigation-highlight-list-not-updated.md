# 調査報告書: 右サイドの「ハイライト」リストに追加されない（解消済み）

作成日: 2025-12-23  
対象: `pdf-viewer`（右サイドパネルのハイライト一覧）

## 1. 事象（旧仕様）
PDF 上でテキスト選択 → 右クリック → 「選択範囲をハイライト」を実行すると、PDF 上にはハイライトが表示されるが、画面右側の「ハイライト」リスト（件数/一覧）に反映されない。

## 2. 期待動作 / 実際の動作（旧仕様）
- 期待動作: ハイライト追加後、右サイドのハイライト件数が増え、該当ページのセクション内に項目が追加される。
- 実際の動作: 件数が 0 のままで、一覧にも項目が追加されない（PDF 上のハイライト表示はされる）。

## 3. 影響範囲（旧仕様）
- 右サイドの「ハイライト」パネル（一覧/件数/削除）に、ユーザーが追加した「選択範囲ハイライト」が表示されない。
- 一覧からの削除もできない（そもそも一覧に出ないため）。

## 4. 調査結果（旧仕様）
### 4.1 ハイライトが 2 系統に分かれていた
`docs/highlight-design.md` に記載の通り、旧実装ではハイライトが 2 系統に分かれていた。
- **選択範囲ハイライト（ユーザー操作）**: `.textLayer` の DOM を `span.text-highlight` でラップし、`ViewerShellComponent` 内の `textHighlights` に（page/start/end/color）を保持する方式。
- **検索結果ハイライト（自動）**: `Marker`（rects）を `AnnotationFacadeService` に保持し、`div.highlight` の矩形オーバーレイで描画する方式。

### 4.2 右サイドの「ハイライト」一覧は `Marker` を参照
右サイドパネルの実装は、`AnnotationFacadeService.userMarkers()`（= selectionHighlights + importedMarkers）を元にセクションを構築している。
- `highlightSections` は `this.annotations.userMarkers()` をグルーピングしている  
  - `src/app/pages/viewer-shell/viewer-shell.component.ts`
- 件数表示は `annotations.markerCount()`（= selectionHighlights + importedMarkers の件数）  
  - `src/app/pages/viewer-shell/viewer-shell.component.html`
- つまり、この一覧は **Marker（selectionHighlights / importedMarkers）に追加されたものだけ** を表示する。

### 4.3 「選択範囲をハイライト」は `Marker` を追加していなかった
旧実装では `addHighlightFromSelection()` が `AnnotationFacadeService.addMarker()` を呼ばず、`textHighlights` で DOM を直接ラップしていたため、一覧に反映されなかった。

## 5. 対応内容（現行仕様）
- 選択範囲ハイライトは `AnnotationFacadeService.addMarker(..., source='selection')` で保存する方式に統一
- DOM ラップ方式（`textHighlights` / `span.text-highlight`）は廃止
- 一覧は `userMarkers` を参照するため、追加直後に件数/一覧が反映される
- 検索ハイライトは `searchHighlights` で管理し、一覧には含めない

## 6. 結論
旧原因だった「DOM ラップ方式と Marker 方式の二重管理」は解消済み。  
現在は選択範囲ハイライトが `Marker` として登録されるため、右サイド一覧に正しく反映される。
