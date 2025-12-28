import { inject, Injectable, PLATFORM_ID, computed, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
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
  fileNameOverride?: string;
};

type PdfJsAnnotationData = {
  id?: string;
  subtype?: string;
  rect?: ArrayLike<number> | null;
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  contents?: string;
  contentsObj?: { str?: string; dir?: string };
  title?: string;
  titleObj?: { str?: string; dir?: string };
  subject?: string;
  subjectObj?: { str?: string; dir?: string };
  opacity?: number;
  popupRef?: string | null;
  parentRect?: ArrayLike<number> | null;
};

type PdfAnnotationImport = {
  markers: Marker[];
  comments: CommentCard[];
};

type PdfJsTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type PdfJsTextItem = PdfJsTextContent['items'][number];
type PdfJsTextStyle = {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
};

const DEFAULT_HIGHLIGHT_ALPHA = 0.4;
const DEFAULT_COMMENT_ICON_SIZE = 18;
const DEFAULT_COMMENT_COLOR: [number, number, number] = [1, 0.92, 0.23];
const DEFAULT_COMMENT_TITLE = '';
const DEFAULT_IMPORTED_COMMENT_TITLE = '';
const DEFAULT_IMPORTED_HIGHLIGHT_LABEL = '';
const DEFAULT_IMPORTED_COMMENT_OFFSET = 0.12;
const IMPORTED_HIGHLIGHT_SUBTYPES = new Set(['highlight', 'underline', 'squiggly', 'strikeout']);
const DEFAULT_TEXT_ASCENT = 0.8;

@Injectable({ providedIn: 'root' })
export class PdfFacadeService {
  private static readonly CSS_UNITS = 96 / 72;
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
  private pdfLibPromise: Promise<typeof import('pdf-lib')> | null = null;

  private readonly scale = signal(1);
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

  setUserError(message: string | null): void {
    this.error.set(message);
  }

  async reset(): Promise<void> {
    const doc = this.pdfDoc();
    this.pdfDoc.set(null);
    this.pages.set([]);
    this.loading.set(false);
    this.error.set(null);
    this.currentName.set(null);
    this.textCache.clear();
    this.textLayouts.clear();
    this.originalFileBytes = null;
    this.revokeSourceUrl();
    this.currentSourceUrl = null;
    if (doc) {
      try {
        await doc.destroy();
      } catch (err) {
        console.warn('Failed to destroy PDF document.', err);
      }
    }
  }

  async loadBytes(bytes: ArrayBuffer, name: string, mimeType = 'application/pdf'): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.currentName.set(name);
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
      // Keep a stable buffer for viewer/download; pdf.js transfers (detaches) its input buffer.
      const sourceBuffer = bytes;
      const workerBuffer = bytes.slice(0);
      this.originalFileBytes = sourceBuffer;
      const pdfjs = await this.ensurePdfJs();
      const doc = await pdfjs.getDocument({ data: workerBuffer }).promise;
      nextSourceUrl = this.createObjectUrl(sourceBuffer, mimeType);
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

  async loadFile(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      await this.loadBytes(buffer, file.name, file.type);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load PDF.';
      this.error.set(message);
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
    context.save();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
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
    await this.setScale(1);
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
    const fileName = options?.fileNameOverride ?? this.currentName() ?? 'document.pdf';
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
    const textContent = await page.getTextContent({ disableNormalization: true });
    container.innerHTML = '';
    container.style.width = `${targetViewport.width}px`;
    container.style.height = `${targetViewport.height}px`;
    const textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container,
      viewport: targetViewport
    });
    await textLayer.render();
    const layout =
      this.buildTextLayoutFromTextContent(pageNumber, textContent, targetViewport, pdfjs) ??
      this.captureTextLayout(pageNumber, container, hostElement);
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

  private buildTextLayoutFromTextContent(
    pageNumber: number,
    textContent: PdfJsTextContent,
    viewport: PageViewport,
    pdfjs: typeof import('pdfjs-dist')
  ): PageTextLayout | null {
    const items = textContent.items ?? [];
    if (items.length === 0) {
      return null;
    }
    const rawDims = viewport.rawDims as {
      pageWidth?: number;
      pageHeight?: number;
      pageX?: number;
      pageY?: number;
    };
    const viewBox = viewport.viewBox ?? [0, 0, viewport.width, viewport.height];
    const pageWidth = rawDims?.pageWidth ?? viewBox[2] - viewBox[0];
    const pageHeight = rawDims?.pageHeight ?? viewBox[3] - viewBox[1];
    const pageX = rawDims?.pageX ?? viewBox[0] ?? 0;
    const pageY = rawDims?.pageY ?? viewBox[1] ?? 0;
    if (!pageWidth || !pageHeight) {
      return null;
    }
    // Match PDF.js TextLayer's page-unit transform to keep rects aligned with the text layer.
    const pageTransform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
    const styles = (textContent as { styles?: Record<string, PdfJsTextStyle> }).styles ?? {};
    const spans: TextSpanRects[] = [];
    const textParts: string[] = [];
    let cursor = 0;
    items.forEach((item) => {
      const text = typeof (item as { str?: string }).str === 'string' ? (item as { str: string }).str : '';
      const length = text.length;
      if (text) {
        const fontName = (item as { fontName?: string }).fontName;
        const style = fontName ? styles[fontName] ?? null : null;
        const rect = this.buildHighlightRectFromTextItem(
          item,
          style,
          pageTransform,
          pageWidth,
          pageHeight,
          pdfjs.Util
        );
        if (rect) {
          spans.push({
            start: cursor,
            end: cursor + length,
            text,
            rects: [rect]
          });
        }
      }
      textParts.push(text);
      cursor += length;
    });
    return {
      page: pageNumber,
      width: pageWidth,
      height: pageHeight,
      text: textParts.join(''),
      spans
    };
  }

  private buildHighlightRectFromTextItem(
    item: PdfJsTextItem,
    style: PdfJsTextStyle | null,
    pageTransform: number[],
    pageWidth: number,
    pageHeight: number,
    util: typeof import('pdfjs-dist').Util
  ): HighlightRect | null {
    const transform = (item as { transform?: number[] }).transform ?? null;
    if (!Array.isArray(transform) || transform.length < 6) {
      return null;
    }
    const width = Number((item as { width?: number }).width ?? 0);
    const height = Number((item as { height?: number }).height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    const tx = util.transform(pageTransform, transform);
    let angle = Math.atan2(tx[1], tx[0]);
    if (style?.vertical) {
      angle += Math.PI / 2;
    }
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) {
      return null;
    }
    const ascent = typeof style?.ascent === 'number' ? style.ascent : DEFAULT_TEXT_ASCENT;
    const fontAscent = fontHeight * ascent;
    let left = 0;
    let top = 0;
    if (Math.abs(angle) < 0.0001) {
      left = tx[4];
      top = tx[5] - fontAscent;
    } else {
      left = tx[4] + fontAscent * Math.sin(angle);
      top = tx[5] - fontAscent * Math.cos(angle);
    }
    const rectWidth = style?.vertical ? height : width;
    const rectHeight = fontHeight;
    if (!Number.isFinite(rectWidth) || !Number.isFinite(rectHeight) || rectWidth <= 0 || rectHeight <= 0) {
      return null;
    }
    const bounds = this.buildAxisAlignedBoundsFromRotatedRect(left, top, rectWidth, rectHeight, angle);
    return this.normalizeRectFromPageUnits(bounds, pageWidth, pageHeight);
  }

  private buildAxisAlignedBoundsFromRotatedRect(
    left: number,
    top: number,
    width: number,
    height: number,
    angle: number
  ): { left: number; top: number; width: number; height: number } {
    if (Math.abs(angle) < 0.0001) {
      return { left, top, width, height };
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points = [
      { x: left, y: top },
      { x: left + width, y: top },
      { x: left, y: top + height },
      { x: left + width, y: top + height }
    ];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    points.forEach((point) => {
      const dx = point.x - left;
      const dy = point.y - top;
      const x = left + dx * cos - dy * sin;
      const y = top + dx * sin + dy * cos;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    return {
      left: minX,
      top: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  private normalizeRectFromPageUnits(
    rect: { left: number; top: number; width: number; height: number },
    pageWidth: number,
    pageHeight: number
  ): HighlightRect {
    const round4 = (value: number): number => Number(value.toFixed(4));
    const left = (rect.left / pageWidth) * 100;
    const top = (rect.top / pageHeight) * 100;
    const width = (rect.width / pageWidth) * 100;
    const height = (rect.height / pageHeight) * 100;
    return {
      left: round4(left),
      top: round4(top),
      width: round4(width),
      height: round4(height)
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
      const popups = new Map<string, { annotation: PdfJsAnnotationData; index: number }>();
      annotations.forEach((annotation, index) => {
        const subtype = annotation.subtype?.toLowerCase();
        if (subtype === 'popup' && annotation.id) {
          popups.set(annotation.id, { annotation, index });
        }
      });
      const usedPopups = new Set<string>();
      const resolvePopupData = (
        annotation: PdfJsAnnotationData
      ): { annotation: PdfJsAnnotationData; rectSource: ArrayLike<number> | null } => {
        const popupRef = annotation.popupRef ?? null;
        const popupEntry = popupRef ? popups.get(popupRef) : null;
        if (!popupEntry) {
          return { annotation, rectSource: annotation.rect ?? null };
        }
        if (popupRef) {
          usedPopups.add(popupRef);
        }
        const popup = popupEntry.annotation;
        const contents = this.readPdfJsAnnotationText(annotation, 'contents');
        const title = this.readPdfJsAnnotationText(annotation, 'title');
        const subject = this.readPdfJsAnnotationText(annotation, 'subject');
        const popupContents = this.readPdfJsAnnotationText(popup, 'contents');
        const popupTitle = this.readPdfJsAnnotationText(popup, 'title');
        const popupSubject = this.readPdfJsAnnotationText(popup, 'subject');
        const merged: PdfJsAnnotationData = {
          ...annotation,
          contents: contents.trim() ? contents : popupContents,
          title: title.trim() ? title : popupTitle,
          subject: subject.trim() ? subject : popupSubject
        };
        const rectSource = annotation.rect ?? popup.parentRect ?? popup.rect ?? null;
        return { annotation: merged, rectSource };
      };
      annotations.forEach((annotation, index) => {
        const subtype = annotation.subtype?.toLowerCase();
        if (subtype === 'popup') {
          return;
        }
        if (subtype && IMPORTED_HIGHLIGHT_SUBTYPES.has(subtype)) {
          const rects = this.buildHighlightRectsFromAnnotation(annotation, viewport);
          if (!rects.length) {
            return;
          }
          const contents = this.readPdfJsAnnotationText(annotation, 'contents').trim();
          const subject = this.readPdfJsAnnotationText(annotation, 'subject').trim();
          const label = contents || subject || DEFAULT_IMPORTED_HIGHLIGHT_LABEL;
          const text = subject || (contents ? contents : undefined);
          markers.push({
            id: this.buildPdfAnnotationId('highlight', annotation.id, pageNumber, index),
            page: pageNumber,
            color: this.parseAnnotationColor(annotation.color, annotation.opacity),
            label,
            rects,
            source: 'selection',
            text,
            origin: 'pdf'
          });
          return;
        }
        if (subtype === 'text' || subtype === 'freetext') {
          const resolved = resolvePopupData(annotation);
          const comment = this.buildImportedComment(
            resolved.annotation,
            pageNumber,
            viewport,
            index,
            resolved.rectSource
          );
          if (comment) {
            comments.push(comment);
          }
        }
      });
      popups.forEach((entry, popupId) => {
        if (usedPopups.has(popupId)) {
          return;
        }
        const rectSource = entry.annotation.parentRect ?? entry.annotation.rect ?? null;
        const comment = this.buildImportedComment(
          entry.annotation,
          pageNumber,
          viewport,
          entry.index,
          rectSource
        );
        if (comment) {
          comments.push(comment);
        }
      });
    }
    return { markers, comments };
  }

  private readPdfJsAnnotationText(
    annotation: PdfJsAnnotationData,
    field: 'contents' | 'title' | 'subject'
  ): string {
    const direct = annotation[field];
    if (typeof direct === 'string') {
      return direct;
    }
    const objectValue =
      field === 'contents'
        ? annotation.contentsObj
        : field === 'title'
          ? annotation.titleObj
          : annotation.subjectObj;
    return typeof objectValue?.str === 'string' ? objectValue.str : '';
  }

  private async buildAnnotatedPdfBytes(annotations: PdfAnnotationExport): Promise<Uint8Array> {
    if (!this.originalFileBytes) {
      return new Uint8Array();
    }
    const pdfLib = await this.ensurePdfLib();
    const { PDFDocument, PDFName, PDFArray, PDFHexString } = pdfLib;
    const pdfDoc = await PDFDocument.load(this.originalFileBytes.slice(0));
    const pdfjsDoc = this.pdfDoc();
    if (!pdfjsDoc) {
      throw new Error('PDF document is not loaded.');
    }
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

    const viewportCache = new Map<number, PageViewport>();
    const resolveViewport = async (pageNumber: number): Promise<PageViewport | null> => {
      const cached = viewportCache.get(pageNumber);
      if (cached) {
        return cached;
      }
      if (pageNumber <= 0 || pageNumber > pdfjsDoc.numPages) {
        return null;
      }
      const page = await pdfjsDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      viewportCache.set(pageNumber, viewport);
      return viewport;
    };

    for (const highlight of annotations.highlights) {
      const pageIndex = highlight.page - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        continue;
      }
      const viewport = await resolveViewport(highlight.page);
      if (!viewport) {
        continue;
      }
      const geometry = this.buildHighlightGeometry(highlight.rects, viewport);
      if (!geometry) {
        continue;
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
      if (highlight.subject?.trim()) {
        annot.set(PDFName.of('Subj'), PDFHexString.fromText(highlight.subject.trim()));
      }
      if (highlight.id) {
        annot.set(PDFName.of('NM'), PDFHexString.fromText(highlight.id));
      }
      appendAnnot(pageIndex, annot);
    }

    for (const comment of annotations.comments) {
      const pageIndex = comment.page - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        continue;
      }
      const viewport = await resolveViewport(comment.page);
      if (!viewport) {
        continue;
      }
      const rect = this.buildCommentRect(comment, viewport);
      if (!rect) {
        continue;
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
    }

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
    viewport: PageViewport
  ): HighlightRect[] {
    if (!viewport.width || !viewport.height) {
      return [];
    }
    const rects: HighlightRect[] = [];
    const quadPoints = this.toNumberArray(annotation.quadPoints);
    if (quadPoints.length >= 8) {
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const points = quadPoints.slice(i, i + 8);
        const quad: Array<[number, number]> = [];
        let valid = true;
        for (let j = 0; j < 8; j += 2) {
          const [x, y] = viewport.convertToViewportPoint(points[j], points[j + 1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            valid = false;
            break;
          }
          quad.push([x, y]);
        }
        if (!valid) {
          continue;
        }
        const rect = this.normalizeViewportRectFromPoints(quad, viewport);
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
      const corners: Array<[number, number]> = [
        this.toPointTuple(viewport.convertToViewportPoint(left, bottom)),
        this.toPointTuple(viewport.convertToViewportPoint(right, bottom)),
        this.toPointTuple(viewport.convertToViewportPoint(right, top)),
        this.toPointTuple(viewport.convertToViewportPoint(left, top))
      ];
      const normalized = this.normalizeViewportRectFromPoints(corners, viewport);
      if (normalized) {
        rects.push(normalized);
      }
    }
    return rects;
  }

  private normalizeViewportRectFromPoints(
    points: Array<[number, number]>,
    viewport: PageViewport
  ): HighlightRect | null {
    if (!viewport.width || !viewport.height) {
      return null;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return this.normalizeViewportRect(minX, minY, maxX, maxY, viewport);
  }

  private normalizeViewportRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
    viewport: PageViewport
  ): HighlightRect | null {
    if (!viewport.width || !viewport.height) {
      return null;
    }
    const width = viewport.width;
    const height = viewport.height;
    const clampedLeft = this.clamp(left, 0, width);
    const clampedRight = this.clamp(right, 0, width);
    const clampedTop = this.clamp(top, 0, height);
    const clampedBottom = this.clamp(bottom, 0, height);
    if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) {
      return null;
    }
    const rectWidth = clampedRight - clampedLeft;
    const rectHeight = clampedBottom - clampedTop;
    const leftPercent = (clampedLeft / width) * 100;
    const topPercent = (clampedTop / height) * 100;
    const widthPercent = (rectWidth / width) * 100;
    const heightPercent = (rectHeight / height) * 100;
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
    viewport: PageViewport,
    index: number,
    rectOverride?: ArrayLike<number> | null
  ): CommentCard | null {
    if (!viewport.width || !viewport.height) {
      return null;
    }
    const rect = this.toNumberArray(rectOverride ?? annotation.rect);
    if (rect.length < 4 || rect.slice(0, 4).some((value) => !Number.isFinite(value))) {
      return null;
    }
    const left = Math.min(rect[0], rect[2]);
    const right = Math.max(rect[0], rect[2]);
    const bottom = Math.min(rect[1], rect[3]);
    const top = Math.max(rect[1], rect[3]);
    const corners: Array<[number, number]> = [
      this.toPointTuple(viewport.convertToViewportPoint(left, bottom)),
      this.toPointTuple(viewport.convertToViewportPoint(right, bottom)),
      this.toPointTuple(viewport.convertToViewportPoint(right, top)),
      this.toPointTuple(viewport.convertToViewportPoint(left, top))
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const anchorX = this.clamp(centerX / viewport.width, 0, 1);
    const anchorY = this.clamp(centerY / viewport.height, 0, 1);
    const offsetX = anchorX > 0.6 ? -DEFAULT_IMPORTED_COMMENT_OFFSET : DEFAULT_IMPORTED_COMMENT_OFFSET;
    const offsetY = anchorY > 0.6 ? -DEFAULT_IMPORTED_COMMENT_OFFSET : DEFAULT_IMPORTED_COMMENT_OFFSET;
    const bubbleX = this.clamp(anchorX + offsetX, 0, 1);
    const bubbleY = this.clamp(anchorY + offsetY, 0, 1);

    const rawContents = this.readPdfJsAnnotationText(annotation, 'contents').trim();
    const lines = rawContents
      ? rawContents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
    let title =
      this.readPdfJsAnnotationText(annotation, 'title').trim() ||
      this.readPdfJsAnnotationText(annotation, 'subject').trim() ||
      DEFAULT_IMPORTED_COMMENT_TITLE;
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
      return this.applyHighlightAlpha('var(--color-highlight-search)', alpha);
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

  private toPointTuple(point: ArrayLike<number> | null | undefined): [number, number] {
    if (!point || point.length < 2) {
      return [Number.NaN, Number.NaN];
    }
    return [Number(point[0]), Number(point[1])];
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
    viewport: PageViewport
  ): { rect: number[]; quadPoints: number[] } | null {
    if (!rects.length || !viewport.width || !viewport.height) {
      return null;
    }
    const quadPoints: number[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    rects.forEach((rect) => {
      const left = (rect.left / 100) * viewport.width;
      const right = ((rect.left + rect.width) / 100) * viewport.width;
      const top = (rect.top / 100) * viewport.height;
      const bottom = ((rect.top + rect.height) / 100) * viewport.height;
      const clampedLeft = this.clamp(left, 0, viewport.width);
      const clampedRight = this.clamp(right, 0, viewport.width);
      const clampedTop = this.clamp(top, 0, viewport.height);
      const clampedBottom = this.clamp(bottom, 0, viewport.height);
      if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) {
        return;
      }
      const [x1, y1] = viewport.convertToPdfPoint(clampedLeft, clampedTop);
      const [x2, y2] = viewport.convertToPdfPoint(clampedRight, clampedTop);
      const [x3, y3] = viewport.convertToPdfPoint(clampedLeft, clampedBottom);
      const [x4, y4] = viewport.convertToPdfPoint(clampedRight, clampedBottom);
      if (
        !Number.isFinite(x1) ||
        !Number.isFinite(y1) ||
        !Number.isFinite(x2) ||
        !Number.isFinite(y2) ||
        !Number.isFinite(x3) ||
        !Number.isFinite(y3) ||
        !Number.isFinite(x4) ||
        !Number.isFinite(y4)
      ) {
        return;
      }
      quadPoints.push(x1, y1, x2, y2, x3, y3, x4, y4);
      minX = Math.min(minX, x1, x2, x3, x4);
      minY = Math.min(minY, y1, y2, y3, y4);
      maxX = Math.max(maxX, x1, x2, x3, x4);
      maxY = Math.max(maxY, y1, y2, y3, y4);
    });

    if (!quadPoints.length) {
      return null;
    }

    return { rect: [minX, minY, maxX, maxY], quadPoints };
  }

  private buildCommentRect(
    comment: CommentCard,
    viewport: PageViewport
  ): number[] | null {
    if (
      !Number.isFinite(comment.anchorX) ||
      !Number.isFinite(comment.anchorY) ||
      !viewport.width ||
      !viewport.height
    ) {
      return null;
    }
    const anchorX = this.clamp(comment.anchorX, 0, 1);
    const anchorY = this.clamp(comment.anchorY, 0, 1);
    const x = anchorX * viewport.width;
    const y = anchorY * viewport.height;
    const iconSize = Math.min(DEFAULT_COMMENT_ICON_SIZE, viewport.width, viewport.height);
    const half = iconSize / 2;
    const left = this.clamp(x - half, 0, Math.max(0, viewport.width - iconSize));
    const top = this.clamp(y - half, 0, Math.max(0, viewport.height - iconSize));
    const right = left + iconSize;
    const bottom = top + iconSize;
    const corners: Array<[number, number]> = [
      this.toPointTuple(viewport.convertToPdfPoint(left, top)),
      this.toPointTuple(viewport.convertToPdfPoint(right, top)),
      this.toPointTuple(viewport.convertToPdfPoint(left, bottom)),
      this.toPointTuple(viewport.convertToPdfPoint(right, bottom))
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
      return null;
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
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

  private applyHighlightAlpha(color: string, alpha: number): string {
    const parsed = this.parseCssColor(color);
    if (!parsed) {
      return color;
    }
    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
  }

  private resolveCssVar(color: string): string {
    const match = color.trim().match(/^var\((--[^),]+)(?:,[^)]+)?\)$/);
    if (!match || !this.isBrowser || typeof document === 'undefined') {
      return color;
    }
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]);
    return resolved.trim() || color;
  }

  private parseCssColor(
    color: string
  ): { r: number; g: number; b: number; a?: number } | null {
    const trimmed = this.resolveCssVar(color).trim();
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
