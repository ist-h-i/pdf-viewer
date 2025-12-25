import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  PLATFORM_ID,
  QueryList,
  ViewChild,
  ViewChildren,
  computed,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GlobalWorkerOptions, version as pdfJsVersion } from 'pdfjs-dist';
import { Subscription } from 'rxjs';
import { FEATURE_FLAGS, FeatureFlags } from '../../core/feature-flags';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';
import {
  CommentCard,
  CommentMessage,
  HighlightRect,
  Marker,
  OcrResult,
  OcrScope,
  PageTextLayout,
  SearchHit,
  PdfAnnotationExport,
  PdfHighlightAnnotation,
  TextSpanRects
} from '../../core/models';
import { PdfFacadeService } from '../../features/pdf/pdf-facade.service';
import { SearchFacadeService } from '../../features/search/search-facade.service';
import { AnnotationFacadeService } from '../../features/annotations/annotation-facade.service';
import { OcrFacadeService } from '../../features/ocr/ocr-facade.service';
import { CompareFacadeService } from '../../features/compare/compare-facade.service';

type ContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  pageNumber: number | null;
  selectionPageNumber: number | null;
  selectionRects: PageSelectionRects[];
  canHighlight: boolean;
  selectionText: string;
  clickOffset: { x: number; y: number } | null;
  selectionOffsets: { start: number; end: number } | null;
};

type PageSelectionRects = {
  pageNumber: number;
  rects: HighlightRect[];
};

type SelectionContext = {
  selection: Selection;
  pageNumber: number;
};

type OffsetRange = {
  start: number;
  end: number;
};

type TextToken = {
  value: string;
  start: number;
  end: number;
};

type DiffRanges = {
  base: OffsetRange[];
  target: OffsetRange[];
};

type CommentCalloutLayout = {
  lineLength: number;
  lineAngle: number;
};

type CommentLayoutSettings = {
  bubbleWidth: number;
  bubbleHeight: number;
};

type CommentSection = {
  page: number;
  comments: CommentCard[];
};

type PageOverlay = {
  pageNumber: number;
  width: number;
  height: number;
  left: number;
  top: number;
};

type HighlightSection = {
  page: number;
  highlights: Marker[];
};

type CommentResizeAxis = 'bubbleWidth' | 'bubbleHeight' | 'bubbleBoth';

type CommentResizeState = {
  type: 'comment-resize';
  id: string;
  axis: CommentResizeAxis;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
};

type HighlightSwatch = {
  id: string;
  label: string;
  color: string;
};

const HIGHLIGHT_SWATCHES: HighlightSwatch[] = [
  { id: 'pink', label: 'ピンク', color: 'var(--color-highlight-pink)' },
  { id: 'yellow', label: 'イエロー', color: 'var(--color-highlight-yellow)' },
  { id: 'green', label: 'グリーン', color: 'var(--color-highlight-green)' },
  { id: 'blue', label: 'ブルー', color: 'var(--color-highlight-blue)' },
  { id: 'orange', label: 'オレンジ', color: 'var(--color-highlight-orange)' }
];

type DragState =
  | {
      type: 'comment-bubble';
      id: string;
      page: number;
      offsetX: number;
      offsetY: number;
    }
  | {
      type: 'comment-anchor';
      id: string;
      page: number;
      offsetX: number;
      offsetY: number;
    }
  | {
      type: 'marker-pending';
      id: string;
      page: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      rects: HighlightRect[];
    }
  | {
      type: 'marker';
      id: string;
      page: number;
      startX: number;
      startY: number;
      rects: HighlightRect[];
    }
  | CommentResizeState;

const COMMENT_BUBBLE_MIN_WIDTH = 180;
const COMMENT_BUBBLE_MAX_WIDTH = 520;
const COMMENT_BUBBLE_MIN_HEIGHT = 80;
const COMMENT_BUBBLE_MAX_HEIGHT = 420;
const COMMENT_TITLE_FALLBACK = 'コメントタイトル';

@Component({
  selector: 'app-viewer-shell',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './viewer-shell.component.html',
  styleUrl: './viewer-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ViewerShellComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('commentBody') private commentBodies!: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren('replyTextarea') private replyTextareas!: QueryList<ElementRef<HTMLTextAreaElement>>;
  @ViewChildren('pageCanvas') private pageCanvases!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('pageTextLayer') private pageTextLayers!: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren('comparePageCanvas')
  private comparePageCanvases!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('comparePageTextLayer')
  private comparePageTextLayers!: QueryList<ElementRef<HTMLElement>>;
  @ViewChild('viewerSection') private viewerSection?: ElementRef<HTMLElement>;
  @ViewChild('viewerGrid') private viewerGrid?: ElementRef<HTMLElement>;
  @ViewChild('pagesHost') private pagesHost?: ElementRef<HTMLElement>;
  @ViewChild('comparePagesHost') private comparePagesHost?: ElementRef<HTMLElement>;
  @ViewChild('pdfViewerHost') private pdfViewerHost?: ElementRef<HTMLElement>;
  @ViewChild('comparePdfViewerHost') private comparePdfViewerHost?: ElementRef<HTMLElement>;

  protected readonly searchQuery = signal('');
  protected readonly ocrScope = signal<OcrScope>('page');
  protected readonly selectedOcrPage = signal(1);
  protected readonly contextMenu = signal<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    pageNumber: null,
    selectionPageNumber: null,
    selectionRects: [],
    canHighlight: false,
    selectionText: '',
    clickOffset: null,
    selectionOffsets: null
  });
  protected readonly replyDrafts = signal<Record<string, string>>({});
  protected readonly titleDrafts = signal<Record<string, string>>({});
  protected readonly selectedMarkerId = signal<string | null>(null);
  protected readonly selectedCommentId = signal<string | null>(null);
  protected readonly editingTitleCommentId = signal<string | null>(null);
  protected readonly showObjects = signal(true);
  protected readonly highlightSwatches = HIGHLIGHT_SWATCHES;
  protected readonly selectedHighlightColor = signal(HIGHLIGHT_SWATCHES[0].color);
  protected readonly commentLayoutSettings = signal<CommentLayoutSettings>({
    bubbleWidth: 260,
    bubbleHeight: 140
  });
  protected readonly ocrActionMessage = signal('');
  protected readonly pageOverlays = signal<PageOverlay[]>([]);
  protected readonly comparePageOverlays = signal<PageOverlay[]>([]);
  protected readonly commentSections = computed<CommentSection[]>(() => {
    const grouped = new Map<number, CommentCard[]>();
    this.annotations.allComments().forEach((comment) => {
      const list = grouped.get(comment.page);
      if (list) {
        list.push(comment);
      } else {
        grouped.set(comment.page, [comment]);
      }
    });
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a - b)
      .map(([page, comments]) => ({ page, comments }));
  });
  protected readonly highlightSections = computed<HighlightSection[]>(() => {
    const grouped = new Map<number, Marker[]>();
    this.annotations.userMarkers().forEach((marker) => {
      const list = grouped.get(marker.page);
      if (list) {
        list.push(marker);
      } else {
        grouped.set(marker.page, [marker]);
      }
    });
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a - b)
      .map(([page, highlights]) => ({ page, highlights }));
  });
  protected readonly highlightCount = computed(() => this.annotations.markerCount());

  protected readonly hasPdf = computed(() => this.pdf.pageCount() > 0);
  protected readonly zoomPercent = computed(() => Math.round(this.pdf.zoom() * 100));

  protected pdfSource(): string | undefined {
    return this.pdf.getCurrentFileSource() ?? undefined;
  }

  protected comparePdfSource(): string | undefined {
    return this.compare.compareTargetSource() ?? undefined;
  }

  private readonly pageElementMap = new Map<number, HTMLElement>();
  private readonly comparePageElementMap = new Map<number, HTMLElement>();
  private readonly textLayerElementMap = new Map<number, HTMLElement>();
  private readonly renderedTextLayers = new Set<number>();
  private readonly renderedCanvasPages = new Set<number>();
  private readonly renderedCompareCanvasPages = new Set<number>();
  private baseRenderQueue: Promise<void> = Promise.resolve();
  private compareRenderQueue: Promise<void> = Promise.resolve();
  private baseRenderToken = 0;
  private compareRenderToken = 0;
  private pageRenderSubscription?: Subscription;
  private compareRenderSubscription?: Subscription;
  private readonly textLayouts = new Map<number, PageTextLayout>();
  private readonly compareTextLayouts = new Map<number, PageTextLayout>();
  private readonly diffHighlights = signal<Record<number, HighlightRect[]>>({});
  private readonly compareDiffHighlights = signal<Record<number, HighlightRect[]>>({});
  private readonly diffCellLimit = 4_000_000;
  private pdfScrollContainer: HTMLElement | null = null;
  private compareScrollContainer: HTMLElement | null = null;
  private pdfScrollRaf: number | null = null;
  private compareScrollRaf: number | null = null;
  private isSyncingScroll = false;
  private dragState: DragState | null = null;
  protected readonly isBrowser: boolean;

  constructor(
    @Inject(PLATFORM_ID) private readonly platformId: Object,
    @Inject(FEATURE_FLAGS) protected readonly flags: FeatureFlags,
    protected pdf: PdfFacadeService,
    protected search: SearchFacadeService,
    protected annotations: AnnotationFacadeService,
    protected ocr: OcrFacadeService,
    protected compare: CompareFacadeService
  ) {
    this.isBrowser = isPlatformBrowser(this.platformId);
    this.configurePdfWorker();
  }

  private configurePdfWorker(): void {
    if (!this.isBrowser) {
      return;
    }
    const workerSrc = PDF_WORKER_SRC;
    GlobalWorkerOptions.workerSrc = workerSrc;
    const workerKey = `pdfWorkerSrc${pdfJsVersion}`;
    const target = window as typeof window & Record<string, unknown>;
    target['pdfWorkerSrc'] = workerSrc;
    target[workerKey] = workerSrc;
  }

  async ngAfterViewInit(): Promise<void> {
    this.syncDomRefs();
    this.syncCompareDomRefs();
    this.setupPageRendering();
  }

  ngOnDestroy(): void {
    this.teardownScrollListeners();
    this.teardownDragListeners();
    this.pageRenderSubscription?.unsubscribe();
    this.compareRenderSubscription?.unsubscribe();
  }

  private setupPageRendering(): void {
    if (!this.isBrowser) {
      return;
    }
    this.pageRenderSubscription = this.pageCanvases.changes.subscribe(() => {
      this.queueBaseRender();
    });
    this.compareRenderSubscription = this.comparePageCanvases.changes.subscribe(() => {
      this.queueCompareRender();
    });
    this.queueBaseRender();
    this.queueCompareRender();
  }

  private queueBaseRender(): void {
    const token = this.baseRenderToken;
    this.baseRenderQueue = this.baseRenderQueue
      .then(() => this.renderBasePages(token))
      .catch((err) => {
        console.warn('Failed to render PDF pages.', err);
      });
  }

  private queueCompareRender(): void {
    const token = this.compareRenderToken;
    this.compareRenderQueue = this.compareRenderQueue
      .then(() => this.renderComparePages(token))
      .catch((err) => {
        console.warn('Failed to render compare PDF pages.', err);
      });
  }

  private async renderBasePages(token: number): Promise<void> {
    if (!this.isBrowser || token !== this.baseRenderToken) {
      return;
    }
    const canvases = this.pageCanvases.toArray();
    const layers = this.pageTextLayers.toArray();
    if (!canvases.length) {
      return;
    }
    const layerMap = new Map<number, HTMLElement>();
    layers.forEach((layerRef) => {
      const layer = layerRef.nativeElement;
      const pageNumber = this.readPageNumber(layer);
      if (pageNumber) {
        layerMap.set(pageNumber, layer);
      }
    });

    for (const canvasRef of canvases) {
      if (token !== this.baseRenderToken) {
        return;
      }
      const canvas = canvasRef.nativeElement;
      const pageNumber = this.readPageNumber(canvas);
      if (!pageNumber || this.renderedCanvasPages.has(pageNumber)) {
        continue;
      }
      const pageElement = canvas.closest('.page') as HTMLElement | null;
      const viewport = await this.pdf.renderPageToCanvas(pageNumber, canvas);
      if (token !== this.baseRenderToken) {
        return;
      }
      if (!viewport) {
        continue;
      }
      const layer = layerMap.get(pageNumber);
      if (layer) {
        const layout = await this.pdf.renderTextLayer(
          pageNumber,
          layer,
          pageElement ?? undefined,
          viewport
        );
        if (token !== this.baseRenderToken) {
          return;
        }
        this.textLayerElementMap.set(pageNumber, layer);
        if (layout) {
          this.textLayouts.set(pageNumber, layout);
          this.renderedTextLayers.add(pageNumber);
        }
        this.updateDiffHighlightsForPage(pageNumber);
      }
      this.renderedCanvasPages.add(pageNumber);
    }

    this.syncDomRefs();
  }

  private async renderComparePages(token: number): Promise<void> {
    if (!this.isBrowser || token !== this.compareRenderToken) {
      return;
    }
    const canvases = this.comparePageCanvases.toArray();
    const layers = this.comparePageTextLayers.toArray();
    if (!canvases.length) {
      return;
    }
    const layerMap = new Map<number, HTMLElement>();
    layers.forEach((layerRef) => {
      const layer = layerRef.nativeElement;
      const pageNumber = this.readPageNumber(layer);
      if (pageNumber) {
        layerMap.set(pageNumber, layer);
      }
    });

    for (const canvasRef of canvases) {
      if (token !== this.compareRenderToken) {
        return;
      }
      const canvas = canvasRef.nativeElement;
      const pageNumber = this.readPageNumber(canvas);
      if (!pageNumber || this.renderedCompareCanvasPages.has(pageNumber)) {
        continue;
      }
      const pageElement = canvas.closest('.page') as HTMLElement | null;
      const viewport = await this.compare.renderComparePageToCanvas(pageNumber, canvas);
      if (token !== this.compareRenderToken) {
        return;
      }
      if (!viewport) {
        continue;
      }
      const layer = layerMap.get(pageNumber);
      if (layer) {
        await this.compare.renderCompareTextLayer(pageNumber, layer, viewport);
        if (token !== this.compareRenderToken) {
          return;
        }
        const layout = this.captureTextLayoutFromDom(pageNumber, layer, pageElement ?? undefined);
        if (layout) {
          this.compareTextLayouts.set(pageNumber, layout);
        }
        this.updateDiffHighlightsForPage(pageNumber);
      }
      this.renderedCompareCanvasPages.add(pageNumber);
    }

    this.syncCompareDomRefs();
  }

  protected onPageRendered(_event: CustomEvent): void {
    this.syncDomRefs();
  }

  protected onComparePageRendered(_event: CustomEvent): void {
    this.syncCompareDomRefs();
  }

  protected onTextLayerRendered(event: CustomEvent): void {
    const resolvedPageNumber = (event as { pageNumber?: number }).pageNumber;
    if (!resolvedPageNumber) {
      return;
    }
    const layer = this.resolveTextLayerElement(resolvedPageNumber, event, this.pageElementMap);
    if (!layer) {
      return;
    }
    this.textLayerElementMap.set(resolvedPageNumber, layer);
    const layout = this.captureTextLayoutFromDom(resolvedPageNumber, layer);
    if (layout) {
      this.textLayouts.set(resolvedPageNumber, layout);
      this.renderedTextLayers.add(resolvedPageNumber);
    }
    this.updateDiffHighlightsForPage(resolvedPageNumber);
  }

  protected onCompareTextLayerRendered(event: CustomEvent): void {
    const resolvedPageNumber = (event as { pageNumber?: number }).pageNumber;
    if (!resolvedPageNumber) {
      return;
    }
    const layer = this.resolveTextLayerElement(resolvedPageNumber, event, this.comparePageElementMap);
    if (!layer) {
      return;
    }
    const hostElement =
      this.comparePageElementMap.get(resolvedPageNumber) ?? layer.parentElement ?? undefined;
    const layout = this.captureTextLayoutFromDom(resolvedPageNumber, layer, hostElement);
    if (layout) {
      this.compareTextLayouts.set(resolvedPageNumber, layout);
    }
    this.updateDiffHighlightsForPage(resolvedPageNumber);
  }

  protected pageAnchorId(page: number): string {
    return `page-${page}`;
  }

  protected comparePageAnchorId(page: number): string {
    return `compare-page-${page}`;
  }

  protected isChangedPage(pageNumber: number): boolean {
    return this.compare.result()?.changedPages?.includes(pageNumber) ?? false;
  }

  protected diffRectsFor(pageNumber: number): HighlightRect[] {
    return this.diffHighlights()[pageNumber] ?? [];
  }

  protected compareDiffRectsFor(pageNumber: number): HighlightRect[] {
    return this.compareDiffHighlights()[pageNumber] ?? [];
  }

  protected jumpToComparePage(pageNumber: number): void {
    this.scrollToPage(pageNumber);
    this.scrollToComparePage(pageNumber);
  }

  protected markersFor(page: number): Marker[] {
    return this.annotations.markersByPage(page);
  }

  protected commentsFor(page: number): CommentCard[] {
    return this.annotations.commentsByPage(page);
  }

  protected trackPageOverlay(_index: number, overlay: PageOverlay): number {
    return overlay.pageNumber;
  }

  protected trackMarker(_index: number, marker: Marker): string {
    return marker.id;
  }

  protected trackComment(_index: number, comment: CommentCard): string {
    return comment.id;
  }

  protected trackCommentSection(_index: number, section: CommentSection): number {
    return section.page;
  }

  protected trackHighlightSection(_index: number, section: HighlightSection): number {
    return section.page;
  }

  protected trackHighlightItem(_index: number, highlight: Marker): string {
    return highlight.id;
  }

  protected latestMessage(comment: CommentCard): CommentMessage | undefined {
    return comment.messages[comment.messages.length - 1];
  }

  protected replyDraft(id: string): string {
    return this.replyDrafts()[id] ?? '';
  }

  protected setReplyDraft(id: string, text: string): void {
    this.replyDrafts.update((drafts) => ({ ...drafts, [id]: text }));
  }

  protected titleDraft(id: string): string {
    return this.titleDrafts()[id] ?? '';
  }

  protected setTitleDraft(id: string, text: string): void {
    this.titleDrafts.update((drafts) => ({ ...drafts, [id]: text }));
  }

  protected addReply(commentId: string): void {
    if (!this.flags.comments) {
      return;
    }
    if (!this.isEditableCommentId(commentId)) {
      return;
    }
    const text = this.replyDraft(commentId).trim();
    if (!text) {
      return;
    }
    this.annotations.addReply(commentId, text);
    this.replyDrafts.update(({ [commentId]: _removed, ...rest }) => rest);
    this.scrollCommentBodyToEnd(commentId);
  }

  protected hasReplyDraft(commentId: string): boolean {
    return this.replyDraft(commentId).trim().length > 0;
  }

  protected isSelectedMarker(id: string): boolean {
    return this.selectedMarkerId() === id;
  }

  protected isSelectedComment(id: string): boolean {
    return this.selectedCommentId() === id;
  }

  protected isReadOnlyMarker(marker: Marker): boolean {
    return marker.origin === 'pdf';
  }

  protected isReadOnlyComment(comment: CommentCard): boolean {
    return comment.origin === 'pdf';
  }

  protected isEditingTitle(id: string): boolean {
    return this.editingTitleCommentId() === id;
  }

  protected commentTitle(comment: CommentCard): string {
    const title = comment.title?.trim() ?? '';
    return title || COMMENT_TITLE_FALLBACK;
  }

  protected highlightLabel(highlight: Marker): string {
    const text = highlight.text?.trim() ?? '';
    const label = highlight.label?.trim() ?? '';
    return text || label || 'ハイライト';
  }

  protected highlightStrongColor(color: string): string {
    const rgba = this.parseColorToRgba(color);
    if (!rgba) {
      return color;
    }
    const alpha = this.clamp(Math.max(rgba.a, 0.85), 0, 1);
    return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${alpha.toFixed(2)})`;
  }

  private isEditableMarkerId(id: string): boolean {
    return this.annotations.exportMarkers().some((marker) => marker.id === id);
  }

  private isEditableCommentId(id: string): boolean {
    return this.annotations.exportComments().some((comment) => comment.id === id);
  }

  protected removeHighlight(highlightId: string): void {
    if (!this.isEditableMarkerId(highlightId)) {
      return;
    }
    this.annotations.removeMarker(highlightId);
    if (this.selectedMarkerId() === highlightId) {
      this.selectedMarkerId.set(null);
    }
  }

  protected startTitleEdit(comment: CommentCard, event?: Event): void {
    if (!this.flags.comments) {
      return;
    }
    if (this.isReadOnlyComment(comment)) {
      return;
    }
    event?.stopPropagation();
    this.editingTitleCommentId.set(comment.id);
    this.titleDrafts.update((drafts) => ({
      ...drafts,
      [comment.id]: comment.title ?? ''
    }));
  }

  protected cancelTitleEdit(commentId: string): void {
    this.editingTitleCommentId.set(null);
    this.titleDrafts.update(({ [commentId]: _removed, ...rest }) => rest);
  }

  protected saveTitleEdit(commentId: string): void {
    if (!this.flags.comments) {
      return;
    }
    if (!this.isEditableCommentId(commentId)) {
      return;
    }
    if (!this.isEditingTitle(commentId)) {
      return;
    }
    const nextTitle = this.titleDraft(commentId).trim();
    if (!nextTitle) {
      this.cancelTitleEdit(commentId);
      return;
    }
    this.annotations.updateCommentTitle(commentId, nextTitle);
    this.cancelTitleEdit(commentId);
  }

  protected focusMarker(marker: Marker, event?: Event): void {
    if (!this.flags.markers) {
      return;
    }
    if (this.shouldIgnoreSelection(event)) {
      return;
    }
    this.selectedMarkerId.set(marker.id);
    this.selectedCommentId.set(null);
    this.scrollMarkerIntoView(marker);
  }

  protected focusComment(comment: CommentCard, event?: Event): void {
    if (!this.flags.comments) {
      return;
    }
    if (this.shouldIgnoreSelection(event)) {
      return;
    }
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.scrollCommentIntoView(comment);
  }

  protected focusSearchHit(hit: SearchHit, event?: Event): void {
    if (!this.flags.search) {
      return;
    }
    const marker = this.annotations
      .allMarkers()
      .find((item) => item.source === 'search' && item.page === hit.page);
    if (marker) {
      this.selectedMarkerId.set(marker.id);
      this.selectedCommentId.set(null);
      this.scrollMarkerIntoView(marker);
      event?.preventDefault();
      return;
    }
    const scrolled = this.scrollToPage(hit.page);
    if (scrolled) {
      event?.preventDefault();
    }
  }

  protected commentPreview(comment: CommentCard): string {
    return this.latestMessage(comment)?.text ?? COMMENT_TITLE_FALLBACK;
  }

  protected startCommentBubbleDrag(comment: CommentCard, event: PointerEvent): void {
    if (!this.flags.comments) {
      return;
    }
    if (this.isReadOnlyComment(comment)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const pageElement = this.pageElementMap.get(comment.page);
    if (!pageElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointer = this.normalizeCoordinates(event, pageElement);
    this.dragState = {
      type: 'comment-bubble',
      id: comment.id,
      page: comment.page,
      offsetX: comment.bubbleX - pointer.x,
      offsetY: comment.bubbleY - pointer.y
    };
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.attachDragListeners();
  }

  protected startCommentAnchorDrag(comment: CommentCard, event: PointerEvent): void {
    if (!this.flags.comments) {
      return;
    }
    if (this.isReadOnlyComment(comment)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const pageElement = this.pageElementMap.get(comment.page);
    if (!pageElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointer = this.normalizeCoordinates(event, pageElement);
    this.dragState = {
      type: 'comment-anchor',
      id: comment.id,
      page: comment.page,
      offsetX: comment.anchorX - pointer.x,
      offsetY: comment.anchorY - pointer.y
    };
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.attachDragListeners();
  }

  protected startMarkerDrag(marker: Marker, event: PointerEvent): void {
    if (!this.flags.markers) {
      return;
    }
    if (this.isReadOnlyMarker(marker)) {
      return;
    }
    if (marker.source !== 'selection') {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const pageElement = this.pageElementMap.get(marker.page);
    if (!pageElement) {
      return;
    }
    event.stopPropagation();
    const pointer = this.normalizeCoordinates(event, pageElement);
    this.dragState = {
      type: 'marker-pending',
      id: marker.id,
      page: marker.page,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pointer.x * 100,
      startY: pointer.y * 100,
      rects: marker.rects.map((rect) => ({ ...rect }))
    };
    this.selectedMarkerId.set(marker.id);
    this.selectedCommentId.set(null);
    this.attachDragListeners();
  }

  protected calloutLayout(comment: CommentCard): CommentCalloutLayout {
    const pageElement = this.pageElementMap.get(comment.page);
    if (!pageElement) {
      return { lineLength: 0, lineAngle: 0 };
    }
    const rect = pageElement.getBoundingClientRect();
    const bubbleWidth = this.getBubbleWidth(comment);
    const bubbleHeight = this.getBubbleHeight(comment);
    const anchorX = comment.anchorX * rect.width;
    const anchorY = comment.anchorY * rect.height;
    const bubbleX = comment.bubbleX * rect.width;
    const bubbleY = comment.bubbleY * rect.height;
    const halfWidth = bubbleWidth / 2;
    const halfHeight = bubbleHeight / 2;
    const rectLeft = bubbleX - halfWidth;
    const rectRight = bubbleX + halfWidth;
    const rectTop = bubbleY - halfHeight;
    const rectBottom = bubbleY + halfHeight;

    let targetX = this.clamp(anchorX, rectLeft, rectRight);
    let targetY = this.clamp(anchorY, rectTop, rectBottom);

    const inside =
      anchorX >= rectLeft && anchorX <= rectRight && anchorY >= rectTop && anchorY <= rectBottom;
    if (inside) {
      const distLeft = Math.abs(anchorX - rectLeft);
      const distRight = Math.abs(rectRight - anchorX);
      const distTop = Math.abs(anchorY - rectTop);
      const distBottom = Math.abs(rectBottom - anchorY);
      const minDist = Math.min(distLeft, distRight, distTop, distBottom);
      if (minDist === distLeft) {
        targetX = rectLeft;
        targetY = anchorY;
      } else if (minDist === distRight) {
        targetX = rectRight;
        targetY = anchorY;
      } else if (minDist === distTop) {
        targetX = anchorX;
        targetY = rectTop;
      } else {
        targetX = anchorX;
        targetY = rectBottom;
      }
    }

    const dx = targetX - anchorX;
    const dy = targetY - anchorY;
    const lineLength = Math.sqrt(dx * dx + dy * dy);
    const lineAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    return {
      lineLength,
      lineAngle
    };
  }

  protected startCommentResize(comment: CommentCard, axis: CommentResizeAxis, event: PointerEvent): void {
    if (!this.flags.comments) {
      return;
    }
    if (this.isReadOnlyComment(comment)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const bubbleElement = (event.target as HTMLElement).closest(
      '.viewer-shell__comment-bubble'
    ) as HTMLElement | null;
    if (!bubbleElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = bubbleElement.getBoundingClientRect();
    const fallbackWidth = this.getBubbleWidth(comment);
    const fallbackHeight = this.getBubbleHeight(comment);
    const startWidth = rect.width || fallbackWidth;
    const startHeight = rect.height || fallbackHeight;
    this.dragState = {
      type: 'comment-resize',
      id: comment.id,
      axis,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth,
      startHeight
    };
    this.attachDragListeners();
  }

  protected setCommentLayoutValue<K extends keyof CommentLayoutSettings>(
    key: K,
    rawValue: string | number
  ): void {
    const value = Number(rawValue);
    if (Number.isNaN(value)) {
      return;
    }
    let clamped: number;
    if (key === 'bubbleWidth') {
      clamped = this.clamp(value, COMMENT_BUBBLE_MIN_WIDTH, COMMENT_BUBBLE_MAX_WIDTH);
    } else {
      clamped = this.clamp(value, COMMENT_BUBBLE_MIN_HEIGHT, COMMENT_BUBBLE_MAX_HEIGHT);
    }
    this.commentLayoutSettings.update((current) => ({ ...current, [key]: clamped }));
  }

  protected async onFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    input.value = '';
    this.resetFeatureStates();
    await this.pdf.loadFile(file);
    await this.loadPdfAnnotations();
    this.selectedOcrPage.set(1);
    this.queueBaseRender();
  }

  private async loadPdfAnnotations(): Promise<void> {
    if (!this.flags.markers && !this.flags.comments) {
      this.annotations.setImportedMarkers([]);
      this.annotations.setImportedComments([]);
      return;
    }
    try {
      const { markers, comments } = await this.pdf.readPdfAnnotations();
      this.annotations.setImportedMarkers(this.flags.markers ? markers : []);
      this.annotations.setImportedComments(this.flags.comments ? comments : []);
    } catch (err) {
      console.warn('PDF annotation import failed.', err);
      this.annotations.setImportedMarkers([]);
      this.annotations.setImportedComments([]);
    }
  }

  protected async onCompareFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (!this.flags.compare) {
      input.value = '';
      return;
    }
    this.resetCompareViewState();
    await this.compare.compareWith(file);
    this.updateAllDiffHighlights();
    this.queueCompareRender();
    input.value = '';
  }

  protected clearCompareMode(): void {
    if (!this.flags.compare) {
      return;
    }
    this.compare.reset();
    this.resetCompareViewState();
  }

  protected async performSearch(): Promise<void> {
    if (!this.flags.search) {
      return;
    }
    await this.search.search(this.searchQuery());
    await this.applySearchHighlights(this.searchQuery());
  }

  protected clearSearch(): void {
    if (!this.flags.search) {
      return;
    }
    this.searchQuery.set('');
    this.search.clear();
    this.annotations.setSearchHighlights([]);
  }

  protected toggleObjects(): void {
    if (!this.flags.markers && !this.flags.comments) {
      return;
    }
    this.showObjects.update((value) => !value);
  }

  protected async zoomIn(): Promise<void> {
    await this.applyZoomChange(() => this.pdf.zoomIn());
  }

  protected async zoomOut(): Promise<void> {
    await this.applyZoomChange(() => this.pdf.zoomOut());
  }

  protected async resetZoom(): Promise<void> {
    await this.applyZoomChange(() => this.pdf.resetZoom());
  }

  protected async downloadPdf(): Promise<void> {
    if (!this.hasPdf()) {
      return;
    }
    const includeAnnotations = this.flags.annotatedDownload;
    await this.pdf.downloadCurrentPdf({
      includeAnnotations,
      annotations: includeAnnotations ? this.buildAnnotationExport() : undefined
    });
  }

  private buildAnnotationExport(): PdfAnnotationExport {
    const highlights: PdfHighlightAnnotation[] = [];
    if (this.flags.markers) {
      this.annotations.exportMarkers().forEach((marker) => {
        if (!marker.rects.length) {
          return;
        }
        const contents = marker.text?.trim() || marker.label?.trim() || undefined;
        highlights.push({
          id: marker.id,
          page: marker.page,
          rects: marker.rects,
          color: marker.color,
          contents
        });
      });
    }

    return {
      highlights,
      comments: this.flags.comments ? this.annotations.exportComments() : []
    };
  }

  protected openContextMenuFromViewer(event: MouseEvent): void {
    if (!this.flags.comments && !this.flags.markers) {
      return;
    }
    event.preventDefault();
    const pageNumber = this.resolvePageNumberFromEvent(event, this.pageElementMap);
    if (!pageNumber) {
      return;
    }
    const pageElement =
      ((event.target as HTMLElement | null)?.closest('.page') as HTMLElement | null) ??
      this.pageElementMap.get(pageNumber);
    const clickOffset = pageElement ? this.normalizeCoordinates(event, pageElement) : null;
    const selection = window.getSelection();
    const selectionRects =
      this.flags.markers && selection ? this.collectSelectionRectsByPage(selection) : [];
    const selectionContext =
      this.flags.markers && selectionRects.length === 0 ? this.resolveSelectionContext(pageNumber) : null;
    const canHighlight =
      this.flags.markers && (selectionRects.length > 0 || Boolean(selectionContext));
    const selectionPageNumber =
      selectionRects.length === 1
        ? selectionRects[0].pageNumber
        : selectionContext?.pageNumber ?? null;
    const selectionText = canHighlight ? selection?.toString() ?? '' : '';
    const selectionOffsets =
      selectionContext && selectionContext.pageNumber === selectionPageNumber
        ? this.getSelectionOffsets(selectionContext.pageNumber, selectionContext.selection)
        : null;
    this.contextMenu.set({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      pageNumber,
      selectionPageNumber,
      selectionRects,
      canHighlight,
      selectionText,
      clickOffset,
      selectionOffsets
    });
  }

  protected addHighlightFromSelection(): void {
    if (!this.flags.markers) {
      this.closeContextMenu();
      return;
    }
    const state = this.contextMenu();
    const color = this.selectedHighlightColor();
    const highlightText = state.selectionText?.trim() || undefined;
    const selectionRects = state.selectionRects.filter((section) => section.rects.length > 0);
    if (selectionRects.length > 0) {
      selectionRects.forEach((section) => {
        this.annotations.addMarker(section.pageNumber, section.rects, '', color, 'selection', highlightText);
      });
      window.getSelection()?.removeAllRanges();
      this.closeContextMenu();
      return;
    }
    const selectionPageNumber = state.selectionPageNumber;
    if (!selectionPageNumber) {
      return;
    }
    const selectionContext = this.resolveSelectionContext(selectionPageNumber);
    const selection =
      selectionContext && selectionContext.pageNumber === selectionPageNumber
        ? selectionContext.selection
        : null;
    const anchorElement =
      selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? (selection.anchorNode as Element)
        : selection?.anchorNode?.parentElement ?? null;
    let layer = this.textLayerElementMap.get(selectionPageNumber) ?? null;
    if (!layer && selection) {
      const resolved = this.resolveTextLayerFromSelection(selection);
      if (resolved && resolved.pageNumber === selectionPageNumber) {
        layer = resolved.layer;
      }
    }
    const pageElement =
      this.pageElementMap.get(selectionPageNumber) ??
      (anchorElement?.closest('.page') as HTMLElement | null) ??
      (layer?.closest('.page') as HTMLElement | null);
    if (!layer && pageElement) {
      layer = pageElement.querySelector('.textLayer') as HTMLElement | null;
      if (layer) {
        this.textLayerElementMap.set(selectionPageNumber, layer);
        const layout = this.captureTextLayoutFromDom(selectionPageNumber, layer);
        if (layout) {
          this.textLayouts.set(selectionPageNumber, layout);
          this.renderedTextLayers.add(selectionPageNumber);
        }
      }
    }
    if (!pageElement) {
      this.closeContextMenu();
      return;
    }
    const highlightTextFallback = state.selectionText?.trim() ?? (selection ? selection.toString().trim() : '');
    const offsets =
      state.selectionOffsets ??
      (selection ? this.getSelectionOffsets(selectionPageNumber, selection) : null);
    let range: Range | null = null;
    if (offsets && layer) {
      range = this.createRangeFromOffsets(layer, offsets.start, offsets.end);
    } else if (selection?.rangeCount) {
      range = selection.getRangeAt(0);
    }
    if (!range || range.collapsed) {
      this.closeContextMenu();
      return;
    }
    const rects = this.rectsFromRange(range, pageElement);
    if (rects.length === 0) {
      this.closeContextMenu();
      return;
    }
    this.annotations.addMarker(
      selectionPageNumber,
      rects,
      '',
      color,
      'selection',
      highlightTextFallback || undefined
    );
    selection?.removeAllRanges();
    this.closeContextMenu();
  }

  protected addCommentFromContextMenu(): void {
    if (!this.flags.comments) {
      this.closeContextMenu();
      return;
    }
    const state = this.contextMenu();
    if (!state.pageNumber || !state.clickOffset) {
      this.closeContextMenu();
      return;
    }
    const { x, y } = state.clickOffset;
    const comment = this.annotations.addComment(state.pageNumber, x, y);
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.focusReplyTextarea(comment.id);
    this.closeContextMenu();
  }

  protected onReplyKeydown(commentId: string, event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.addReply(commentId);
    }
  }

  private focusReplyTextarea(commentId: string): void {
    if (!this.isBrowser) {
      return;
    }
    setTimeout(() => {
      const target = this.replyTextareas
        ?.toArray()
        .find((item) => item.nativeElement.dataset['commentId'] === commentId);
      target?.nativeElement.focus();
    }, 0);
  }

  private scrollCommentBodyToEnd(commentId: string): void {
    if (!this.isBrowser) {
      return;
    }
    setTimeout(() => {
      const target = this.commentBodies
        ?.toArray()
        .find((item) => item.nativeElement.dataset['commentId'] === commentId);
      if (!target) {
        return;
      }
      target.nativeElement.scrollTop = target.nativeElement.scrollHeight;
    }, 0);
  }

  protected closeContextMenu(): void {
    this.contextMenu.set({
      visible: false,
      x: 0,
      y: 0,
      pageNumber: null,
      selectionPageNumber: null,
      selectionRects: [],
      canHighlight: false,
      selectionText: '',
      clickOffset: null,
      selectionOffsets: null
    });
  }

  protected selectHighlightColor(color: string): void {
    this.selectedHighlightColor.set(color);
  }

  protected updateMarker(id: string, label: string, color: string): void {
    if (!this.flags.markers) {
      return;
    }
    if (!this.isEditableMarkerId(id)) {
      return;
    }
    this.annotations.updateMarker(id, { label, color });
  }

  protected updateComment(id: string, text: string): void {
    if (!this.flags.comments) {
      return;
    }
    if (!this.isEditableCommentId(id)) {
      return;
    }
    this.annotations.updateComment(id, text);
  }

  protected removeMarker(id: string): void {
    if (!this.flags.markers) {
      return;
    }
    if (!this.isEditableMarkerId(id)) {
      return;
    }
    if (this.selectedMarkerId() === id) {
      this.selectedMarkerId.set(null);
    }
    this.annotations.removeMarker(id);
  }

  protected removeComment(id: string): void {
    if (!this.flags.comments) {
      return;
    }
    if (!this.isEditableCommentId(id)) {
      return;
    }
    if (this.selectedCommentId() === id) {
      this.selectedCommentId.set(null);
    }
    this.annotations.removeComment(id);
  }

  protected async runOcr(): Promise<void> {
    if (!this.flags.ocr) {
      return;
    }
    this.ocrActionMessage.set('');
    if (this.ocrScope() === 'all') {
      await this.ocr.runOcrAll();
      return;
    }
    await this.ocr.runOcr(this.selectedOcrPage());
  }

  protected async copyOcrResult(): Promise<void> {
    if (!this.isBrowser) {
      return;
    }
    const text = this.resolveOcrText();
    if (!text) {
      this.ocrActionMessage.set('コピー対象のテキストがありません。');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      this.ocrActionMessage.set('クリップボードにコピーしました。');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'コピーに失敗しました。';
      this.ocrActionMessage.set(message);
    }
  }

  protected exportOcrResult(): void {
    if (!this.isBrowser) {
      return;
    }
    const text = this.resolveOcrText();
    if (!text) {
      this.ocrActionMessage.set('エクスポート対象のテキストがありません。');
      return;
    }
    const result = this.ocr.result();
    const filename = this.buildOcrExportFileName(result ?? undefined);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    this.ocrActionMessage.set('テキストファイルを保存しました。');
  }

  protected ocrResultTag(result: OcrResult): string {
    const total = result.pageCount ?? this.pdf.pageCount();
    if (result.scope === 'page') {
      return total ? `p${result.page} / ${total}` : `p${result.page}`;
    }
    return total ? `全ページ (${total})` : '全ページ';
  }

  private resetFeatureStates(): void {
    this.searchQuery.set('');
    this.ocrScope.set('page');
    this.search.clear();
    this.annotations.reset();
    this.compare.reset();
    this.ocr.reset();
    this.ocrActionMessage.set('');
    this.selectedMarkerId.set(null);
    this.selectedCommentId.set(null);
    this.resetViewState();
  }

  private resetViewState(): void {
    this.renderedTextLayers.clear();
    this.renderedCanvasPages.clear();
    this.baseRenderToken += 1;
    this.pageElementMap.clear();
    this.textLayerElementMap.clear();
    this.textLayouts.clear();
    this.pageOverlays.set([]);
    this.ocrActionMessage.set('');
    this.resetCompareViewState();
    this.isSyncingScroll = false;
    this.dragState = null;
    this.teardownDragListeners();
    this.closeContextMenu();
  }

  private resolveOcrText(): string {
    return this.ocr.result()?.text?.trim() ?? '';
  }

  private buildOcrExportFileName(result?: OcrResult): string {
    const baseName = this.pdf.pdfName()?.replace(/\.[^.]+$/, '') || 'ocr-text';
    if (!result) {
      return `${baseName}.txt`;
    }
    if (result.scope === 'page') {
      return `${baseName}-p${result.page ?? 1}.txt`;
    }
    return `${baseName}-all.txt`;
  }

  private resetCompareViewState(): void {
    this.comparePageElementMap.clear();
    this.compareTextLayouts.clear();
    this.renderedCompareCanvasPages.clear();
    this.compareRenderToken += 1;
    this.comparePageOverlays.set([]);
    this.clearDiffHighlights();
    this.clearScrollContainer('compare');
  }

  private async applyZoomChange(action: () => Promise<void> | void): Promise<void> {
    this.resetViewState();
    await action();
    await this.compare.refreshTargetPages();
    this.queueBaseRender();
    this.queueCompareRender();
  }

  private normalizeCoordinates(
    event: MouseEvent | PointerEvent,
    host: HTMLElement
  ): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
  }

  private attachDragListeners(): void {
    this.teardownDragListeners();
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.stopDragging);
    window.addEventListener('pointercancel', this.stopDragging);
  }

  private teardownDragListeners(): void {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.stopDragging);
    window.removeEventListener('pointercancel', this.stopDragging);
  }

  private handlePdfScroll = (): void => {
    this.scheduleScrollSync('base');
  };

  private handleCompareScroll = (): void => {
    this.scheduleScrollSync('compare');
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragState) {
      return;
    }
    if (this.dragState.type === 'comment-bubble') {
      const pageElement = this.pageElementMap.get(this.dragState.page);
      if (!pageElement) {
        return;
      }
      const pointer = this.normalizeCoordinates(event, pageElement);
      const bounds = this.getCommentDragBounds(pageElement);
      const nextX = this.clamp(pointer.x + this.dragState.offsetX, bounds.minX, bounds.maxX);
      const nextY = this.clamp(pointer.y + this.dragState.offsetY, bounds.minY, bounds.maxY);
      this.annotations.moveCommentBubble(this.dragState.id, nextX, nextY);
      return;
    }
    if (this.dragState.type === 'comment-anchor') {
      const pageElement = this.pageElementMap.get(this.dragState.page);
      if (!pageElement) {
        return;
      }
      const pointer = this.normalizeCoordinates(event, pageElement);
      const nextX = this.clamp01(pointer.x + this.dragState.offsetX);
      const nextY = this.clamp01(pointer.y + this.dragState.offsetY);
      this.annotations.moveCommentAnchor(this.dragState.id, nextX, nextY);
      return;
    }
    if (this.dragState.type === 'marker-pending') {
      const dx = event.clientX - this.dragState.startClientX;
      const dy = event.clientY - this.dragState.startClientY;
      const thresholdPx = 3;
      if (dx * dx + dy * dy < thresholdPx * thresholdPx) {
        return;
      }
      this.dragState = {
        type: 'marker',
        id: this.dragState.id,
        page: this.dragState.page,
        startX: this.dragState.startX,
        startY: this.dragState.startY,
        rects: this.dragState.rects
      };
    }
    if (this.dragState.type === 'marker') {
      const pageElement = this.pageElementMap.get(this.dragState.page);
      if (!pageElement) {
        return;
      }
      event.preventDefault();
      const pointer = this.normalizeCoordinates(event, pageElement);
      const dx = pointer.x * 100 - this.dragState.startX;
      const dy = pointer.y * 100 - this.dragState.startY;
      const rects = this.dragState.rects.map((rect) => this.shiftRect(rect, dx, dy));
      this.annotations.moveMarker(this.dragState.id, rects);
      return;
    }
    if (this.dragState.type === 'comment-resize') {
      const deltaX = event.clientX - this.dragState.startClientX;
      const deltaY = event.clientY - this.dragState.startClientY;
      const updates: Partial<Pick<CommentCard, 'bubbleWidth' | 'bubbleHeight'>> = {};
      if (this.dragState.axis === 'bubbleWidth' || this.dragState.axis === 'bubbleBoth') {
        const rawWidth = this.dragState.startWidth + deltaX;
        updates.bubbleWidth = Math.round(
          this.clamp(rawWidth, COMMENT_BUBBLE_MIN_WIDTH, COMMENT_BUBBLE_MAX_WIDTH)
        );
      }
      if (this.dragState.axis === 'bubbleHeight' || this.dragState.axis === 'bubbleBoth') {
        const rawHeight = this.dragState.startHeight + deltaY;
        updates.bubbleHeight = Math.round(
          this.clamp(rawHeight, COMMENT_BUBBLE_MIN_HEIGHT, COMMENT_BUBBLE_MAX_HEIGHT)
        );
      }
      if (Object.keys(updates).length > 0) {
        this.annotations.updateCommentLayout(this.dragState.id, updates);
      }
    }
  };

  private stopDragging = (): void => {
    if (!this.dragState) {
      return;
    }
    this.dragState = null;
    this.teardownDragListeners();
  };

  private shiftRect(rect: HighlightRect, dx: number, dy: number): HighlightRect {
    const maxLeft = Math.max(100 - rect.width, 0);
    const maxTop = Math.max(100 - rect.height, 0);
    const left = this.clamp(rect.left + dx, 0, maxLeft);
    const top = this.clamp(rect.top + dy, 0, maxTop);
    return {
      ...rect,
      left: Number(left.toFixed(4)),
      top: Number(top.toFixed(4))
    };
  }

  private clamp01(value: number): number {
    return this.clamp(value, 0, 1);
  }

  private clamp(value: number, min: number, max: number): number {
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private getCommentDragBounds(pageElement: HTMLElement): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } {
    const pagesElement = this.pagesHost?.nativeElement ?? pageElement.parentElement;
    if (!pagesElement) {
      return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    }
    const pageRect = pageElement.getBoundingClientRect();
    const pagesRect = pagesElement.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) {
      return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    }
    return {
      minX: (pagesRect.left - pageRect.left) / pageRect.width,
      maxX: (pagesRect.right - pageRect.left) / pageRect.width,
      minY: (pagesRect.top - pageRect.top) / pageRect.height,
      maxY: (pagesRect.bottom - pageRect.top) / pageRect.height
    };
  }

  private getBubbleWidth(comment: CommentCard): number {
    const fallback = this.commentLayoutSettings().bubbleWidth;
    const width = comment.bubbleWidth ?? fallback;
    return this.clamp(width || fallback, COMMENT_BUBBLE_MIN_WIDTH, COMMENT_BUBBLE_MAX_WIDTH);
  }

  private getBubbleHeight(comment: CommentCard): number {
    const fallback = this.commentLayoutSettings().bubbleHeight;
    const height = comment.bubbleHeight ?? fallback;
    return this.clamp(height || fallback, COMMENT_BUBBLE_MIN_HEIGHT, COMMENT_BUBBLE_MAX_HEIGHT);
  }

  private resolvePageElement(
    pageNumber: number,
    pageMap: Map<number, HTMLElement>,
    viewerHost: HTMLElement | undefined
  ): HTMLElement | null {
    const cached = pageMap.get(pageNumber);
    if (cached) {
      return cached;
    }
    const pageElement =
      this.collectPdfPageElements(viewerHost).find(
        (candidate) => this.readPageNumber(candidate) === pageNumber
      ) ?? null;
    if (pageElement) {
      pageMap.set(pageNumber, pageElement);
    }
    return pageElement;
  }

  private scrollMarkerIntoView(marker: Marker): void {
    const rect = this.resolveMarkerClientRect(marker);
    const scrollContainer =
      this.pdfScrollContainer ?? this.resolveScrollContainer(this.pdfViewerHost?.nativeElement);
    if (this.scrollViewerToRect(rect, scrollContainer)) {
      return;
    }
    this.scrollToPage(marker.page);
  }

  private scrollCommentIntoView(comment: CommentCard): void {
    const rect = this.resolveCommentBubbleRect(comment);
    const scrollContainer =
      this.pdfScrollContainer ?? this.resolveScrollContainer(this.pdfViewerHost?.nativeElement);
    if (this.scrollViewerToRect(rect, scrollContainer)) {
      return;
    }
    this.scrollToPage(comment.page);
  }

  private resolveMarkerClientRect(marker: Marker): DOMRect | null {
    if (!this.isBrowser || typeof document === 'undefined') {
      return null;
    }
    const domRects: DOMRect[] = [];
    document
      .querySelectorAll<HTMLElement>(
        `.viewer-shell__page-highlight[data-marker-id="${marker.id}"], .viewer-shell__page-highlight-label[data-marker-id="${marker.id}"]`
      )
      .forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width || rect.height) {
          domRects.push(rect);
        }
      });
    const mergedDomRect = this.mergeClientRects(domRects);
    if (mergedDomRect) {
      return mergedDomRect;
    }
    const pageElement = this.resolvePageElement(
      marker.page,
      this.pageElementMap,
      this.pdfViewerHost?.nativeElement
    );
    if (!pageElement || !marker.rects.length) {
      return null;
    }
    const pageRect = pageElement.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) {
      return null;
    }
    const bounds = marker.rects.map((rect) => ({
      left: pageRect.left + (rect.left / 100) * pageRect.width,
      top: pageRect.top + (rect.top / 100) * pageRect.height,
      right: pageRect.left + ((rect.left + rect.width) / 100) * pageRect.width,
      bottom: pageRect.top + ((rect.top + rect.height) / 100) * pageRect.height
    }));
    return this.mergeBounds(bounds);
  }

  private resolveCommentBubbleRect(comment: CommentCard): DOMRect | null {
    if (!this.isBrowser || typeof document === 'undefined') {
      return null;
    }
    const bubble = document.querySelector<HTMLElement>(
      `.viewer-shell__comment-bubble[data-comment-id="${comment.id}"]`
    );
    if (bubble) {
      return bubble.getBoundingClientRect();
    }
    const pageElement = this.resolvePageElement(
      comment.page,
      this.pageElementMap,
      this.pdfViewerHost?.nativeElement
    );
    if (!pageElement) {
      return null;
    }
    const pageRect = pageElement.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) {
      return null;
    }
    const bubbleWidth = this.getBubbleWidth(comment);
    const bubbleHeight = this.getBubbleHeight(comment);
    const centerX = pageRect.left + pageRect.width * comment.bubbleX;
    const centerY = pageRect.top + pageRect.height * comment.bubbleY;
    return new DOMRect(centerX - bubbleWidth / 2, centerY - bubbleHeight / 2, bubbleWidth, bubbleHeight);
  }

  private mergeClientRects(rects: DOMRect[]): DOMRect | null {
    if (!rects.length) {
      return null;
    }
    const bounds = rects.map((rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    }));
    return this.mergeBounds(bounds);
  }

  private mergeBounds(
    bounds: Array<{ left: number; top: number; right: number; bottom: number }>
  ): DOMRect | null {
    if (!bounds.length) {
      return null;
    }
    let left = bounds[0].left;
    let top = bounds[0].top;
    let right = bounds[0].right;
    let bottom = bounds[0].bottom;
    for (let i = 1; i < bounds.length; i += 1) {
      left = Math.min(left, bounds[i].left);
      top = Math.min(top, bounds[i].top);
      right = Math.max(right, bounds[i].right);
      bottom = Math.max(bottom, bounds[i].bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }

  private scrollToPage(pageNumber: number): boolean {
    const pageElement = this.resolvePageElement(
      pageNumber,
      this.pageElementMap,
      this.pdfViewerHost?.nativeElement
    );
    if (!pageElement) {
      return false;
    }
    const rect = pageElement.getBoundingClientRect();
    const scrollContainer =
      this.pdfScrollContainer ?? this.resolveScrollContainer(this.pdfViewerHost?.nativeElement);
    if (this.scrollViewerToRect(rect, scrollContainer)) {
      return true;
    }
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return true;
  }

  private scrollToComparePage(pageNumber: number): boolean {
    const pageElement = this.resolvePageElement(
      pageNumber,
      this.comparePageElementMap,
      this.comparePdfViewerHost?.nativeElement
    );
    if (!pageElement) {
      return false;
    }
    const rect = pageElement.getBoundingClientRect();
    const scrollContainer =
      this.compareScrollContainer ??
      this.resolveScrollContainer(this.comparePdfViewerHost?.nativeElement);
    if (this.scrollViewerToRect(rect, scrollContainer)) {
      return true;
    }
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return true;
  }

  private scrollViewerToRect(
    rect: DOMRect | null,
    containerOverride?: HTMLElement | null
  ): boolean {
    if (!this.isBrowser) {
      return false;
    }
    const container = containerOverride ?? this.viewerGrid?.nativeElement;
    if (!container || !rect) {
      return false;
    }
    const containerRect = container.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height) {
      return false;
    }
    const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0);
    const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    if (maxScrollLeft === 0 && maxScrollTop === 0) {
      return false;
    }
    const targetCenterX =
      rect.left - containerRect.left - container.clientLeft + container.scrollLeft + rect.width / 2;
    const targetCenterY =
      rect.top - containerRect.top - container.clientTop + container.scrollTop + rect.height / 2;
    const desiredCenterX = container.clientWidth / 2;
    const desiredCenterY = container.clientHeight / 2;
    const nextLeft = this.clamp(targetCenterX - desiredCenterX, 0, maxScrollLeft);
    const nextTop = this.clamp(targetCenterY - desiredCenterY, 0, maxScrollTop);
    container.scrollTo({ left: nextLeft, top: nextTop, behavior: 'smooth' });
    return true;
  }

  private shouldIgnoreSelection(event?: Event): boolean {
    const target = event?.target as HTMLElement | null;
    return Boolean(target?.closest('button, input, textarea, select, option'));
  }

  private syncDomRefs(): void {
    this.pageElementMap.clear();
    this.bindScrollContainer('base');
    const scrollOffsets = this.getScrollOffsets(this.pdfScrollContainer);
    const overlays = this.buildPageOverlays(
      this.pdfViewerHost?.nativeElement,
      this.pagesHost?.nativeElement,
      this.pageElementMap,
      scrollOffsets
    );
    this.pageOverlays.set(overlays);
  }

  private syncCompareDomRefs(): void {
    this.comparePageElementMap.clear();
    this.bindScrollContainer('compare');
    const scrollOffsets = this.getScrollOffsets(this.compareScrollContainer);
    const overlays = this.buildPageOverlays(
      this.comparePdfViewerHost?.nativeElement,
      this.comparePagesHost?.nativeElement,
      this.comparePageElementMap,
      scrollOffsets
    );
    this.comparePageOverlays.set(overlays);
  }

  private bindScrollContainer(kind: 'base' | 'compare'): void {
    if (!this.isBrowser) {
      return;
    }
    const viewerHost =
      kind === 'base' ? this.pdfViewerHost?.nativeElement : this.comparePdfViewerHost?.nativeElement;
    const pagesHost =
      kind === 'base' ? this.pagesHost?.nativeElement : this.comparePagesHost?.nativeElement;
    const container = this.resolveScrollContainer(viewerHost);
    const current = kind === 'base' ? this.pdfScrollContainer : this.compareScrollContainer;
    const handler = kind === 'base' ? this.handlePdfScroll : this.handleCompareScroll;

    if (current && current !== container) {
      current.removeEventListener('scroll', handler);
    }
    if (container && container !== current) {
      container.addEventListener('scroll', handler, { passive: true });
    }

    if (kind === 'base') {
      this.pdfScrollContainer = container;
    } else {
      this.compareScrollContainer = container;
    }

    if (container) {
      this.updateScrollOffsets(container, pagesHost);
    }
    if (
      kind === 'compare' &&
      this.isCompareActive() &&
      this.pdfScrollContainer &&
      this.compareScrollContainer
    ) {
      this.syncScrollPositions('base');
    }
  }

  private clearScrollContainer(kind: 'base' | 'compare'): void {
    const container = kind === 'base' ? this.pdfScrollContainer : this.compareScrollContainer;
    const handler = kind === 'base' ? this.handlePdfScroll : this.handleCompareScroll;
    if (container) {
      container.removeEventListener('scroll', handler);
    }
    if (kind === 'base') {
      this.pdfScrollContainer = null;
      if (this.pdfScrollRaf !== null && this.isBrowser) {
        cancelAnimationFrame(this.pdfScrollRaf);
      }
      this.pdfScrollRaf = null;
    } else {
      this.compareScrollContainer = null;
      if (this.compareScrollRaf !== null && this.isBrowser) {
        cancelAnimationFrame(this.compareScrollRaf);
      }
      this.compareScrollRaf = null;
    }
  }

  private resolveScrollContainer(viewerHost: HTMLElement | undefined): HTMLElement | null {
    if (!viewerHost) {
      return null;
    }
    const custom = viewerHost.querySelector('.viewer-shell__pdf-scroll') as HTMLElement | null;
    if (custom) {
      return custom;
    }
    const legacy = viewerHost.querySelector('.ng2-pdf-viewer-container') as HTMLElement | null;
    return legacy ?? viewerHost;
  }

  private getScrollOffsets(container: HTMLElement | null): { left: number; top: number } {
    if (!container) {
      return { left: 0, top: 0 };
    }
    return { left: container.scrollLeft, top: container.scrollTop };
  }

  private updateScrollOffsets(container: HTMLElement, pagesHost: HTMLElement | undefined): void {
    if (!pagesHost) {
      return;
    }
    pagesHost.style.setProperty('--pdf-scroll-left', `${container.scrollLeft}px`);
    pagesHost.style.setProperty('--pdf-scroll-top', `${container.scrollTop}px`);
  }

  private scheduleScrollSync(kind: 'base' | 'compare'): void {
    if (!this.isBrowser) {
      return;
    }
    const container = kind === 'base' ? this.pdfScrollContainer : this.compareScrollContainer;
    const pagesHost =
      kind === 'base' ? this.pagesHost?.nativeElement : this.comparePagesHost?.nativeElement;
    if (!container || !pagesHost) {
      return;
    }
    const currentRaf = kind === 'base' ? this.pdfScrollRaf : this.compareScrollRaf;
    if (currentRaf !== null) {
      return;
    }
    const rafId = requestAnimationFrame(() => {
      if (kind === 'base') {
        this.pdfScrollRaf = null;
      } else {
        this.compareScrollRaf = null;
      }
      this.updateScrollOffsets(container, pagesHost);
      if (!this.isSyncingScroll) {
        this.syncScrollPositions(kind);
      }
    });
    if (kind === 'base') {
      this.pdfScrollRaf = rafId;
    } else {
      this.compareScrollRaf = rafId;
    }
  }

  private syncScrollPositions(source: 'base' | 'compare'): void {
    if (!this.isCompareActive()) {
      return;
    }
    const sourceContainer = source === 'base' ? this.pdfScrollContainer : this.compareScrollContainer;
    const targetContainer = source === 'base' ? this.compareScrollContainer : this.pdfScrollContainer;
    const targetPagesHost =
      source === 'base' ? this.comparePagesHost?.nativeElement : this.pagesHost?.nativeElement;
    if (!sourceContainer || !targetContainer) {
      return;
    }
    this.isSyncingScroll = true;
    targetContainer.scrollLeft = sourceContainer.scrollLeft;
    targetContainer.scrollTop = sourceContainer.scrollTop;
    this.updateScrollOffsets(targetContainer, targetPagesHost);
    requestAnimationFrame(() => {
      this.isSyncingScroll = false;
    });
  }

  private isCompareActive(): boolean {
    return this.flags.compare && Boolean(this.compare.compareTargetSource());
  }

  private teardownScrollListeners(): void {
    this.clearScrollContainer('base');
    this.clearScrollContainer('compare');
    this.isSyncingScroll = false;
  }

  private buildPageOverlays(
    viewerHost: HTMLElement | undefined,
    pagesHost: HTMLElement | undefined,
    pageMap: Map<number, HTMLElement>,
    scrollOffsets: { left: number; top: number }
  ): PageOverlay[] {
    const pageElements = this.collectPdfPageElements(viewerHost);
    pageElements.forEach((pageElement) => {
      const pageNumber = this.readPageNumber(pageElement);
      if (pageNumber) {
        pageMap.set(pageNumber, pageElement);
      }
    });
    if (!pagesHost) {
      return [];
    }
    const hostRect = pagesHost.getBoundingClientRect();
    if (!hostRect.width || !hostRect.height) {
      return [];
    }
    const overlays: PageOverlay[] = [];
    pageElements.forEach((pageElement) => {
      const pageNumber = this.readPageNumber(pageElement);
      if (!pageNumber) {
        return;
      }
      const rect = pageElement.getBoundingClientRect();
      overlays.push({
        pageNumber,
        width: rect.width,
        height: rect.height,
        left: rect.left - hostRect.left + scrollOffsets.left,
        top: rect.top - hostRect.top + scrollOffsets.top
      });
    });
    overlays.sort((a, b) => a.pageNumber - b.pageNumber);
    return overlays;
  }

  private collectPdfPageElements(viewerHost: HTMLElement | undefined): HTMLElement[] {
    if (!viewerHost) {
      return [];
    }
    const root = viewerHost.querySelector('.pdfViewer') ?? viewerHost;
    return Array.from(root.querySelectorAll('.page')) as HTMLElement[];
  }

  private readPageNumber(pageElement: HTMLElement): number | null {
    const value =
      pageElement.dataset['pageNumber'] ??
      pageElement.getAttribute('data-page-number') ??
      pageElement.dataset['page'];
    const pageNumber = Number(value);
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
      return null;
    }
    return pageNumber;
  }

  private resolvePageNumberFromEvent(
    event: MouseEvent,
    pageMap: Map<number, HTMLElement>
  ): number | null {
    const target = event.target as HTMLElement | null;
    const pageElement = target?.closest('.page') as HTMLElement | null;
    const pageNumber = pageElement ? this.readPageNumber(pageElement) : null;
    if (pageNumber) {
      return pageNumber;
    }
    return this.hitTestPageNumber(event.clientX, event.clientY, pageMap);
  }

  private hitTestPageNumber(
    clientX: number,
    clientY: number,
    pageMap: Map<number, HTMLElement>
  ): number | null {
    for (const [pageNumber, pageElement] of pageMap.entries()) {
      const rect = pageElement.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return pageNumber;
      }
    }
    return null;
  }

  private resolveTextLayerElement(
    pageNumber: number,
    event: CustomEvent,
    pageMap: Map<number, HTMLElement>
  ): HTMLElement | null {
    const source = (event as {
      source?: {
        textLayer?: { div?: HTMLElement; textLayerDiv?: HTMLElement };
        textLayerDiv?: HTMLElement;
        div?: HTMLElement;
      };
    }).source;
    if (source?.textLayer?.div) {
      return source.textLayer.div;
    }
    if (source?.textLayer?.textLayerDiv) {
      return source.textLayer.textLayerDiv;
    }
    if (source?.textLayerDiv) {
      return source.textLayerDiv;
    }
    if (source?.div) {
      const candidate = source.div.querySelector('.textLayer') as HTMLElement | null;
      if (candidate) {
        return candidate;
      }
    }
    const target = event.target as HTMLElement | null;
    if (target) {
      if (target.classList.contains('textLayer')) {
        return target;
      }
      const candidate = target.querySelector('.textLayer') as HTMLElement | null;
      if (candidate) {
        return candidate;
      }
    }
    const pageElement = pageMap.get(pageNumber);
    return (pageElement?.querySelector('.textLayer') as HTMLElement | null) ?? null;
  }

  private resolveSelectionElement(node: Node | null | undefined): Element | null {
    if (!node) {
      return null;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      return node as Element;
    }
    return node.parentElement ?? null;
  }

  private resolveCssVar(value: string): string {
    const match = value.trim().match(/^var\((--[^),]+)(?:,[^)]+)?\)$/);
    if (!match || !this.isBrowser || typeof document === 'undefined') {
      return value;
    }
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]);
    return resolved.trim() || value;
  }

  private parseColorToRgba(
    value: string
  ): { r: number; g: number; b: number; a: number } | null {
    const trimmed = this.resolveCssVar(value).trim();
    const rgbMatch = trimmed.match(/^rgba?\((.+)\)$/i);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(',').map((part) => part.trim());
      if (parts.length < 3) {
        return null;
      }
      const r = this.parseColorChannel(parts[0]);
      const g = this.parseColorChannel(parts[1]);
      const b = this.parseColorChannel(parts[2]);
      if (r === null || g === null || b === null) {
        return null;
      }
      const alphaRaw = parts[3];
      const alpha = alphaRaw === undefined ? 1 : Number.parseFloat(alphaRaw);
      if (!Number.isFinite(alpha)) {
        return null;
      }
      return { r, g, b, a: this.clamp(alpha, 0, 1) };
    }

    const hexMatch = trimmed.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!hexMatch) {
      return null;
    }
    const hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  private parseColorChannel(value: string): number | null {
    if (value.endsWith('%')) {
      const percentage = Number.parseFloat(value.slice(0, -1));
      if (!Number.isFinite(percentage)) {
        return null;
      }
      return Math.round(this.clamp(percentage, 0, 100) * 2.55);
    }
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return Math.round(this.clamp(numeric, 0, 255));
  }

  private resolveTextLayerFromSelection(
    selection: Selection
  ): { layer: HTMLElement; pageNumber: number } | null {
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const rangeElement = this.resolveSelectionElement(range?.commonAncestorContainer);
    const anchorElement = this.resolveSelectionElement(selection.anchorNode);
    const focusElement = this.resolveSelectionElement(selection.focusNode);
    const layerCandidates = [
      rangeElement?.closest('.textLayer') as HTMLElement | null,
      anchorElement?.closest('.textLayer') as HTMLElement | null,
      focusElement?.closest('.textLayer') as HTMLElement | null
    ].filter((candidate): candidate is HTMLElement => Boolean(candidate));
    const layer = layerCandidates[0];
    if (!layer) {
      return null;
    }
    if (layerCandidates.some((candidate) => candidate !== layer)) {
      return null;
    }
    if (!this.selectionMatchesLayer(selection, layer)) {
      return null;
    }
    const pageNumber = this.resolvePageNumberFromLayer(layer);
    if (!pageNumber) {
      return null;
    }
    this.textLayerElementMap.set(pageNumber, layer);
    const layout = this.captureTextLayoutFromDom(pageNumber, layer);
    if (layout) {
      this.textLayouts.set(pageNumber, layout);
      this.renderedTextLayers.add(pageNumber);
    }
    return { layer, pageNumber };
  }

  private rebuildTextLayoutsFromDom(force = false): void {
    for (const [pageNumber, layer] of this.textLayerElementMap.entries()) {
      if (!force && this.renderedTextLayers.has(pageNumber)) {
        continue;
      }
      const layout = this.captureTextLayoutFromDom(pageNumber, layer);
      if (layout) {
        this.textLayouts.set(pageNumber, layout);
        this.renderedTextLayers.add(pageNumber);
      }
    }
  }

  private collectSelectionRectsByPage(selection: Selection): PageSelectionRects[] {
    if (!this.isBrowser || typeof document === 'undefined') {
      return [];
    }
    if (selection.isCollapsed || selection.rangeCount === 0) {
      return [];
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return [];
    }
    const clientRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    if (clientRects.length === 0) {
      return [];
    }

    const pages: Array<{ pageNumber: number; rect: DOMRect }> = [];
    const seenPages = new Set<number>();
    const pushPage = (pageNumber: number | null, rect: DOMRect | null): void => {
      if (!pageNumber || !rect || !rect.width || !rect.height) {
        return;
      }
      if (seenPages.has(pageNumber)) {
        return;
      }
      pages.push({ pageNumber, rect });
      seenPages.add(pageNumber);
    };

    for (const [pageNumber, pageElement] of this.pageElementMap.entries()) {
      pushPage(pageNumber, pageElement.getBoundingClientRect());
    }

    this.collectPdfPageElements(this.pdfViewerHost?.nativeElement).forEach((pageElement) => {
      const pageNumber = this.readPageNumber(pageElement);
      pushPage(pageNumber, pageElement.getBoundingClientRect());
      if (pageNumber && !this.pageElementMap.has(pageNumber)) {
        this.pageElementMap.set(pageNumber, pageElement);
      }
    });

    if (pages.length === 0) {
      return [];
    }

    const grouped = new Map<number, HighlightRect[]>();
    clientRects.forEach((clientRect) => {
      const centerX = clientRect.left + clientRect.width / 2;
      const centerY = clientRect.top + clientRect.height / 2;
      const page = pages.find(
        (candidate) =>
          centerX >= candidate.rect.left &&
          centerX <= candidate.rect.right &&
          centerY >= candidate.rect.top &&
          centerY <= candidate.rect.bottom
      );
      if (!page) {
        return;
      }
      const rect = this.normalizeRect(clientRect, page.rect);
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const list = grouped.get(page.pageNumber);
      if (list) {
        list.push(rect);
      } else {
        grouped.set(page.pageNumber, [rect]);
      }
    });

    return Array.from(grouped.entries())
      .map(([pageNumber, rects]) => ({ pageNumber, rects }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }

  private resolveSelectionContext(pageNumber?: number): SelectionContext | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const resolved = this.resolveTextLayerFromSelection(selection);
    if (!resolved) {
      if (!pageNumber) {
        return null;
      }
      let layer = this.textLayerElementMap.get(pageNumber) ?? null;
      let pageElement = this.pageElementMap.get(pageNumber) ?? null;
      if (!pageElement) {
        pageElement = this.resolvePageElement(
          pageNumber,
          this.pageElementMap,
          this.pdfViewerHost?.nativeElement
        );
      }
      if (!layer && pageElement) {
        layer = pageElement.querySelector('.textLayer') as HTMLElement | null;
      }
      if (!layer || !this.selectionMatchesLayer(selection, layer)) {
        return null;
      }
      this.textLayerElementMap.set(pageNumber, layer);
      const layout = this.captureTextLayoutFromDom(pageNumber, layer);
      if (layout) {
        this.textLayouts.set(pageNumber, layout);
        this.renderedTextLayers.add(pageNumber);
      }
      return { selection, pageNumber };
    }
    return { selection, pageNumber: resolved.pageNumber };
  }

  private resolvePageNumberFromLayer(layer: HTMLElement): number | null {
    const pageElement =
      (layer.closest('[data-page-number], [data-page]') as HTMLElement | null) ??
      (layer.closest('.page') as HTMLElement | null);
    if (pageElement) {
      const pageNumber = this.readPageNumber(pageElement);
      if (pageNumber) {
        return pageNumber;
      }
    }
    for (const [pageNumber, pageElement] of this.pageElementMap.entries()) {
      if (pageElement.contains(layer)) {
        return pageNumber;
      }
    }
    return null;
  }

  private selectionMatchesLayer(selection: Selection, layer: HTMLElement): boolean {
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const startNode = range?.startContainer ?? selection.anchorNode;
    const endNode = range?.endContainer ?? selection.focusNode;
    if (!startNode || !endNode) {
      return false;
    }
    return layer.contains(startNode) && layer.contains(endNode);
  }

  private getSelectionOffsets(
    pageNumber: number,
    selection: Selection
  ): { start: number; end: number } | null {
    const layer = this.textLayerElementMap.get(pageNumber);
    if (!layer) {
      return null;
    }
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let cursor = 0;
    let start: number | null = null;
    let end: number | null = null;
    while (node) {
      const textNode = node as Text;
      const length = textNode.textContent?.length ?? 0;
      if (node === selection.anchorNode) {
        start = cursor + selection.anchorOffset;
      }
      if (node === selection.focusNode) {
        end = cursor + selection.focusOffset;
      }
      cursor += length;
      node = walker.nextNode();
    }
    if (start === null || end === null) {
      return null;
    }
    return start <= end ? { start, end } : { start: end, end: start };
  }

  private createRangeFromOffsets(layer: HTMLElement, start: number, end: number): Range | null {
    if (start >= end) {
      return null;
    }
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let cursor = 0;
    let startNode: Text | null = null;
    let endNode: Text | null = null;
    let startOffset = 0;
    let endOffset = 0;
    while (node) {
      const textNode = node as Text;
      const length = textNode.textContent?.length ?? 0;
      if (startNode === null && cursor + length >= start) {
        startNode = textNode;
        startOffset = Math.max(start - cursor, 0);
      }
      if (cursor + length >= end) {
        endNode = textNode;
        endOffset = Math.max(end - cursor, 0);
        break;
      }
      cursor += length;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) {
      return null;
    }
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  private rectsFromOffsets(pageNumber: number, start: number, end: number): HighlightRect[] {
    const layout = this.textLayouts.get(pageNumber);
    if (!layout) {
      return [];
    }
    return this.rectsFromOffsetsInLayout(layout, start, end);
  }

  private rectsFromOffsetsInLayout(
    layout: PageTextLayout,
    start: number,
    end: number
  ): HighlightRect[] {
    if (start === end) {
      return [];
    }
    const rects: HighlightRect[] = [];
    layout.spans.forEach((span) => {
      if (span.end <= start || span.start >= end) {
        return;
      }
      const spanLength = span.end - span.start || 1;
      const overlapStart = Math.max(start, span.start);
      const overlapEnd = Math.min(end, span.end);
      const startRatio = (overlapStart - span.start) / spanLength;
      const endRatio = (overlapEnd - span.start) / spanLength;
      const widthRatio = Math.max(endRatio - startRatio, 0);
      span.rects.forEach((rect) => {
        const left = rect.left + rect.width * startRatio;
        const width = widthRatio > 0 ? rect.width * widthRatio : rect.width;
        rects.push({
          left: Number(left.toFixed(4)),
          top: rect.top,
          width: Number(width.toFixed(4)),
          height: rect.height
        });
      });
    });
    return rects.filter((rect) => rect.width > 0 && rect.height > 0);
  }

  private rectsFromRange(range: Range, pageElement: HTMLElement): HighlightRect[] {
    const containerRect = pageElement.getBoundingClientRect();
    return Array.from(range.getClientRects())
      .map((clientRect) => this.normalizeRect(clientRect, containerRect))
      .filter((rect) => rect.width > 0 && rect.height > 0);
  }

  private normalizeRect(rect: DOMRect, container: DOMRect): HighlightRect {
    const left = ((rect.left - container.left) / container.width) * 100;
    const top = ((rect.top - container.top) / container.height) * 100;
    const width = (rect.width / container.width) * 100;
    const height = (rect.height / container.height) * 100;
    return {
      left: Number(left.toFixed(4)),
      top: Number(top.toFixed(4)),
      width: Number(width.toFixed(4)),
      height: Number(height.toFixed(4))
    };
  }

  private collectRectsForQuery(pageNumber: number, query: string): HighlightRect[] {
    const layout = this.textLayouts.get(pageNumber);
    const normalized = query.toLowerCase();
    if (layout) {
      const text = layout.text.toLowerCase();
      const rects: HighlightRect[] = [];
      let idx = text.indexOf(normalized);
      while (idx !== -1) {
        rects.push(...this.rectsFromOffsets(pageNumber, idx, idx + query.length));
        idx = text.indexOf(normalized, idx + normalized.length);
      }
      if (rects.length) {
        return rects;
      }
    }
    const layer = this.textLayerElementMap.get(pageNumber);
    const pageElement = this.pageElementMap.get(pageNumber);
    if (!layer || !pageElement) {
      return [];
    }
    return this.collectRectsFromDom(layer, pageElement, normalized, query.length);
  }

  private collectRectsFromDom(
    layer: HTMLElement,
    pageElement: HTMLElement,
    normalizedQuery: string,
    queryLength: number
  ): HighlightRect[] {
    const rects: HighlightRect[] = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const content = textNode.textContent ?? '';
      const lowered = content.toLowerCase();
      let idx = lowered.indexOf(normalizedQuery);
      while (idx !== -1) {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + queryLength);
        rects.push(...this.rectsFromRange(range, pageElement));
        idx = lowered.indexOf(normalizedQuery, idx + queryLength);
      }
      node = walker.nextNode();
    }
    return rects;
  }

  private captureTextLayoutFromDom(
    pageNumber: number,
    layer: HTMLElement,
    hostElement?: HTMLElement
  ): PageTextLayout | null {
    const pageElement = hostElement ?? this.pageElementMap.get(pageNumber) ?? layer.parentElement;
    const containerRect = pageElement?.getBoundingClientRect();
    if (!containerRect || !containerRect.width || !containerRect.height) {
      return null;
    }
    const spans: TextSpanRects[] = [];
    const textParts: string[] = [];
    let cursor = 0;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const content = textNode.textContent ?? '';
      const length = content.length;
      if (length > 0) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rects = Array.from(range.getClientRects())
          .map((rect) => this.normalizeRect(rect, containerRect))
          .filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length) {
          spans.push({
            start: cursor,
            end: cursor + length,
            text: content,
            rects
          });
        }
      }
      textParts.push(content);
      cursor += length;
      node = walker.nextNode();
    }
    return {
      page: pageNumber,
      width: containerRect.width,
      height: containerRect.height,
      text: textParts.join(''),
      spans
    };
  }

  private updateAllDiffHighlights(): void {
    const result = this.compare.result();
    if (!this.compare.compareTargetSource() || !result) {
      this.clearDiffHighlights();
      return;
    }
    this.clearDiffHighlights();
    for (const pageNumber of result.changedPages) {
      this.updateDiffHighlightsForPage(pageNumber);
    }
  }

  private updateDiffHighlightsForPage(pageNumber: number): void {
    const result = this.compare.result();
    if (!this.compare.compareTargetSource() || !result) {
      this.setDiffHighlights(pageNumber, [], []);
      return;
    }
    if (!result.changedPages.includes(pageNumber)) {
      this.setDiffHighlights(pageNumber, [], []);
      return;
    }
    const baseExists = pageNumber <= this.pdf.pageCount();
    const targetExists = pageNumber <= this.compare.compareTargetPageCount();
    const baseLayout = baseExists ? this.textLayouts.get(pageNumber) ?? null : null;
    const targetLayout = targetExists ? this.compareTextLayouts.get(pageNumber) ?? null : null;

    if (baseExists && targetExists) {
      if (!baseLayout || !targetLayout) {
        return;
      }
      const ranges = this.computeDiffRanges(baseLayout.text, targetLayout.text);
      const baseRects = this.buildDiffHighlightRects(baseLayout, ranges.base);
      const targetRects = this.buildDiffHighlightRects(targetLayout, ranges.target);
      this.setDiffHighlights(pageNumber, baseRects, targetRects);
      return;
    }

    if (baseExists) {
      if (!baseLayout) {
        return;
      }
      const baseRects = this.buildDiffHighlightRects(baseLayout, [
        { start: 0, end: baseLayout.text.length }
      ]);
      this.setDiffHighlights(pageNumber, baseRects, []);
      return;
    }

    if (targetExists) {
      if (!targetLayout) {
        return;
      }
      const targetRects = this.buildDiffHighlightRects(targetLayout, [
        { start: 0, end: targetLayout.text.length }
      ]);
      this.setDiffHighlights(pageNumber, [], targetRects);
    }
  }

  private setDiffHighlights(
    pageNumber: number,
    baseRects: HighlightRect[],
    targetRects: HighlightRect[]
  ): void {
    this.diffHighlights.update((current) => {
      const next = { ...current };
      if (baseRects.length) {
        next[pageNumber] = baseRects;
      } else {
        delete next[pageNumber];
      }
      return next;
    });
    this.compareDiffHighlights.update((current) => {
      const next = { ...current };
      if (targetRects.length) {
        next[pageNumber] = targetRects;
      } else {
        delete next[pageNumber];
      }
      return next;
    });
  }

  private clearDiffHighlights(): void {
    this.diffHighlights.set({});
    this.compareDiffHighlights.set({});
  }

  private buildDiffHighlightRects(
    layout: PageTextLayout,
    ranges: OffsetRange[]
  ): HighlightRect[] {
    const rects: HighlightRect[] = [];
    ranges.forEach((range) => {
      rects.push(...this.rectsFromOffsetsInLayout(layout, range.start, range.end));
    });
    return rects;
  }

  private computeDiffRanges(baseText: string, targetText: string): DiffRanges {
    if (!baseText && !targetText) {
      return { base: [], target: [] };
    }
    if (!baseText) {
      return {
        base: [],
        target: targetText ? [{ start: 0, end: targetText.length }] : []
      };
    }
    if (!targetText) {
      return {
        base: baseText ? [{ start: 0, end: baseText.length }] : [],
        target: []
      };
    }

    const baseTokens = this.tokenizeText(baseText);
    const targetTokens = this.tokenizeText(targetText);
    if (!baseTokens.length || !targetTokens.length) {
      return this.computeSimpleDiffRanges(baseText, targetText);
    }

    const matches = this.computeTokenMatches(baseTokens, targetTokens, this.diffCellLimit);
    if (!matches) {
      return this.computeSimpleDiffRanges(baseText, targetText);
    }

    return {
      base: this.buildRangesFromMatches(baseTokens, matches.baseMatches),
      target: this.buildRangesFromMatches(targetTokens, matches.targetMatches)
    };
  }

  private computeSimpleDiffRanges(baseText: string, targetText: string): DiffRanges {
    if (!baseText && !targetText) {
      return { base: [], target: [] };
    }
    if (!baseText) {
      return {
        base: [],
        target: targetText ? [{ start: 0, end: targetText.length }] : []
      };
    }
    if (!targetText) {
      return {
        base: baseText ? [{ start: 0, end: baseText.length }] : [],
        target: []
      };
    }

    const maxPrefix = Math.min(baseText.length, targetText.length);
    let prefix = 0;
    while (prefix < maxPrefix && baseText[prefix] === targetText[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < baseText.length - prefix &&
      suffix < targetText.length - prefix &&
      baseText[baseText.length - 1 - suffix] === targetText[targetText.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const baseStart = prefix;
    const baseEnd = baseText.length - suffix;
    const targetStart = prefix;
    const targetEnd = targetText.length - suffix;
    return {
      base: baseStart < baseEnd ? [{ start: baseStart, end: baseEnd }] : [],
      target: targetStart < targetEnd ? [{ start: targetStart, end: targetEnd }] : []
    };
  }

  private tokenizeText(text: string): TextToken[] {
    const tokens: TextToken[] = [];
    const regex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      tokens.push({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return tokens;
  }

  private computeTokenMatches(
    baseTokens: TextToken[],
    targetTokens: TextToken[],
    maxCells: number
  ): { baseMatches: boolean[]; targetMatches: boolean[] } | null {
    const baseMatches = new Array(baseTokens.length).fill(false);
    const targetMatches = new Array(targetTokens.length).fill(false);

    let start = 0;
    const baseLen = baseTokens.length;
    const targetLen = targetTokens.length;
    while (
      start < baseLen &&
      start < targetLen &&
      baseTokens[start].value === targetTokens[start].value
    ) {
      baseMatches[start] = true;
      targetMatches[start] = true;
      start += 1;
    }

    let endBase = baseLen - 1;
    let endTarget = targetLen - 1;
    while (
      endBase >= start &&
      endTarget >= start &&
      baseTokens[endBase].value === targetTokens[endTarget].value
    ) {
      baseMatches[endBase] = true;
      targetMatches[endTarget] = true;
      endBase -= 1;
      endTarget -= 1;
    }

    const baseMidLength = endBase - start + 1;
    const targetMidLength = endTarget - start + 1;
    if (baseMidLength <= 0 || targetMidLength <= 0) {
      return { baseMatches, targetMatches };
    }

    const cells = (baseMidLength + 1) * (targetMidLength + 1);
    if (cells > maxCells) {
      return null;
    }

    const cols = targetMidLength + 1;
    const dp = new Uint32Array((baseMidLength + 1) * cols);

    for (let i = 1; i <= baseMidLength; i += 1) {
      const baseToken = baseTokens[start + i - 1].value;
      for (let j = 1; j <= targetMidLength; j += 1) {
        const targetToken = targetTokens[start + j - 1].value;
        const index = i * cols + j;
        if (baseToken === targetToken) {
          dp[index] = dp[(i - 1) * cols + (j - 1)] + 1;
        } else {
          const up = dp[(i - 1) * cols + j];
          const left = dp[i * cols + (j - 1)];
          dp[index] = up >= left ? up : left;
        }
      }
    }

    let i = baseMidLength;
    let j = targetMidLength;
    while (i > 0 && j > 0) {
      const baseToken = baseTokens[start + i - 1].value;
      const targetToken = targetTokens[start + j - 1].value;
      if (baseToken === targetToken) {
        baseMatches[start + i - 1] = true;
        targetMatches[start + j - 1] = true;
        i -= 1;
        j -= 1;
        continue;
      }
      const up = dp[(i - 1) * cols + j];
      const left = dp[i * cols + (j - 1)];
      if (up >= left) {
        i -= 1;
      } else {
        j -= 1;
      }
    }

    return { baseMatches, targetMatches };
  }

  private buildRangesFromMatches(tokens: TextToken[], matches: boolean[]): OffsetRange[] {
    const ranges: OffsetRange[] = [];
    let rangeStart: number | null = null;
    let rangeEnd = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      if (!matches[i]) {
        if (rangeStart === null) {
          rangeStart = tokens[i].start;
        }
        rangeEnd = tokens[i].end;
        continue;
      }
      if (rangeStart !== null) {
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = null;
      }
    }
    if (rangeStart !== null) {
      ranges.push({ start: rangeStart, end: rangeEnd });
    }
    return ranges;
  }

  private async applySearchHighlights(query: string, skipRender = false): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      this.annotations.setSearchHighlights([]);
      return;
    }
    if (!skipRender) {
      this.rebuildTextLayoutsFromDom();
    }
    const markers: Marker[] = [];
    for (const [pageNumber] of this.textLayerElementMap.entries()) {
      const rects = this.collectRectsForQuery(pageNumber, trimmed);
      if (rects.length === 0) {
        continue;
      }
      markers.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `search-${pageNumber}-${Date.now()}`,
        page: pageNumber,
        label: `検索: ${trimmed}`,
        color: 'var(--color-highlight-search)',
        rects,
        source: 'search',
        text: trimmed
      });
    }
    this.annotations.setSearchHighlights(markers);
  }
}










