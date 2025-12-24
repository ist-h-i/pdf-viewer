import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { CompareSummary, PdfPageRender } from '../../core/models';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';
import { PdfFacadeService } from '../pdf/pdf-facade.service';

@Injectable({ providedIn: 'root' })
export class CompareFacadeService {
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

  private readonly summary = signal<CompareSummary | null>(null);
  private readonly running = signal(false);
  private readonly targetName = signal<string | null>(null);
  private readonly targetSource = signal<string | null>(null);
  private readonly targetPages = signal<PdfPageRender[]>([]);
  private readonly targetPageCount = signal(0);
  private targetDoc: PDFDocumentProxy | null = null;

  readonly result = this.summary.asReadonly();
  readonly isRunning = this.running.asReadonly();
  readonly compareTargetName = this.targetName.asReadonly();
  readonly compareTargetSource = this.targetSource.asReadonly();
  readonly compareTargetPages = this.targetPages.asReadonly();
  readonly compareTargetPageCount = this.targetPageCount.asReadonly();

  constructor(private readonly pdfFacade: PdfFacadeService) {}

  async compareWith(file: File): Promise<void> {
    if (this.running()) {
      return;
    }
    if (!this.isBrowser) {
      this.summary.set({
        addedPages: 0,
        removedPages: 0,
        changedPages: [],
        note: 'PDF 比較はブラウザ環境でのみ有効です'
      });
      this.clearTarget();
      return;
    }
    const baseTexts = await this.pdfFacade.getAllText();
    if (baseTexts.length === 0) {
      this.summary.set({
        addedPages: 0,
        removedPages: 0,
        changedPages: [],
        note: '比較元 PDF が読み込まれていません'
      });
      this.clearTarget();
      return;
    }
    this.running.set(true);
    this.targetName.set(file.name);
    try {
      const pdfjs = await this.ensurePdfJs();
      const buffer = await file.arrayBuffer();
      // Keep a stable copy for display; pdf.js transfers (detaches) its input buffer.
      const sourceBuffer = buffer.slice(0);
      const targetDoc = await pdfjs.getDocument({ data: buffer }).promise;
      const sourceUrl = this.createObjectUrl(sourceBuffer, file.type);
      await this.setTargetDoc(targetDoc, sourceUrl);
      const targetTexts = await this.collectAllText(targetDoc);
      this.summary.set(this.diff(baseTexts, targetTexts));
    } catch (err) {
      const message = err instanceof Error ? err.message : '比較用 PDF の読み込みに失敗しました';
      this.summary.set({
        addedPages: 0,
        removedPages: 0,
        changedPages: [],
        note: message
      });
      this.clearTarget();
    } finally {
      this.running.set(false);
    }
  }

  reset(): void {
    this.summary.set(null);
    this.targetName.set(null);
    this.running.set(false);
    this.clearTarget();
  }

  async refreshTargetPages(): Promise<void> {
    if (!this.targetDoc) {
      return;
    }
    await this.renderTargetPages(this.targetDoc);
  }

  private async setTargetDoc(doc: PDFDocumentProxy, source: string): Promise<void> {
    if (this.targetDoc && this.targetDoc !== doc) {
      this.targetDoc.destroy();
    }
    this.targetDoc = doc;
    this.revokeTargetUrl();
    this.targetSource.set(source);
    this.targetPageCount.set(doc.numPages);
    await this.renderTargetPages(doc);
  }

  private clearTarget(): void {
    this.targetDoc?.destroy();
    this.targetDoc = null;
    this.revokeTargetUrl();
    this.targetSource.set(null);
    this.targetPages.set([]);
    this.targetPageCount.set(0);
  }

  private async renderTargetPages(doc: PDFDocumentProxy): Promise<void> {
    const scale = this.pdfFacade.getScale();
    const rendered: PdfPageRender[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      rendered.push({
        pageNumber: i,
        width: viewport.width,
        height: viewport.height
      });
      this.targetPages.set([...rendered]);
    }
  }

  private async collectAllText(doc: PDFDocumentProxy): Promise<string[]> {
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => ('str' in item ? item.str : 'unicode' in item ? item.unicode : ''))
        .join(' ');
      texts.push(text);
    }
    return texts;
  }

  private diff(base: string[], target: string[]): CompareSummary {
    const maxPages = Math.max(base.length, target.length);
    const changedPages: number[] = [];
    for (let i = 0; i < maxPages; i += 1) {
      const baseText = base[i] ?? '';
      const targetText = target[i] ?? '';
      if (baseText !== targetText) {
        changedPages.push(i + 1);
      }
    }
    const addedPages = Math.max(target.length - base.length, 0);
    const removedPages = Math.max(base.length - target.length, 0);
    const note =
      changedPages.length === 0 && addedPages === 0 && removedPages === 0
        ? '差分はありません'
        : 'テキスト比較結果です（レイアウト差分は未検知）';
    return { addedPages, removedPages, changedPages, note };
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

  private createObjectUrl(buffer: ArrayBuffer, mimeType: string): string {
    const type = mimeType && mimeType.trim().length > 0 ? mimeType : 'application/pdf';
    return URL.createObjectURL(new Blob([buffer], { type }));
  }

  private revokeTargetUrl(): void {
    const current = this.targetSource();
    if (!this.isBrowser || !current) {
      return;
    }
    URL.revokeObjectURL(current);
  }
}
