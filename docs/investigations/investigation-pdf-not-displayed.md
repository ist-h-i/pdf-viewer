# 調査報告書: PDFが表示されない（pdf.js の ArrayBuffer detach）

作成日: 2025-12-24  
対象: `pdf-viewer`（Angular / `ng2-pdf-viewer` / `pdfjs-dist@4.8.69`）

## 1. 事象
PDFファイルを読み込むと、ページ数表示やテキスト検索は機能する一方で、ビューアー領域に PDF のページ（canvas）が表示されない（空の表示になる）。

## 2. 再現手順
1. アプリを起動する（例: `npm start`）。
2. ファイルピッカーから PDF を選択する。
3. ページ数が表示される/検索が動くことを確認する。
4. 一方で、ビューアー領域が空のままになる。

## 3. 原因（確定）
`pdfjs-dist` の `getDocument({ data: ArrayBuffer })` は、内部で Worker へ `data` を **Transfer** する実装になっている。  
このため、呼び出し元が保持している `ArrayBuffer` は **detach（`byteLength=0`）** され、以降そのバッファからバイト列を取り出せなくなる。

その結果、次のような実装だと「PDF解析は成功するが、表示用データが 0 バイトになる」状態が発生する。

- PDF解析/検索用: `pdfjs.getDocument({ data: buffer })`（ここで `buffer` が detach）
- 表示用: `URL.createObjectURL(new Blob([buffer]))` を **detach 後**に生成（= 0 バイト Blob）
  - または表示用に `Uint8Array(buffer)` など **同じバッファを参照**している場合も同様に空になる

## 4. 根拠（最小再現）
Node（`pdfjs-dist@4.8.69`）上で `ArrayBuffer` が detach されることを確認できる。

```js
const pdfjs = require('pdfjs-dist');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();

  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  console.log('before getDocument:', buffer.byteLength);
  await pdfjs.getDocument({ data: buffer }).promise;
  console.log('after getDocument:', buffer.byteLength); // => 0
})();
```

## 5. 影響範囲
- PDF表示（`ng2-pdf-viewer`）が空になる
- 同じバイト列を使う機能（PDFダウンロード、比較表示など）も 0 バイト化する可能性がある

## 6. 回避策 / 修正方針
`getDocument()` に渡す `data` と、表示/保存に使うバイト列を **同じ `ArrayBuffer` にしない**。

代表的な対応は次のいずれか。

1) **表示/保存用の安定コピーを先に作る**（推奨）

```ts
const buffer = await file.arrayBuffer();
const stable = buffer.slice(0); // 表示/保存用
await pdfjs.getDocument({ data: buffer }).promise; // bufferはdetachされ得る
const url = URL.createObjectURL(new Blob([stable], { type: 'application/pdf' }));
```

2) **`getDocument()` 側にコピーを渡す**

```ts
const buffer = await file.arrayBuffer(); // 表示/保存用
await pdfjs.getDocument({ data: buffer.slice(0) }).promise; // 解析用（detachされてもよい）
const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
```

## 7. 参考実装（本リポジトリ）
- `src/app/features/pdf/pdf-facade.service.ts` の `loadFile()` は、`buffer.slice(0)` を表示/保存用に保持し、`getDocument({ data: buffer })` に元バッファを渡す。
- `src/app/features/compare/compare-facade.service.ts` の `compareWith()` も同様。

## 8. 確認観点
- PDF読込後にページが表示されること
- テキスト検索が引き続き動作すること
- ダウンロードしたPDFが 0 バイトにならないこと
- （比較機能を使う場合）比較対象PDFも表示されること

