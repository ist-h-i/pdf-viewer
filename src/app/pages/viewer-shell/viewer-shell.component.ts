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
  ViewChildren,
  computed,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GlobalWorkerOptions, version as pdfJsVersion } from 'pdfjs-dist';
import { PdfViewerModule } from 'ng2-pdf-viewer';
import { FEATURE_FLAGS, FeatureFlags } from '../../core/feature-flags';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';
import {
  CommentCard,
  CommentMessage,
  HighlightRect,
  Marker,
  PageTextLayout,
  PdfPageRender,
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
  canHighlight: boolean;
  selectionText: string;
  clickOffset: { x: number; y: number } | null;
};

type CommentCalloutLayout = {
  bubbleX: number;
  bubbleY: number;
  lineLength: number;
  lineAngle: number;
  align: 'left' | 'right';
};

type CommentLayoutSettings = {
  bubbleWidth: number;
  bubbleHeight: number;
  pointerCenter: number;
};

type CommentResizeAxis = 'bubbleWidth' | 'bubbleHeight';

type CommentResizeState = {
  type: 'comment-resize';
  id: string;
  axis: CommentResizeAxis;
  startClientX: number;
  startClientY: number;
  startSize: number;
};

type CommentPointerState = {
  type: 'comment-pointer';
  id: string;
  bubbleElement: HTMLElement;
};

type DragState =
  | {
      type: 'comment';
      id: string;
      page: number;
      offsetX: number;
      offsetY: number;
    }
  | {
      type: 'marker';
      id: string;
      page: number;
      startX: number;
      startY: number;
      rects: HighlightRect[];
    }
  | CommentResizeState
  | CommentPointerState;

@Component({
  selector: 'app-viewer-shell',
  standalone: true,
  imports: [CommonModule, FormsModule, PdfViewerModule],
  templateUrl: './viewer-shell.component.html',
  styleUrl: './viewer-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ViewerShellComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('pageWrapper') private pageWrappers!: QueryList<ElementRef<HTMLElement>>;

  protected readonly searchQuery = signal('');
  protected readonly selectedOcrPage = signal(1);
  protected readonly contextMenu = signal<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    pageNumber: null,
    canHighlight: false,
    selectionText: '',
    clickOffset: null
  });
  protected readonly replyDrafts = signal<Record<string, string>>({});
  protected readonly selectedMarkerId = signal<string | null>(null);
  protected readonly selectedCommentId = signal<string | null>(null);
  protected readonly showObjects = signal(true);
  protected readonly commentLayoutSettings = signal<CommentLayoutSettings>({
    bubbleWidth: 240,
    bubbleHeight: 0,
    pointerCenter: 50
  });

  protected readonly hasPdf = computed(() => this.pdf.pageCount() > 0);
  protected readonly zoomPercent = computed(() => Math.round(this.pdf.zoom() * 100));

  protected pdfSource(): Uint8Array | undefined {
    console.log('pdfSource called', this.pdf.getCurrentFileSource() ?? undefined);
    return this.pdf.getCurrentFileSource() ?? undefined;
  }

  private readonly pageElementMap = new Map<number, HTMLElement>();
  private readonly textLayerElementMap = new Map<number, HTMLElement>();
  private readonly renderedTextLayers = new Set<number>();
  private readonly textLayouts = new Map<number, PageTextLayout>();
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
    this.pageWrappers.changes.subscribe(() => this.syncDomRefs());
  }

  ngOnDestroy(): void {
    this.teardownDragListeners();
  }

  protected onPageRendered(_pageNumber: number, _event: CustomEvent): void {
    this.syncDomRefs();
  }

  protected onTextLayerRendered(pageNumber: number, event: CustomEvent): void {
    const layer = event.target as HTMLElement | null;
    if (!layer) {
      return;
    }
    this.textLayerElementMap.set(pageNumber, layer);
    const layout = this.captureTextLayoutFromDom(pageNumber, layer);
    if (layout) {
      this.textLayouts.set(pageNumber, layout);
      this.renderedTextLayers.add(pageNumber);
    }
  }

  protected pageAnchorId(page: number): string {
    return `page-${page}`;
  }

  protected markersFor(page: number): Marker[] {
    return this.annotations.markersByPage(page);
  }

  protected commentsFor(page: number): CommentCard[] {
    return this.annotations.commentsByPage(page);
  }

  protected trackPage(_index: number, page: PdfPageRender): number {
    return page.pageNumber;
  }

  protected trackMarker(_index: number, marker: Marker): string {
    return marker.id;
  }

  protected trackComment(_index: number, comment: CommentCard): string {
    return comment.id;
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

  protected addReply(commentId: string): void {
    const text = this.replyDraft(commentId).trim();
    if (!text) {
      return;
    }
    this.annotations.addReply(commentId, text);
    this.replyDrafts.update(({ [commentId]: _removed, ...rest }) => rest);
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

  protected focusMarker(marker: Marker, event?: Event): void {
    if (this.shouldIgnoreSelection(event)) {
      return;
    }
    this.selectedMarkerId.set(marker.id);
    this.selectedCommentId.set(null);
    this.scrollToPage(marker.page);
  }

  protected focusComment(comment: CommentCard, event?: Event): void {
    if (this.shouldIgnoreSelection(event)) {
      return;
    }
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.scrollToPage(comment.page);
  }

  protected commentPreview(comment: CommentCard): string {
    return this.latestMessage(comment)?.text ?? 'コメント';
  }

  protected startCommentDrag(comment: CommentCard, event: PointerEvent): void {
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
      type: 'comment',
      id: comment.id,
      page: comment.page,
      offsetX: comment.x - pointer.x,
      offsetY: comment.y - pointer.y
    };
    this.selectedCommentId.set(comment.id);
    this.selectedMarkerId.set(null);
    this.attachDragListeners();
  }

  protected startMarkerDrag(marker: Marker, event: PointerEvent): void {
    if (event.button !== 0 || marker.source !== 'selection') {
      return;
    }
    const pageElement = this.pageElementMap.get(marker.page);
    if (!pageElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointer = this.normalizeCoordinates(event, pageElement);
    this.dragState = {
      type: 'marker',
      id: marker.id,
      page: marker.page,
      startX: pointer.x * 100,
      startY: pointer.y * 100,
      rects: marker.rects.map((rect) => ({ ...rect }))
    };
    this.selectedMarkerId.set(marker.id);
    this.selectedCommentId.set(null);
    this.attachDragListeners();
  }

  protected calloutLayout(comment: CommentCard): CommentCalloutLayout {
    const pushLeft = comment.x > 0.55;
    const pushUp = comment.y > 0.6;
    const baseX = 120;
    const baseY = 80;
    const bubbleX = (pushLeft ? -1 : 1) * (baseX + Math.abs(comment.x - 0.5) * 60);
    const bubbleY = (pushUp ? -1 : 1) * (baseY + Math.abs(comment.y - 0.5) * 40);
    const distance = Math.sqrt(bubbleX * bubbleX + bubbleY * bubbleY);
    const lineLength = Math.max(distance - 16, 0);
    const lineAngle = (Math.atan2(bubbleY, bubbleX) * 180) / Math.PI;
    return {
      bubbleX,
      bubbleY,
      lineLength,
      lineAngle,
      align: pushLeft ? 'right' : 'left'
    };
  }

  protected startCommentResize(comment: CommentCard, axis: CommentResizeAxis, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const bubbleElement = (event.target as HTMLElement).closest('.comment-bubble') as HTMLElement | null;
    if (!bubbleElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = bubbleElement.getBoundingClientRect();
    const startSize = axis === 'bubbleWidth' ? rect.width : rect.height;
    this.dragState = {
      type: 'comment-resize',
      id: comment.id,
      axis,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSize
    };
    this.attachDragListeners();
  }

  protected startPointerAdjust(comment: CommentCard, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const bubbleElement = (event.target as HTMLElement).closest('.comment-bubble') as HTMLElement | null;
    if (!bubbleElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dragState = {
      type: 'comment-pointer',
      id: comment.id,
      bubbleElement
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
    if (key === 'pointerCenter') {
      clamped = this.clamp(value, 0, 100);
    } else if (key === 'bubbleWidth') {
      clamped = this.clamp(value, 160, 520);
    } else {
      clamped = this.clamp(value, 0, 420);
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
    this.selectedOcrPage.set(1);
  }

  protected async onCompareFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    await this.compare.compareWith(file);
    input.value = '';
  }

  protected async performSearch(): Promise<void> {
    await this.search.search(this.searchQuery());
    await this.applySearchHighlights(this.searchQuery());
  }

  protected clearSearch(): void {
    this.searchQuery.set('');
    this.search.clear();
    this.annotations.setSearchHighlights([]);
  }

  protected toggleObjects(): void {
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

  protected downloadPdf(): void {
    if (!this.hasPdf()) {
      return;
    }
    this.pdf.downloadCurrentPdf();
  }

  protected openContextMenu(page: PdfPageRender, event: MouseEvent): void {
    if (!this.flags.comments && !this.flags.markers) {
      return;
    }
    event.preventDefault();
    const pageElement = this.pageElementMap.get(page.pageNumber);
    const selection = this.getValidSelection(page.pageNumber);
    const clickOffset = pageElement ? this.normalizeCoordinates(event, pageElement) : null;
    const canHighlight = this.flags.markers && Boolean(selection);
    const selectionText = canHighlight ? selection?.toString() ?? '' : '';
    this.contextMenu.set({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      pageNumber: page.pageNumber,
      canHighlight,
      selectionText,
      clickOffset
    });
  }

  protected addHighlightFromSelection(): void {
    if (!this.flags.markers) {
      this.closeContextMenu();
      return;
    }
    const state = this.contextMenu();
    if (!state.pageNumber) {
      return;
    }
    const selection = this.getValidSelection(state.pageNumber);
    const pageElement = this.pageElementMap.get(state.pageNumber);
    if (!selection || !pageElement) {
      this.closeContextMenu();
      return;
    }
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range) {
      this.closeContextMenu();
      return;
    }
    const offsets = this.getSelectionOffsets(state.pageNumber, selection);
    const cachedRects =
      offsets && offsets.end > offsets.start
        ? this.rectsFromOffsets(state.pageNumber, offsets.start, offsets.end)
        : [];
    const rects =
      cachedRects.length > 0 ? cachedRects : this.rectsFromRange(range, pageElement);
    if (rects.length === 0) {
      this.closeContextMenu();
      return;
    }
    const text = selection.toString() || '手動ハイライト';
    this.annotations.addMarker(state.pageNumber, rects, text, '#ffc0cb', 'selection', text);
    selection.removeAllRanges();
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
    this.annotations.addComment(state.pageNumber, x, y);
    this.closeContextMenu();
  }

  protected closeContextMenu(): void {
    this.contextMenu.set({
      visible: false,
      x: 0,
      y: 0,
      pageNumber: null,
      canHighlight: false,
      selectionText: '',
      clickOffset: null
    });
  }

  protected updateMarker(id: string, label: string, color: string): void {
    this.annotations.updateMarker(id, { label, color });
  }

  protected updateComment(id: string, text: string): void {
    this.annotations.updateComment(id, text);
  }

  protected removeMarker(id: string): void {
    if (this.selectedMarkerId() === id) {
      this.selectedMarkerId.set(null);
    }
    this.annotations.removeMarker(id);
  }

  protected removeComment(id: string): void {
    if (this.selectedCommentId() === id) {
      this.selectedCommentId.set(null);
    }
    this.annotations.removeComment(id);
  }

  protected async runOcr(): Promise<void> {
    await this.ocr.runOcr(this.selectedOcrPage());
  }

  private resetFeatureStates(): void {
    this.searchQuery.set('');
    this.search.clear();
    this.annotations.reset();
    this.compare.reset();
    this.ocr.reset();
    this.selectedMarkerId.set(null);
    this.selectedCommentId.set(null);
    this.resetViewState();
  }

  private resetViewState(): void {
    this.renderedTextLayers.clear();
    this.pageElementMap.clear();
    this.textLayerElementMap.clear();
    this.textLayouts.clear();
    this.dragState = null;
    this.teardownDragListeners();
    this.closeContextMenu();
  }

  private async applyZoomChange(action: () => Promise<void> | void): Promise<void> {
    this.resetViewState();
    await action();
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

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragState) {
      return;
    }
    if (this.dragState.type === 'comment') {
      const pageElement = this.pageElementMap.get(this.dragState.page);
      if (!pageElement) {
        return;
      }
      const pointer = this.normalizeCoordinates(event, pageElement);
      const nextX = this.clamp01(pointer.x + this.dragState.offsetX);
      const nextY = this.clamp01(pointer.y + this.dragState.offsetY);
      this.annotations.moveComment(this.dragState.id, nextX, nextY);
      return;
    }
    if (this.dragState.type === 'marker') {
      const pageElement = this.pageElementMap.get(this.dragState.page);
      if (!pageElement) {
        return;
      }
      const pointer = this.normalizeCoordinates(event, pageElement);
      const dx = pointer.x * 100 - this.dragState.startX;
      const dy = pointer.y * 100 - this.dragState.startY;
      const rects = this.dragState.rects.map((rect) => this.shiftRect(rect, dx, dy));
      this.annotations.moveMarker(this.dragState.id, rects);
      return;
    }
    if (this.dragState.type === 'comment-resize') {
      const delta =
        this.dragState.axis === 'bubbleWidth'
          ? event.clientX - this.dragState.startClientX
          : event.clientY - this.dragState.startClientY;
      const raw = this.dragState.startSize + delta;
      const clamped =
        this.dragState.axis === 'bubbleWidth'
          ? this.clamp(raw, 160, 520)
          : this.clamp(raw, 40, 420);
      this.annotations.updateCommentLayout(this.dragState.id, {
        [this.dragState.axis]: Math.round(clamped)
      });
      return;
    }
    if (this.dragState.type === 'comment-pointer') {
      const rect = this.dragState.bubbleElement.getBoundingClientRect();
      if (rect.height === 0) {
        return;
      }
      const offsetY = event.clientY - rect.top;
      const normalized = (offsetY / rect.height) * 100;
      const pointerCenter = this.clamp(normalized, 0, 100);
      this.annotations.updateCommentLayout(this.dragState.id, { pointerCenter });
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

  private scrollToPage(pageNumber: number): void {
    const pageElement = this.pageElementMap.get(pageNumber);
    if (!pageElement) {
      return;
    }
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private shouldIgnoreSelection(event?: Event): boolean {
    const target = event?.target as HTMLElement | null;
    return Boolean(target?.closest('button, input, textarea, select, option'));
  }

  private syncDomRefs(): void {
    this.pageElementMap.clear();
    this.pageWrappers?.forEach((ref) => {
      const el = ref.nativeElement;
      const page = Number(el.dataset['page']);
      if (page) {
        this.pageElementMap.set(page, el);
      }
    });
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

  private getValidSelection(pageNumber: number): Selection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const layer = this.textLayerElementMap.get(pageNumber);
    if (!layer) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (
      !layer.contains(selection.anchorNode) ||
      !layer.contains(selection.focusNode) ||
      !layer.contains(range.commonAncestorContainer)
    ) {
      return null;
    }
    return selection;
  }

  private getSelectionOffsets(
    pageNumber: number,
    selection: Selection
  ): { start: number; end: number } | null {
    const layout = this.textLayouts.get(pageNumber);
    const layer = this.textLayerElementMap.get(pageNumber);
    if (!layout || !layer) {
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

  private rectsFromOffsets(pageNumber: number, start: number, end: number): HighlightRect[] {
    const layout = this.textLayouts.get(pageNumber);
    if (!layout || start === end) {
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

  private captureTextLayoutFromDom(pageNumber: number, layer: HTMLElement): PageTextLayout | null {
    const pageElement = this.pageElementMap.get(pageNumber) ?? layer.parentElement;
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
        color: '#ffeb3b',
        rects,
        source: 'search',
        text: trimmed
      });
    }
    this.annotations.setSearchHighlights(markers);
  }
}
