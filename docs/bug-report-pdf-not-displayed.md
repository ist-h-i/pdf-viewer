# 不具合内容報告書: PDFビューアーにPDFが表示されない

## 1. 現象
- PDFファイルを読み込むと、ページ数表示やテキスト検索は機能するが、ビューアー領域にPDFのページ（キャンバス）が表示されないように見える。

## 2. 再現手順
1. アプリを起動する（例: `npm start`）。
2. ファイルピッカーからPDFを選択する。
3. ページ数が表示される/検索が動くことを確認する。
4. 一方で、PDFのページが表示されない（空の表示になる）。

## 3. 期待結果
- 読み込んだPDFがページとして表示され、スクロールで閲覧できる。

## 4. 影響範囲
- PDF表示（`ng2-pdf-viewer`）が空になる。
- 同じバイト列を使う機能（PDFダウンロード、比較表示）も、内部的には「0バイト相当」になる可能性がある。

## 5. 原因
### 結論
`pdfjs-dist` の `getDocument({ data })` が `data.buffer` を Worker へ Transfer するため、呼び出し元が保持している `ArrayBuffer` が **detach（byteLength=0）** され、ビューアーへ渡すPDFバイト列が空になっていた。

### 詳細
- 本アプリは `PdfFacadeService` でPDFを読み込み、同一の `ArrayBuffer` から
  - `pdfjs-dist` で `getDocument({ data })` を実行（PDF解析/検索用）
  - `ng2-pdf-viewer` の `[src]` として `Uint8Array` を渡す（表示用）
  - ダウンロード用に `Blob([ArrayBuffer])` を生成（保存用）
  を行っていた。
- `pdfjs-dist` 側はWorkerへ `data.buffer` を Transfer する実装になっており、呼び出し元の `ArrayBuffer` は detach される。
- その結果、同じ `ArrayBuffer` を参照していた `Uint8Array`（表示用）が空になり、`ng2-pdf-viewer` が空データを読み込んで表示できなかった。
- 同様の実装が `CompareFacadeService` にもあり、比較対象PDFの表示でも同じ問題が発生しうる状態だった。

## 6. 解決方法
### 方針
Workerへ渡す `data` は **コピー** にし、表示/ダウンロード用には **detachされない元バッファ** を保持する。

### 対応内容
- `src/app/features/pdf/pdf-facade.service.ts`
  - 表示/ダウンロード用に `buffer.slice(0)` で安定コピーを保持し、`getDocument({ data })` には元バッファを渡す（Transferで元バッファがdetachされても影響しない）。
- `src/app/features/compare/compare-facade.service.ts`
  - 比較表示用に同様の安定コピーを保持し、`getDocument({ data })` には元バッファを渡す。

## 7. 確認方法
- ビルド: `npm run build`
- 手動確認（ブラウザ）:
  - PDFを読み込むとページが表示されること
  - テキスト検索が引き続き動作すること
  - PDFダウンロードが0バイトにならないこと
  - （比較機能を使う場合）比較対象PDFも表示されること

## 8. 再発防止
- `pdfjs-dist` に `data` を渡す場合、**同じ `ArrayBuffer` をアプリ側で使い回さない**（Transferによりdetachされるため）。
- 共有したい場合は `buffer.slice(0)` / `new Uint8Array([...])` 等でコピーを明示し、「どちらをWorkerに渡すか」を設計として固定する。
