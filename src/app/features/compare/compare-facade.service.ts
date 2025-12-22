import { inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { CompareSummary } from '../../core/models';
import { PdfFacadeService } from '../pdf/pdf-facade.service';

@Injectable({ providedIn: 'root' })
export class CompareFacadeService {
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

  private readonly summary = signal<CompareSummary | null>(null);
  private readonly running = signal(false);
  private readonly targetName = signal<string | null>(null);

  readonly result = this.summary.asReadonly();
  readonly isRunning = this.running.asReadonly();
  readonly compareTargetName = this.targetName.asReadonly();

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
      return;
    }
    this.running.set(true);
    this.targetName.set(file.name);
    try {
      const pdfjs = await this.ensurePdfJs();
      const targetDoc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const targetTexts = await this.collectAllText(targetDoc);
      targetDoc.destroy();
      this.summary.set(this.diff(baseTexts, targetTexts));
    } catch (err) {
      const message = err instanceof Error ? err.message : '比較用 PDF の読み込みに失敗しました';
      this.summary.set({
        addedPages: 0,
        removedPages: 0,
        changedPages: [],
        note: message
      });
    } finally {
      this.running.set(false);
    }
  }

  reset(): void {
    this.summary.set(null);
    this.targetName.set(null);
    this.running.set(false);
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
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      return pdfjs;
    });
    return this.pdfjsPromise;
  }
}
