import { Injectable, signal } from '@angular/core';
import { PdfFacadeService } from '../pdf/pdf-facade.service';
import { OcrResult, OcrScope } from '../../core/models';

@Injectable({ providedIn: 'root' })
export class OcrFacadeService {
  private readonly lastResult = signal<OcrResult | null>(null);
  private readonly running = signal(false);

  readonly result = this.lastResult.asReadonly();
  readonly isRunning = this.running.asReadonly();

  constructor(private readonly pdfFacade: PdfFacadeService) {}

  reset(): void {
    this.lastResult.set(null);
    this.running.set(false);
  }

  async runOcr(page: number): Promise<void> {
    await this.executeOcr('page', page);
  }

  async runOcrAll(): Promise<void> {
    await this.executeOcr('all');
  }

  private async executeOcr(scope: OcrScope, page?: number): Promise<void> {
    if (this.running()) {
      return;
    }
    const pages = this.pdfFacade.pageCount();
    if (pages === 0 || (scope === 'page' && (!page || page < 1 || page > pages))) {
      this.lastResult.set(null);
      return;
    }
    this.running.set(true);
    const startedAt = performance.now();
    try {
      // Simulated OCR: reuse text layer if available to keep the app offline.
      const text =
        scope === 'page'
          ? await this.pdfFacade.getPageText(page ?? 1)
          : this.buildAllPageText(await this.pdfFacade.getAllText());
      this.lastResult.set({
        scope,
        page: scope === 'page' ? page : undefined,
        pageCount: pages,
        text: text || 'OCR 結果が空です（画像主体のページの可能性があります）',
        durationMs: Math.round(performance.now() - startedAt),
        source: 'text-layer'
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OCR に失敗しました';
      this.lastResult.set({
        scope,
        page: scope === 'page' ? page : undefined,
        pageCount: pages,
        text: message,
        durationMs: Math.round(performance.now() - startedAt),
        source: 'ocr-simulated'
      });
    } finally {
      this.running.set(false);
    }
  }

  private buildAllPageText(texts: string[]): string {
    if (!texts.length) {
      return '';
    }
    const hasContent = texts.some((text) => text.trim().length > 0);
    if (!hasContent) {
      return '';
    }
    return texts
      .map((text, index) => `--- p${index + 1} ---\n${text}`)
      .join('\n\n');
  }
}
