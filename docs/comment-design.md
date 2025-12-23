# コメント機能 仕様・設計（外部開発者向け）

対象: `pdf-viewer`（FR-07 コメント）  
主な実装: `src/app/pages/viewer-shell/viewer-shell.component.*`, `src/app/features/annotations/annotation-facade.service.ts`, `src/app/core/models.ts`

関連: [comment-uiux-redesign.md](comment-uiux-redesign.md)

## 1. 概要（何を提供するか）
本アプリの「コメント」は、PDF ページ上の任意位置に **アンカー（点）** と **吹き出し（バブル）** を配置し、吹き出し内に **スレッド（時系列のメッセージ列）** を残す注釈機能です。

- 追加: ページ上で右クリック → コンテキストメニューから追加
- 表示: ページ上にアンカー＋吹き出し＋コールアウト線を重畳表示
- 操作: 選択、移動（アンカー/吹き出し）、サイズ変更、タイトル編集、返信追加、削除
- 一覧: 右サイドパネルで **ページ別セクション** として高密度に一覧表示

非ゴール（現状）:
- 永続化（保存/読込）、共有、権限、監査ログ
- 未読/通知/メンション、解決ステータス、検索/フィルタ

## 2. ユーザー仕様（UI/UX）

### 2.1 追加（右クリック → コメントを追加）
1. ページ上で右クリックするとコンテキストメニューが開く。
2. 「コメントを追加」を押すと、クリック位置をアンカーとして `CommentCard` を生成する。
3. 生成したコメントは選択状態になり、吹き出し内の返信テキストエリアにフォーカスする。

### 2.2 返信（吹き出し内）
- 吹き出し内にスレッド（過去メッセージ一覧）を表示する。
- 選択中のコメントのみ、吹き出し下段に「返信入力（textarea）＋送信」エリアを表示する（大量コメント時の DOM 負荷対策）。
- 送信トリガー:
  - 送信ボタン
  - `Ctrl+Enter` / `Cmd+Enter`
- 送信後:
  - 下書きをクリア
  - スレッド末尾まで自動スクロール
- placeholder:
  - 初回（messages が空）: 「コメントを追加」
  - 返信: 「返信を記入」

### 2.3 タイトル編集
- 吹き出しヘッダの編集ボタンでタイトル編集モードに入る。
- タイトルは `Enter` / blur で確定し、`Esc` でキャンセルする。
- 空文字の確定は許容せず、キャンセル扱い（タイトルは既存値を維持）とする。

### 2.4 移動（ドラッグ）
- アンカー（点）をドラッグすると、アンカー座標を移動する（ページ内にクランプ）。
- 吹き出しヘッダをドラッグすると、吹き出し座標を移動する。
  - 吹き出しはページ領域外（余白）にも逃がせる設計（`bubbleX/bubbleY` は 0..1 を超え得る）。
  - クランプ範囲はページ要素ではなく、ページ群コンテナ（`.pages`）の表示領域から算出する。

### 2.5 サイズ変更（リサイズ）
- 吹き出しのハンドル（右/下/右下）でリサイズできる。
- サイズは px 単位で保持し、最小/最大でクランプする。

### 2.6 一覧（右サイドパネル）
右サイドは「一覧に徹する」設計で、コメント数が多いケース（100+）でも走査しやすいようにします。

- ページ別にセクション化（`p{page}` + 件数）
- 各コメント行は「削除ボタン + タイトル」だけを表示（コメント単位のページ番号は表示しない）
- 行クリックでそのコメントを選択し、該当ページへスクロール
- タイトルは 1 行省略（ellipsis）し、`title` 属性で全文を確認可能

## 3. データモデル（永続化を前提にした形）
型定義: `src/app/core/models.ts`

### 3.1 CommentMessage
`CommentMessage` はスレッドの 1 発言です。

- `id`: 識別子（UUID 生成）
- `text`: 本文（UI は Angular の interpolation のため HTML はエスケープされる）
- `createdAt`: epoch ms

### 3.2 CommentCard
`CommentCard` は 1 コメント（吹き出し単位）です。

- `id`: 識別子（UUID 生成）
- `title`: 一覧向けの見出し
- `page`: 1 始まりのページ番号
- `anchorX/anchorY`: アンカー位置（ページ座標の正規化 0..1）
- `bubbleX/bubbleY`: 吹き出し中心位置（ページ座標の正規化だが、ドラッグにより 0..1 を超え得る）
- `messages`: `CommentMessage[]`（空配列なら「未入力」扱い）
- `createdAt`: 作成時刻（初回メッセージがあればその時刻、なければ生成時刻）
- `bubbleWidth/bubbleHeight`: 吹き出しサイズ（px、任意）。未設定時は UI 側のデフォルトを使う。

## 4. アーキテクチャ（責務分割）

### 4.1 状態管理: AnnotationFacadeService（インメモリ）
実装: `src/app/features/annotations/annotation-facade.service.ts`

`AnnotationFacadeService` はコメントの唯一のデータソース（in-memory）です。Angular signals を使い immutable update します。

- 読み取り:
  - `allComments`（signal read-only）
  - `commentCount`（computed）
  - `commentsByPage(page)`
- 主要操作:
  - `addComment(page, x, y, text?)`
  - `addReply(commentId, text)`
  - `updateComment(commentId, text)`（最後のメッセージ更新 / メッセージが無ければ初回として追加）
  - `updateCommentTitle(commentId, title)`
  - `updateCommentLayout(commentId, { bubbleWidth?, bubbleHeight? })`
  - `moveCommentAnchor(commentId, anchorX, anchorY)`
  - `moveCommentBubble(commentId, bubbleX, bubbleY)`
  - `removeComment(commentId)`
  - `reset()`

### 4.2 表示・操作: ViewerShellComponent
実装: `src/app/pages/viewer-shell/viewer-shell.component.ts` / `.html` / `.scss`

#### レイヤリング
- `ng2-pdf-viewer` が PDF ページを描画
- 同じ `.page` 要素内に、コメント（アンカー/線/吹き出し）を **absolute** で重畳

#### 座標系
- ページ要素の `getBoundingClientRect()` を基準に、イベント座標を 0..1 へ正規化して保持
  - `normalizeCoordinates(event, pageElement)` が責務
- CSS では `%` で配置し、ズームやリサイズでも破綻しにくくする

#### コールアウト線
吹き出し矩形とアンカー点から、線の「長さ」と「角度」を算出し、CSS 変数で描画します。

- 計算: `calloutLayout(comment)`（吹き出し内にアンカーが入った場合は最短辺にスナップ）
- 描画: `.comment-line { width: var(--line-length); transform: rotate(var(--line-angle)); ... }`

#### 選択と表示最適化
- 選択状態: `selectedCommentId`（signal）
- 返信入力エリアは **選択中のみ描画**（大量コメント時の DOM/レイアウトコストを抑制）
- 一覧は `commentSections`（computed）でページ別にグルーピングし、`trackBy`（`trackCommentSection` / `trackComment`）で差分更新を最小化

#### ドラッグ/リサイズ
- `pointerdown` で `dragState` をセットし、`window` に `pointermove/up/cancel` を購読して追従
- アンカー移動は 0..1 にクランプ
- 吹き出し移動は表示領域（`.pages`）から算出した範囲にクランプ（ページ外への退避を許容）
- リサイズは px でクランプし、`AnnotationFacadeService.updateCommentLayout()` に反映

## 5. フィーチャーフラグ
`FEATURE_FLAGS`（DI）によりコメント機能は `flags.comments` でガードされます。無効時は UI 操作も早期 return します。

## 6. 既知の制約と拡張ポイント

### 6.1 永続化（外部連携）
現状はリロード/ファイル再選択で state がリセットされます（`ViewerShellComponent.resetFeatureStates()`）。

永続化する場合の指針:
- `CommentCard`/`CommentMessage` はそのまま JSON 化可能（数値は小数を含む）。
- `bubbleX/bubbleY` が 0..1 を超え得る点（ページ外配置）を前提に UI を設計する。
- 保存先（localStorage/IndexedDB/サーバ）とライフサイクル（PDF との紐付け）を先に決める。

### 6.2 大量コメント
現状の「返信エリアは選択中のみ」＋「ページ別一覧」でも、さらに重くなる場合は以下が候補です。
- 一覧の仮想スクロール（Angular CDK `cdk-virtual-scroll-viewport`）
- 非選択コメントの吹き出しを簡略表示（アンカーのみ等）
