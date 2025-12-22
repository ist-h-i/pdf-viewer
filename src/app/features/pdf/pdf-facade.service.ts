import { inject, Injectable, PLATFORM_ID, computed, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import { HighlightRect, PageTextLayout, PdfPageRender, TextSpanRects } from '../../core/models';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';

@Injectable({ providedIn: 'root' })
export class PdfFacadeService {
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

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
  private currentSource: Uint8Array | null = null;

  readonly pageCount = computed(() => this.pdfDoc()?.numPages ?? 0);
  readonly renderedPages = this.pages.asReadonly();
  readonly isLoading = this.loading.asReadonly();
  readonly lastError = this.error.asReadonly();
  readonly pdfName = this.currentName.asReadonly();

  async loadFile(file: File): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.currentName.set(file.name);
    this.originalFileBytes = null;
    this.currentSource = null;
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
      this.currentSource = new Uint8Array(buffer);
      const pdfjs = await this.ensurePdfJs();
      const doc = await pdfjs.getDocument({ data: buffer }).promise;
      this.pdfDoc.set(doc);
      await this.renderAllPages(doc);
    } catch (err) {
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
      width: viewport.width,
      height: viewport.height
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

  downloadCurrentPdf(): void {
    if (!this.isBrowser || !this.originalFileBytes) {
      return;
    }
    const blob = new Blob([this.originalFileBytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = this.currentName() ?? 'document.pdf';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  getCurrentFileSource(): Uint8Array | null {
    return this.currentSource;
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
}
