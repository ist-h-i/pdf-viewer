# Task 02: 基準矩形（%化/overlay）を統一（ズーム追従の止血）

参照:
- `docs/investigations/investigation-highlight-quality-and-pdf-annotation-interop.md`（3.2）
- `docs/design/highlight-design.md`（既知の制約）

関連コード:
- `src/app/pages/viewer-shell/viewer-shell.component.ts`
  - `resolvePageContentRect()`
  - `buildPageOverlays()`
  - `syncTextLayerScale()`
  - `syncDomRefs()`（呼ばれ方/タイミング）

## 目的
ズーム/リサイズ時に、ハイライトが「小さすぎる」「ズレる」問題を、現行データモデル（rects%）のまま抑える。

## 背景（原因仮説）
- textLayer は `syncTextLayerScale()` で canvas の表示実寸に追従する一方、overlay は `resolvePageContentRect(pageElement)` を基準に %→px 変換している。
- canvas が CSS（`max-width` 等）でリサイズされると、page 要素の client box と canvas の実表示サイズが一致しない可能性がある。
- `syncDomRefs()` による `pageOverlays` 再計算が、ズーム直後の描画確定前に走ると、古い矩形で固定されうる。

## 方針（Phase 1）
### 1) “基準矩形” を canvas 基準に寄せる
`resolvePageContentRect()` の算出元を **page要素ではなく canvas の表示実寸**に寄せ、以下で同じ基準を使う:
- `normalizeRect()`（DOMRect→%）
- `captureTextLayoutFromDom()`（textLayer rects の %化）
- `buildPageOverlays()`（overlay の px 位置・サイズ）

### 2) ズーム/リサイズ後の overlay 再計算を確実にする
既存の `syncDomRefs()` 呼び出し箇所を洗い出し、ズーム・再レンダリングが完了したタイミングで再計算が走るようにする。

## 実装タスク（チェックリスト）
- [x] `resolvePageContentRect()` を「canvas の `getBoundingClientRect()`」を優先する形に変更する（canvas が無い場合は現状フォールバック）
- [x] `buildPageOverlays()` の overlay サイズが、canvas の表示サイズと一致することを確認する
- [x] `captureTextLayoutFromDom()` の `%正規化` が overlay と同じ基準になることを確認する
- [x] `syncDomRefs()` の呼び出しタイミングを点検し、ズーム/再レンダリング後に必ず最新化されるようにする
  - 例: レンダリング完了イベント、`requestAnimationFrame`、`ResizeObserver` 等の追加検討

## 受け入れ条件
- ズーム（0.5 / 1.0 / 2.0 / 3.0）で、同一ハイライトの位置/サイズが破綻しない
- ズーム後に「ハイライトが小さすぎる」症状が目立って減る

## 検証手順（手動）
- 選択ハイライトを追加
- ズームを複数段階で切り替え、ハイライトがテキストから大きく外れないことを確認
- ブラウザのウィンドウ幅を変え、canvas が `max-width` で縮む状況で破綻しないことを確認

