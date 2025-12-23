import { inject, Injectable, PLATFORM_ID, computed, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import type { PDFArray } from 'pdf-lib';
import {
  CommentCard,
  CommentMessage,
  HighlightRect,
  Marker,
  PageTextLayout,
  PdfAnnotationExport,
  PdfPageRender,
  TextSpanRects
} from '../../core/models';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';

type PdfDownloadOptions = {
  includeAnnotations?: boolean;
  annotations?: PdfAnnotationExport;
};

type PdfJsAnnotationData = {
  id?: string;
  subtype?: string;
  rect?: ArrayLike<number> | null;
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  contents?: string;
  title?: string;
  subject?: string;
  opacity?: number;
};

type PdfAnnotationImport = {
  markers: Marker[];
  comments: CommentCard[];
};

const DEFAULT_HIGHLIGHT_ALPHA = 0.4;
const DEFAULT_COMMENT_ICON_SIZE = 18;
const DEFAULT_COMMENT_COLOR: [number, number, number] = [1, 0.92, 0.23];
const DEFAULT_COMMENT_TITLE = 'Comment';
const DEFAULT_IMPORTED_COMMENT_TITLE = 'PDF Comment';
const DEFAULT_IMPORTED_HIGHLIGHT_LABEL = 'PDF Highlight';
const DEFAULT_IMPORTED_COMMENT_OFFSET = 0.12;

@Injectable({ providedIn: 'root' })
export class PdfFacadeService {
  private static readonly CSS_UNITS = 96 / 72;
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
  private pdfLibPromise: Promise<typeof import('pdf-lib')> | null = null;

  private readonly scale = signal(1.25);
  readonly zoom = this.scale.asReadonly();

  private readonly pdfDoc = signal<PDFDocumentProxy | null>(null);
  private readonly pages = signal<PdfPageRender[]>([]);
  private readonly loading = signal(false);
  private readonly error = signal<string | null>(null);
  private readonly currentName = signal<string | null>(null);
  private readonly textCache = new Map<number, string>();
  private readonly textLayouts = new Map<number, PageTextLayout>();
  private originalFileBytes: ArrayBuffer | null = null;
  private currentSourceUrl: string | null = null;

  readonly pageCount = computed(() => this.pdfDoc()?.numPages ?? 0);
  readonly renderedPages = this.pages.asReadonly();
  readonly isLoading = this.loading.asReadonly();
  readonly lastError = this.error.asReadonly();
  readonly pdfName = this.currentName.asReadonly();

  async loadFile(file: File): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.currentName.set(file.name);
    this.revokeSourceUrl();
    this.originalFileBytes = null;
    this.currentSourceUrl = null;
    let nextSourceUrl: string | null = null;
    try {
      if (!this.isBrowser) {
        this.error.set('PDF loading is only available in the browser.');
        return;
      }
      this.textCache.clear();
      this.textLayouts.clear();
      this.pages.set([]);
      const buffer = await file.arrayBuffer();
      this.originalFileBytes = buffer;
      const pdfjs = await this.ensurePdfJs();
      const doc = await pdfjs.getDocument({ data: buffer.slice(0) }).promise;
      nextSourceUrl = this.createObjectUrl(buffer, file.type);
      this.currentSourceUrl = nextSourceUrl;
      this.pdfDoc.set(doc);
      await this.renderAllPages(doc);
    } catch (err) {
      if (nextSourceUrl) {
        URL.revokeObjectURL(nextSourceUrl);
        this.currentSourceUrl = null;
      }
      const message = err instanceof Error ? err.message : 'Failed to load PDF.';
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  async renderAllPages(doc?: PDFDocumentProxy): Promise<void> {
    const targetDoc = doc ?? this.pdfDoc();
    if (!targetDoc || !this.isBrowser) {
      return;
    }
    this.pages.set([]);
    const rendered: PdfPageRender[] = [];
    for (let i = 1; i <= targetDoc.numPages; i += 1) {
      const page = await targetDoc.getPage(i);
      rendered.push(await this.renderPage(page, i));
      this.pages.set([...rendered]);
    }
  }

  private async renderPage(page: PDFPageProxy, pageNumber: number): Promise<PdfPageRender> {
    const viewport = page.getViewport({ scale: this.scale() });
    return {
      pageNumber,
      width: viewport.width * PdfFacadeService.CSS_UNITS,
      height: viewport.height * PdfFacadeService.CSS_UNITS
    };
  }

  async renderPageToCanvas(
    pageNumber: number,
    canvas: HTMLCanvasElement
  ): Promise<PageViewport | null> {
    const page = await this.getPage(pageNumber);
    if (!page) {
      return null;
    }
    const viewport = page.getViewport({ scale: this.scale() });
    const outputScale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Canvas is not supported in this environment.');
    }
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
    await page.render({ canvasContext: context, viewport, transform }).promise;
    return viewport;
  }

  async getPage(pageNumber: number): Promise<PDFPageProxy | null> {
    const doc = this.pdfDoc();
    if (!doc) {
      return null;
    }
    return doc.getPage(pageNumber);
  }

  getScale(): number {
    return this.scale();
  }

  async zoomIn(): Promise<void> {
    await this.setScale(this.scale() + 0.1);
  }

  async zoomOut(): Promise<void> {
    await this.setScale(this.scale() - 0.1);
  }

  async resetZoom(): Promise<void> {
    await this.setScale(1.25);
  }

  async setScale(next: number): Promise<void> {
    const clamped = this.clamp(next, 0.5, 3);
    const normalized = Number(clamped.toFixed(2));
    if (normalized === Number(this.scale().toFixed(2))) {
      return;
    }
    this.scale.set(normalized);
    await this.rerenderDocument();
  }

  async downloadCurrentPdf(options?: PdfDownloadOptions): Promise<void> {
    if (!this.isBrowser || !this.originalFileBytes) {
      return;
    }
    const fileName = this.currentName() ?? 'document.pdf';
    const includeAnnotations = options?.includeAnnotations ?? true;
    const annotations = options?.annotations;
    if (
      !includeAnnotations ||
      !annotations ||
      (!annotations.highlights.length && !annotations.comments.length)
    ) {
      this.downloadBytes(this.originalFileBytes, fileName);
      return;
    }
    try {
      const annotatedBytes = await this.buildAnnotatedPdfBytes(annotations);
      this.downloadBytes(annotatedBytes, fileName);
    } catch (err) {
      console.warn('Failed to build annotated PDF. Downloading original instead.', err);
      this.downloadBytes(this.originalFileBytes, fileName);
    }
  }

  private downloadBytes(payload: ArrayBuffer | Uint8Array, fileName: string): void {
    const view = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const clone = new ArrayBuffer(view.byteLength);
    new Uint8Array(clone).set(view);
    const blob = new Blob([clone], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  getCurrentFileSource(): string | null {
    return this.currentSourceUrl;
  }

  async renderTextLayer(
    pageNumber: number,
    container: HTMLElement,
    hostElement?: HTMLElement,
    viewport?: PageViewport
  ): Promise<PageTextLayout | null> {
    if (!this.isBrowser) {
      return null;
    }
    const pdfjs = await this.ensurePdfJs();
    const page = await this.getPage(pageNumber);
    if (!page) {
      return null;
    }
    const targetViewport = viewport ?? page.getViewport({ scale: this.scale() });
    const textContent = await page.getTextContent();
    container.innerHTML = '';
    container.style.width = `${targetViewport.width}px`;
    container.style.height = `${targetViewport.height}px`;
    const textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container,
      viewport: targetViewport
    });
    await textLayer.render();
    const layout = this.captureTextLayout(pageNumber, container, hostElement);
    if (layout) {
      this.textLayouts.set(pageNumber, layout);
      this.textCache.set(pageNumber, layout.text);
    }
    return layout;
  }

  getTextLayout(pageNumber: number): PageTextLayout | null {
    return this.textLayouts.get(pageNumber) ?? null;
  }

  async getPageViewport(pageNumber: number): Promise<PageViewport | null> {
    const page = await this.getPage(pageNumber);
    if (!page) {
      return null;
    }
    return page.getViewport({ scale: this.scale() });
  }

  private captureTextLayout(
    pageNumber: number,
    container: HTMLElement,
    hostElement?: HTMLElement
  ): PageTextLayout | null {
    const containerRect = hostElement?.getBoundingClientRect() ?? container.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height) {
      return null;
    }
    const spans: TextSpanRects[] = [];
    const textParts: string[] = [];
    let cursor = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
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

  async getPageText(pageNumber: number): Promise<string> {
    if (this.textCache.has(pageNumber)) {
      return this.textCache.get(pageNumber) as string;
    }
    const doc = this.pdfDoc();
    if (!doc) {
      return '';
    }
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ('str' in item ? item.str : 'unicode' in item ? item.unicode : ''))
      .join(' ');
    this.textCache.set(pageNumber, text);
    return text;
  }

  async getAllText(): Promise<string[]> {
    const doc = this.pdfDoc();
    if (!doc) {
      return [];
    }
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      texts.push(await this.getPageText(i));
    }
    return texts;
  }

  async readPdfAnnotations(): Promise<PdfAnnotationImport> {
    if (!this.isBrowser) {
      return { markers: [], comments: [] };
    }
    const doc = this.pdfDoc();
    if (!doc) {
      return { markers: [], comments: [] };
    }
    const markers: Marker[] = [];
    const comments: CommentCard[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const annotations = (await page.getAnnotations({ intent: 'display' })) as PdfJsAnnotationData[];
      annotations.forEach((annotation, index) => {
        const subtype = annotation.subtype?.toLowerCase();
        if (subtype === 'highlight') {
          const rects = this.buildHighlightRectsFromAnnotation(
            annotation,
            viewport.width,
            viewport.height
          );
          if (!rects.length) {
            return;
          }
          const contents = annotation.contents?.trim() ?? '';
          markers.push({
            id: this.buildPdfAnnotationId('highlight', annotation.id, pageNumber, index),
            page: pageNumber,
            color: this.parseAnnotationColor(annotation.color, annotation.opacity),
            label: contents || DEFAULT_IMPORTED_HIGHLIGHT_LABEL,
            rects,
            source: 'selection',
            text: contents || undefined,
            origin: 'pdf'
          });
          return;
        }
        if (subtype === 'text' || subtype === 'freetext') {
          const comment = this.buildImportedComment(
            annotation,
            pageNumber,
            viewport.width,
            viewport.height,
            index
          );
          if (comment) {
            comments.push(comment);
          }
        }
      });
    }
    return { markers, comments };
  }

  private async buildAnnotatedPdfBytes(annotations: PdfAnnotationExport): Promise<Uint8Array> {
    if (!this.originalFileBytes) {
      return new Uint8Array();
    }
    const pdfLib = await this.ensurePdfLib();
    const { PDFDocument, PDFName, PDFArray, PDFHexString } = pdfLib;
    const pdfDoc = await PDFDocument.load(this.originalFileBytes.slice(0));
    const pages = pdfDoc.getPages();
    const annotsByPage = new Map<number, PDFArray>();

    const ensureAnnots = (pageIndex: number): PDFArray => {
      const cached = annotsByPage.get(pageIndex);
      if (cached) {
        return cached;
      }
      const page = pages[pageIndex];
      let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) {
        annots = pdfDoc.context.obj([]) as PDFArray;
        page.node.set(PDFName.of('Annots'), annots);
      }
      annotsByPage.set(pageIndex, annots);
      return annots;
    };

    const appendAnnot = (pageIndex: number, annot: any): void => {
      const annots = ensureAnnots(pageIndex);
      const annotRef = pdfDoc.context.register(annot);
      annots.push(annotRef);
    };

    annotations.highlights.forEach((highlight) => {
      const pageIndex = highlight.page - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        return;
      }
      const page = pages[pageIndex];
      const { width, height } = page.getSize();
      const geometry = this.buildHighlightGeometry(highlight.rects, width, height);
      if (!geometry) {
        return;
      }
      const { rgb, alpha } = this.parseHighlightColor(highlight.color);
      const annot = pdfDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Highlight'),
        Rect: geometry.rect,
        QuadPoints: geometry.quadPoints,
        C: rgb,
        CA: alpha,
        F: 4
      });
      if (highlight.contents?.trim()) {
        annot.set(PDFName.of('Contents'), PDFHexString.fromText(highlight.contents.trim()));
      }
      if (highlight.id) {
        annot.set(PDFName.of('NM'), PDFHexString.fromText(highlight.id));
      }
      appendAnnot(pageIndex, annot);
    });

    annotations.comments.forEach((comment) => {
      const pageIndex = comment.page - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        return;
      }
      const page = pages[pageIndex];
      const { width, height } = page.getSize();
      const rect = this.buildCommentRect(comment, width, height);
      if (!rect) {
        return;
      }
      const { title, contents } = this.buildCommentContents(comment);
      const annot = pdfDoc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: rect,
        C: DEFAULT_COMMENT_COLOR,
        Name: PDFName.of('Comment'),
        Open: false,
        F: 4
      });
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
      annot.set(PDFName.of('T'), PDFHexString.fromText(title));
      annot.set(PDFName.of('NM'), PDFHexString.fromText(comment.id));
      appendAnnot(pageIndex, annot);
    });

    return pdfDoc.save();
  }

  private buildPdfAnnotationId(
    prefix: string,
    rawId: string | undefined,
    pageNumber: number,
    index: number
  ): string {
    const trimmed = rawId?.trim();
    if (trimmed) {
      return `pdf-${trimmed}`;
    }
    return `pdf-${prefix}-${pageNumber}-${index}`;
  }

  private buildHighlightRectsFromAnnotation(
    annotation: PdfJsAnnotationData,
    pageWidth: number,
    pageHeight: number
  ): HighlightRect[] {
    if (!pageWidth || !pageHeight) {
      return [];
    }
    const rects: HighlightRect[] = [];
    const quadPoints = this.toNumberArray(annotation.quadPoints);
    if (quadPoints.length >= 8) {
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const points = quadPoints.slice(i, i + 8);
        if (points.some((value) => !Number.isFinite(value))) {
          continue;
        }
        const xs = [points[0], points[2], points[4], points[6]];
        const ys = [points[1], points[3], points[5], points[7]];
        const rect = this.normalizePdfRect(
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
          pageWidth,
          pageHeight
        );
        if (rect) {
          rects.push(rect);
        }
      }
      if (rects.length) {
        return rects;
      }
    }
    const rect = this.toNumberArray(annotation.rect);
    if (rect.length >= 4 && rect.slice(0, 4).every((value) => Number.isFinite(value))) {
      const left = Math.min(rect[0], rect[2]);
      const right = Math.max(rect[0], rect[2]);
      const bottom = Math.min(rect[1], rect[3]);
      const top = Math.max(rect[1], rect[3]);
      const normalized = this.normalizePdfRect(left, bottom, right, top, pageWidth, pageHeight);
      if (normalized) {
        rects.push(normalized);
      }
    }
    return rects;
  }

  private normalizePdfRect(
    left: number,
    bottom: number,
    right: number,
    top: number,
    pageWidth: number,
    pageHeight: number
  ): HighlightRect | null {
    if (!pageWidth || !pageHeight) {
      return null;
    }
    const clampedLeft = this.clamp(left, 0, pageWidth);
    const clampedRight = this.clamp(right, 0, pageWidth);
    const clampedBottom = this.clamp(bottom, 0, pageHeight);
    const clampedTop = this.clamp(top, 0, pageHeight);
    if (clampedRight <= clampedLeft || clampedTop <= clampedBottom) {
      return null;
    }
    const width = clampedRight - clampedLeft;
    const height = clampedTop - clampedBottom;
    const leftPercent = (clampedLeft / pageWidth) * 100;
    const topPercent = ((pageHeight - clampedTop) / pageHeight) * 100;
    const widthPercent = (width / pageWidth) * 100;
    const heightPercent = (height / pageHeight) * 100;
    return {
      left: this.round4(leftPercent),
      top: this.round4(topPercent),
      width: this.round4(widthPercent),
      height: this.round4(heightPercent)
    };
  }

  private buildImportedComment(
    annotation: PdfJsAnnotationData,
    pageNumber: number,
    pageWidth: number,
    pageHeight: number,
    index: number
  ): CommentCard | null {
    if (!pageWidth || !pageHeight) {
      return null;
    }
    const rect = this.toNumberArray(annotation.rect);
    if (rect.length < 4 || rect.slice(0, 4).some((value) => !Number.isFinite(value))) {
      return null;
    }
    const centerX = (rect[0] + rect[2]) / 2;
    const centerY = (rect[1] + rect[3]) / 2;
    const anchorX = this.clamp(centerX / pageWidth, 0, 1);
    const anchorY = this.clamp(1 - centerY / pageHeight, 0, 1);
    const offsetX = anchorX > 0.6 ? -DEFAULT_IMPORTED_COMMENT_OFFSET : DEFAULT_IMPORTED_COMMENT_OFFSET;
    const offsetY = anchorY > 0.6 ? -DEFAULT_IMPORTED_COMMENT_OFFSET : DEFAULT_IMPORTED_COMMENT_OFFSET;
    const bubbleX = this.clamp(anchorX + offsetX, 0, 1);
    const bubbleY = this.clamp(anchorY + offsetY, 0, 1);

    const rawContents = annotation.contents?.trim() ?? '';
    const lines = rawContents
      ? rawContents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
    let title = annotation.title?.trim() || annotation.subject?.trim() || DEFAULT_IMPORTED_COMMENT_TITLE;
    if (lines.length && title && lines[0] === title) {
      lines.shift();
    }
    const createdAt = Date.now();
    const messages = lines.map((text) => this.createImportedMessage(text, createdAt));

    return {
      id: this.buildPdfAnnotationId('comment', annotation.id, pageNumber, index),
      title,
      page: pageNumber,
      anchorX: this.round4(anchorX),
      anchorY: this.round4(anchorY),
      bubbleX: this.round4(bubbleX),
      bubbleY: this.round4(bubbleY),
      messages,
      createdAt,
      origin: 'pdf'
    };
  }

  private createImportedMessage(text: string, createdAt: number): CommentMessage {
    return {
      id: this.buildRandomId('message'),
      text,
      createdAt
    };
  }

  private parseAnnotationColor(
    color: ArrayLike<number> | null | undefined,
    opacity?: number
  ): string {
    const values = this.toNumberArray(color);
    const safeOpacity =
      typeof opacity === 'number' && Number.isFinite(opacity)
        ? opacity
        : DEFAULT_HIGHLIGHT_ALPHA;
    const alpha = this.clamp(
      safeOpacity,
      0,
      1
    );
    if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) {
      return `rgba(255, 235, 59, ${alpha})`;
    }
    const max = Math.max(values[0], values[1], values[2]);
    const scale = max <= 1 ? 255 : 1;
    const r = Math.round(values[0] * scale);
    const g = Math.round(values[1] * scale);
    const b = Math.round(values[2] * scale);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private toNumberArray(value?: ArrayLike<number> | null): number[] {
    if (!value) {
      return [];
    }
    return Array.from(value).map((item) => Number(item));
  }

  private buildRandomId(prefix: string): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private round4(value: number): number {
    return Number(value.toFixed(4));
  }

  private async ensurePdfLib() {
    if (this.pdfLibPromise) {
      return this.pdfLibPromise;
    }
    this.pdfLibPromise = import('pdf-lib');
    return this.pdfLibPromise;
  }

  private buildHighlightGeometry(
    rects: HighlightRect[],
    pageWidth: number,
    pageHeight: number
  ): { rect: number[]; quadPoints: number[] } | null {
    if (!rects.length) {
      return null;
    }
    const quadPoints: number[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    rects.forEach((rect) => {
      const left = (rect.left / 100) * pageWidth;
      const right = ((rect.left + rect.width) / 100) * pageWidth;
      const top = pageHeight - (rect.top / 100) * pageHeight;
      const bottom = pageHeight - ((rect.top + rect.height) / 100) * pageHeight;
      const clampedLeft = this.clamp(left, 0, pageWidth);
      const clampedRight = this.clamp(right, 0, pageWidth);
      const clampedTop = this.clamp(top, 0, pageHeight);
      const clampedBottom = this.clamp(bottom, 0, pageHeight);
      if (clampedRight <= clampedLeft || clampedTop <= clampedBottom) {
        return;
      }
      quadPoints.push(
        clampedLeft,
        clampedTop,
        clampedRight,
        clampedTop,
        clampedLeft,
        clampedBottom,
        clampedRight,
        clampedBottom
      );
      minX = Math.min(minX, clampedLeft);
      minY = Math.min(minY, clampedBottom);
      maxX = Math.max(maxX, clampedRight);
      maxY = Math.max(maxY, clampedTop);
    });

    if (!quadPoints.length) {
      return null;
    }

    return { rect: [minX, minY, maxX, maxY], quadPoints };
  }

  private buildCommentRect(
    comment: CommentCard,
    pageWidth: number,
    pageHeight: number
  ): number[] | null {
    if (!Number.isFinite(comment.anchorX) || !Number.isFinite(comment.anchorY)) {
      return null;
    }
    const anchorX = this.clamp(comment.anchorX, 0, 1);
    const anchorY = this.clamp(comment.anchorY, 0, 1);
    const x = anchorX * pageWidth;
    const y = (1 - anchorY) * pageHeight;
    const iconSize = Math.min(DEFAULT_COMMENT_ICON_SIZE, pageWidth, pageHeight);
    const half = iconSize / 2;
    const left = this.clamp(x - half, 0, Math.max(0, pageWidth - iconSize));
    const bottom = this.clamp(y - half, 0, Math.max(0, pageHeight - iconSize));
    return [left, bottom, left + iconSize, bottom + iconSize];
  }

  private buildCommentContents(comment: CommentCard): { title: string; contents: string } {
    const title = comment.title?.trim() || DEFAULT_COMMENT_TITLE;
    const messages = comment.messages
      .map((message) => message.text.trim())
      .filter((text) => text.length > 0);
    return {
      title,
      contents: [title, ...messages].join('\n')
    };
  }

  private parseHighlightColor(color: string): { rgb: [number, number, number]; alpha: number } {
    const parsed = this.parseCssColor(color);
    if (!parsed) {
      return { rgb: [1, 1, 0], alpha: DEFAULT_HIGHLIGHT_ALPHA };
    }
    const rgb: [number, number, number] = [
      this.clamp(parsed.r / 255, 0, 1),
      this.clamp(parsed.g / 255, 0, 1),
      this.clamp(parsed.b / 255, 0, 1)
    ];
    const alpha = this.clamp(parsed.a ?? DEFAULT_HIGHLIGHT_ALPHA, 0, 1);
    return { rgb, alpha };
  }

  private parseCssColor(
    color: string
  ): { r: number; g: number; b: number; a?: number } | null {
    const trimmed = color.trim();
    if (!trimmed) {
      return null;
    }
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
    if (hexMatch) {
      const hex = hexMatch[1];
      if (hex.length === 3) {
        const r = Number.parseInt(hex[0] + hex[0], 16);
        const g = Number.parseInt(hex[1] + hex[1], 16);
        const b = Number.parseInt(hex[2] + hex[2], 16);
        return { r, g, b };
      }
      if (hex.length === 6 || hex.length === 8) {
        const r = Number.parseInt(hex.slice(0, 2), 16);
        const g = Number.parseInt(hex.slice(2, 4), 16);
        const b = Number.parseInt(hex.slice(4, 6), 16);
        const a =
          hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : undefined;
        return { r, g, b, a };
      }
    }
    const rgbMatch = /^rgba?\((.+)\)$/i.exec(trimmed);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(',').map((part) => part.trim());
      if (parts.length < 3) {
        return null;
      }
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        return null;
      }
      const a = parts.length >= 4 ? Number(parts[3]) : undefined;
      return {
        r,
        g,
        b,
        a: Number.isFinite(a) ? a : undefined
      };
    }
    return null;
  }

  private async ensurePdfJs() {
    if (this.pdfjsPromise) {
      return this.pdfjsPromise;
    }
    this.pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return pdfjs;
    });
    return this.pdfjsPromise;
  }

  private async rerenderDocument(): Promise<void> {
    const doc = this.pdfDoc();
    if (!doc) {
      return;
    }
    this.textCache.clear();
    this.textLayouts.clear();
    await this.renderAllPages(doc);
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

  private createObjectUrl(buffer: ArrayBuffer, mimeType: string): string {
    const type = mimeType && mimeType.trim().length > 0 ? mimeType : 'application/pdf';
    return URL.createObjectURL(new Blob([buffer], { type }));
  }

  private revokeSourceUrl(): void {
    if (!this.isBrowser || !this.currentSourceUrl) {
      return;
    }
    URL.revokeObjectURL(this.currentSourceUrl);
    this.currentSourceUrl = null;
  }
}
