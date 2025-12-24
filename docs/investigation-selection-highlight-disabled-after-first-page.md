# 調査報告書: 2ページ目以降で「選択範囲をハイライト」が非活性になる

作成日: 2025-12-24  
対象: `pdf-viewer`（選択範囲ハイライト / コンテキストメニュー）

## 1. 事象
1ページ目では「選択範囲をハイライト」が利用できるが、2ページ目以降でテキストを選択してもコンテキストメニュー内の「選択範囲をハイライト」ボタンが非活性になり、ハイライトを追加できない。

## 2. 期待動作
任意ページでテキスト選択 → 右クリックのコンテキストメニューから「選択範囲をハイライト」をクリックでき、選択範囲にハイライトが追加される。

## 3. 直接原因（ボタンが非活性になる条件）
ボタン活性/非活性は `ViewerShellComponent.openContextMenuFromViewer()` が設定する `contextMenu.canHighlight` に依存する。

- 実装: `src/app/pages/viewer-shell/viewer-shell.component.ts`
- 判定式（要約）:
  - `selectionRects = collectSelectionRectsByPage(selection)`
  - `selectionContext = (selectionRects.length === 0) ? resolveSelectionContext(pageNumber) : null`
  - `canHighlight = flags.markers && (selectionRects.length > 0 || selectionContext != null)`

したがって、ボタンが非活性になるのは次の同時成立時。
- (A) `collectSelectionRectsByPage()` が空配列を返す
- (B) `resolveSelectionContext()` が `null` を返す

## 4. (A) `collectSelectionRectsByPage()` が空になる主な条件
`collectSelectionRectsByPage()` は selection の `range.getClientRects()` をページ単位にグルーピングして `HighlightRect[]` を返すが、以下の場合に空配列になる。

- selection が存在しない/折りたたまれている（`selection.isCollapsed` / `rangeCount===0`）
- `range.getClientRects()` が 0 件（幅/高さ 0 を除外後）
- **ページ候補（`.page` の DOMRect）を収集できない**
- **各 clientRect の中心点が、どのページ矩形にもヒットしない**

特に実装上重要なのは次の挙動。
- ページ候補の収集は `pageElementMap.size > 0` の場合、`pageElementMap` のみを使い、DOM 走査（`querySelectorAll('.page')`）にフォールバックしない。
- そのため `pageElementMap` が「1ページ目しか保持していない」状態だと、2ページ目以降の選択 rect をページに関連付けできず、`selectionRects=[]` になり得る。

## 5. (B) `resolveSelectionContext()` が `null` になる主な条件
`resolveSelectionContext()` は「選択が単一の `.textLayer` に収まっている」ことを前提に、選択のページ/テキストレイヤを特定する。

- 実装: `src/app/pages/viewer-shell/viewer-shell.component.ts`
  - `resolveSelectionContext()`
  - `resolveTextLayerFromSelection()`
  - `selectionMatchesLayer()`

`null` になる代表例:
- selection が `.textLayer` 外（例: 右サイドのテキスト、別レイヤの DOM）を含む
- selection が複数ページにまたがり、anchor/focus が別 `.textLayer` になる
- `resolveTextLayerFromSelection()` が失敗し、さらに `pageNumber` から `.textLayer` を引けない
  - `textLayerElementMap.get(pageNumber)` が無い
  - `pageElementMap.get(pageNumber)` が無い（または `.textLayer` を見つけられない）

## 6. 根本原因（確定）
`collectSelectionRectsByPage()` が `pageElementMap` を「1件でも入っていれば完全」とみなし、DOM 再走査での補完をしない設計になっている。

- `pageElementMap.size > 0` のとき、ページ候補は `pageElementMap` だけから作られる（DOM の `.page` を走査しない）
- そのため `pageElementMap` が「1ページ目だけ」など部分的な状態のままになると、2ページ目以降の選択 rect をページに関連付けできず、`selectionRects=[]` になり得る

結果として `openContextMenuFromViewer()` の `canHighlight` が `false`（= selectionRects 空 + selectionContext null）になり、ボタンが非活性化される。

`pageElementMap` が部分的になるトリガは複数あり得る（例: `syncDomRefs()` 実行時点で `.page` が全て DOM に揃っていない、スクロールコンテナの差で `pdf.js` のレンダリング/イベントが遅延する等）。ただし、いずれの場合でも上記の「補完なし」がボタン非活性化に直結する。

## 7. 確認方法（ログで切り分け）
ブラウザ DevTools で以下を確認すると、(A)/(B) のどこで落ちているか切り分けできる。

1) 2ページ目で選択→右クリックした直後に以下を確認
- `window.getSelection()?.isCollapsed` が `false` か
- `window.getSelection()?.anchorNode` / `focusNode` の `parentElement?.closest('.textLayer')` が取得できるか

2) `openContextMenuFromViewer()` に一時ログを入れて確認（例）
- `pageElementMap.size` / `textLayerElementMap.size`
- `collectSelectionRectsByPage(selection)` の戻り件数
- `resolveSelectionContext(pageNumber)` が `null` かどうか

3) DOM 側の確認
- `document.querySelectorAll('pdf-viewer .pdfViewer .page').length`（ページ要素の生成数）
- 2ページ目の `.page[data-page-number=\"2\"]` が存在するか、内部に `.textLayer` があるか

## 8. 修正方針（提案）
「map が未構築/不完全でも選択ハイライトを有効化」できるように、フォールバックを強化する。

- `collectSelectionRectsByPage()`:
  - `pageElementMap.size > 0` でも DOM 走査でページ候補を補完する、またはページヒットが 0 件なら DOM 走査へフォールバックする
- `resolveSelectionContext()`:
  - `pageElementMap.get(pageNumber)` が無い場合、DOM から該当ページ（`data-page-number`）を再探索して `.textLayer` を取得する
- UI/UX:
  - 複数ページ selection / レイヤ外 selection の場合は非活性にするだけでなく、非活性理由を表示（例: 「ページ内のテキストを選択してください」）

## 9. 結論
「非活性になる直接条件」は `canHighlight=false`（= selectionRects 空 + selectionContext null）。  
現象が「2ページ目以降で一貫」していることから、ページ/テキストレイヤの参照（`pageElementMap` / `textLayerElementMap`）が 1ページ目中心にしか構築されず、(A)(B) が同時に成立している可能性が高い。
