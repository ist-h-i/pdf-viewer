# 不具合調査報告: 選択範囲ハイライトボタンが非活性になる

## 不具合内容

- 操作: PDF 上のテキストをドラッグ選択 → 右クリック → コンテキストメニュー表示
- 期待: 「選択範囲をハイライト」が活性でクリックでき、ハイライトが追加される
- 実際: 選択範囲があるのにボタンが非活性でクリックできない

## 不具合原因

- `openContextMenuFromViewer()` は `resolveSelectionContext()` の結果だけで
  `contextMenu.canHighlight` を決定している。
- `resolveSelectionContext()` は `resolveTextLayerFromSelection()` と
  `selectionMatchesLayer()` で、selection が **単一の `.textLayer` 内** に収まっている場合のみ
  「有効」と判定する。
- そのため、選択範囲が存在しても以下のケースでは `canHighlight=false` となり、
  ボタンが無効化される。
  - 選択がページをまたいでいる（複数 `.textLayer` にまたがる）
  - selection が `.textLayer` 外のノードを含む

## 修正方針

- 選択範囲のページ判定は selection から行う（`resolveSelectionContext()`）。右クリック位置は判定に影響させない。
- 複数ページにまたがる selection は、ページごとに rect を分割して
  `AnnotationFacadeService.addMarker()` をページ単位で追加できるようにする。
- もし複数ページ対応を行わない場合は、無効化の理由を UI に明示し、
  単一ページでの選択を促す。
