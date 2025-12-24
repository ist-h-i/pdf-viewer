# 機能一覧（pdf-viewer）

## 画面/ルーティング
- `/`（ビューア）: `ViewerShellComponent` が提供する単一画面

## UI 構成と機能
### 1) トップバー
- PDF ファイル選択（ローカルから読み込み）
- ズーム操作（- / + / リセット）
- オブジェクト表示切替（注釈レイヤーの表示 ON/OFF）
- PDF ダウンロード（読み込み済み PDF を保存）
- ステータス表示（ファイル名、ページ数、読み込み中、エラー）

### 2) ビューア領域
- PDF ページ表示（ページ単位で縦スクロール）
- 比較モード（左右分割表示）：比較元/比較対象 PDF を並列表示
- 比較差分ハイライト（ページ枠/テキスト差分）
- 右クリックのコンテキストメニュー
  - コメント追加（クリック位置に配置）
  - 選択テキストのハイライト追加
- ハイライト表示
  - 検索由来（例: 黄系）
  - 選択由来（例: ピンク系）
  - クリックでフォーカス、ドラッグで移動（選択由来のみ）
- コメント表示
  - ページ上に吹き出し/コールアウトとして表示
  - ドラッグで移動
  - 吹き出しの幅/高さ変更、ポインター位置調整

### 3) サイドパネル
- 全文検索
  - 検索入力、実行、クリア
  - ヒット一覧（ページ番号 + 周辺文脈、ページへのアンカーリンク）
- コメントカード一覧
  - 返信追加（スレッド形式）、削除
- OCR/テキスト抽出（擬似）
  - ページ指定、実行、結果表示（テキスト/処理時間）
- PDF 比較（テキストベース）
  - 比較対象 PDF の選択
  - 追加/削除ページ数、変更ページ一覧、メモ表示
  - 変更ページ一覧から該当ページへジャンプ（左右ビューアと連動）

## 主な内部コンポーネント/サービス
- `src/app/pages/viewer-shell/viewer-shell.component.*`
  - 画面統合、イベント処理（ファイル選択、ズーム、右クリック、ドラッグ、検索・比較・OCR の呼び出し）
  - テキストレイアウト取得（ハイライト矩形算出のための DOM/キャッシュ管理）
- `src/app/features/pdf/pdf-facade.service.ts`
  - PDF 読み込み、ページ情報生成、ズーム、ダウンロード
  - PDF.js を用いたページテキスト取得/テキストレイヤー描画
- `src/app/features/search/search-facade.service.ts`
  - ページ横断の全文検索、検索結果（`SearchHit`）管理
- `src/app/features/annotations/annotation-facade.service.ts`
  - ハイライト（`Marker`）とコメント（`CommentCard`）の追加/更新/削除、ページ別取得
- `src/app/features/ocr/ocr-facade.service.ts`
  - 擬似 OCR（PDF テキスト抽出結果を OCR として表示）
- `src/app/features/compare/compare-facade.service.ts`
  - PDF 同士のテキスト比較（ページ差分サマリ）
- `src/app/core/feature-flags.ts`
  - 機能フラグ（検索/マーカー/コメント/OCR/比較）の定義と DI トークン
- `src/app/core/models.ts`
  - 画面/機能で用いるデータモデル（Marker、CommentCard、SearchHit 等）
- `src/app/core/pdf-worker.ts`
  - PDF.js worker の参照パス定義

## 関連ドキュメント
- コメント: [comment-design.md](comment-design.md) / [comment-uiux-redesign.md](comment-uiux-redesign.md)
- ハイライト: [highlight-design.md](highlight-design.md) / [bug-report-selection-highlight-disabled.md](bug-report-selection-highlight-disabled.md)
- フォーカス/スクロール: [focus-scroll-design.md](focus-scroll-design.md)
