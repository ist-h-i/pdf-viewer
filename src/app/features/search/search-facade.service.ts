import { Injectable, signal } from '@angular/core';
import { PdfFacadeService } from '../pdf/pdf-facade.service';
import { SearchHit } from '../../core/models';

@Injectable({ providedIn: 'root' })
export class SearchFacadeService {
  private readonly results = signal<SearchHit[]>([]);
  private readonly searching = signal(false);

  readonly searchResults = this.results.asReadonly();
  readonly isSearching = this.searching.asReadonly();

  constructor(private readonly pdfFacade: PdfFacadeService) {}

  async search(query: string): Promise<void> {
    if (!query?.trim()) {
      this.results.set([]);
      return;
    }
    const docPages = this.pdfFacade.pageCount();
    if (docPages === 0) {
      this.results.set([]);
      return;
    }
    this.searching.set(true);
    const hits: SearchHit[] = [];
    const normalized = query.toLowerCase();
    try {
      for (let page = 1; page <= docPages; page += 1) {
        const text = (await this.pdfFacade.getPageText(page)).toLowerCase();
        let idx = text.indexOf(normalized);
        while (idx !== -1) {
          const contextStart = Math.max(0, idx - 40);
          const context = text.slice(contextStart, idx + normalized.length + 40);
          hits.push({
            id: crypto.randomUUID ? crypto.randomUUID() : `hit-${page}-${idx}`,
            page,
            context,
            index: hits.length + 1
          });
          idx = text.indexOf(normalized, idx + normalized.length);
        }
      }
      this.results.set(hits);
    } finally {
      this.searching.set(false);
    }
  }

  clear(): void {
    this.results.set([]);
  }
}
