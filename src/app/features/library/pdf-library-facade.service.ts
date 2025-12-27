import { isPlatformBrowser } from '@angular/common';
import { inject, Injectable, PLATFORM_ID, computed, signal } from '@angular/core';
import { PDF_WORKER_SRC } from '../../core/pdf-worker';
import { PdfLibraryItem } from '../../core/models';
import { AnnotationFacadeService } from '../annotations/annotation-facade.service';
import { PdfFacadeService } from '../pdf/pdf-facade.service';

type ThumbnailResult = {
  url: string | null;
  pageCount?: number;
};

@Injectable({ providedIn: 'root' })
export class PdfLibraryFacadeService {
  private readonly platformId: Object = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

  private readonly itemsSignal = signal<PdfLibraryItem[]>([]);
  private readonly selectedIdSignal = signal<string | null>(null);
  private selectionResetHandler: (() => void) | null = null;
  private readonly thumbnailInFlight = new Set<string>();
  private selecting = false;
  private selectingPromise: Promise<void> | null = null;
  private pendingSelection: string | null = null;

  readonly items = this.itemsSignal.asReadonly();
  readonly selectedId = this.selectedIdSignal.asReadonly();
  readonly selectedItem = computed(() => {
    const id = this.selectedIdSignal();
    if (!id) {
      return null;
    }
    return this.itemsSignal().find((item) => item.id === id) ?? null;
  });
  readonly selectedIndex = computed(() => {
    const id = this.selectedIdSignal();
    if (!id) {
      return -1;
    }
    return this.itemsSignal().findIndex((item) => item.id === id);
  });
  readonly hasPrev = computed(() => this.selectedIndex() > 0);
  readonly hasNext = computed(() => {
    const index = this.selectedIndex();
    return index >= 0 && index < this.itemsSignal().length - 1;
  });

  constructor(
    private readonly pdf: PdfFacadeService,
    private readonly annotations: AnnotationFacadeService
  ) {}

  setSelectionResetHandler(handler: (() => void) | null): void {
    this.selectionResetHandler = handler;
  }

  async addFiles(files: File[]): Promise<number> {
    const pdfFiles = files.filter((file) => this.isPdfFile(file));
    if (!pdfFiles.length) {
      return 0;
    }
    const baseTime = Date.now();
    const current = this.itemsSignal();
    let nextItems = [...current];
    const added: PdfLibraryItem[] = [];
    for (const [index, file] of pdfFiles.entries()) {
      try {
        const bytes = await file.arrayBuffer();
        const displayName = this.buildDisplayName(file.name, nextItems);
        const item: PdfLibraryItem = {
          id: this.buildRandomId(),
          name: file.name,
          displayName,
          bytes,
          addedAt: baseTime + index
        };
        nextItems = [...nextItems, item];
        added.push(item);
      } catch (err) {
        console.warn('Failed to read PDF file.', err);
      }
    }
    if (!added.length) {
      return 0;
    }
    this.itemsSignal.set(nextItems);
    await this.select(added[added.length - 1].id);
    return added.length;
  }

  async select(id: string): Promise<void> {
    if (!id) {
      return;
    }
    this.pendingSelection = id;
    if (this.selecting) {
      return this.selectingPromise ?? Promise.resolve();
    }
    this.selecting = true;
    const run = (async () => {
      try {
        while (this.pendingSelection) {
          const nextId = this.pendingSelection;
          this.pendingSelection = null;
          await this.performSelect(nextId);
        }
      } finally {
        this.selecting = false;
        this.selectingPromise = null;
      }
    })();
    this.selectingPromise = run;
    await run;
  }

  async selectNext(): Promise<void> {
    const index = this.selectedIndex();
    if (index < 0) {
      return;
    }
    const items = this.itemsSignal();
    const next = items[index + 1];
    if (!next) {
      return;
    }
    await this.select(next.id);
  }

  async selectPrev(): Promise<void> {
    const index = this.selectedIndex();
    if (index <= 0) {
      return;
    }
    const items = this.itemsSignal();
    const prev = items[index - 1];
    if (!prev) {
      return;
    }
    await this.select(prev.id);
  }

  async ensureThumbnails(): Promise<void> {
    if (!this.isBrowser) {
      return;
    }
    const items = this.itemsSignal();
    for (const item of items) {
      if (item.thumbnailUrl !== undefined || this.thumbnailInFlight.has(item.id)) {
        continue;
      }
      this.thumbnailInFlight.add(item.id);
      try {
        const result = await this.createThumbnail(item.bytes);
        this.updateItem(item.id, {
          thumbnailUrl: result.url,
          pageCount: result.pageCount ?? item.pageCount
        });
      } catch (err) {
        console.warn('Failed to generate PDF thumbnail.', err);
        this.updateItem(item.id, { thumbnailUrl: null });
      } finally {
        this.thumbnailInFlight.delete(item.id);
      }
    }
  }

  async remove(id: string): Promise<void> {
    await this.removeMany([id]);
  }

  async removeMany(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids.filter((id) => id)));
    if (!unique.length) {
      return;
    }

    await (this.selectingPromise ?? Promise.resolve());

    const removeSet = new Set(unique);
    const currentItems = this.itemsSignal();
    if (!currentItems.length) {
      return;
    }

    const selectedId = this.selectedIdSignal();
    const selectedIndex = selectedId
      ? currentItems.findIndex((item) => item.id === selectedId)
      : -1;
    const remaining = currentItems.filter((item) => !removeSet.has(item.id));
    if (remaining.length === currentItems.length) {
      return;
    }

    this.itemsSignal.set(remaining);
    unique.forEach((id) => {
      this.thumbnailInFlight.delete(id);
      if (this.pendingSelection === id) {
        this.pendingSelection = null;
      }
    });

    if (!selectedId || !removeSet.has(selectedId)) {
      return;
    }

    if (!remaining.length) {
      await this.clearSelection();
      return;
    }

    const fallbackIndex = selectedIndex >= 0 ? Math.min(selectedIndex, remaining.length - 1) : 0;
    const nextId = remaining[fallbackIndex]?.id ?? null;
    if (!nextId) {
      await this.clearSelection();
      return;
    }
    await this.select(nextId);
  }

  async clear(): Promise<void> {
    await (this.selectingPromise ?? Promise.resolve());
    this.pendingSelection = null;
    this.thumbnailInFlight.clear();
    this.itemsSignal.set([]);
    await this.clearSelection();
  }

  private async performSelect(id: string): Promise<void> {
    const target = this.findItem(id);
    if (!target) {
      return;
    }
    const currentId = this.selectedIdSignal();
    if (currentId === id && this.pdf.pageCount() > 0) {
      return;
    }
    if (currentId && currentId !== id) {
      const snapshot = this.annotations.snapshotUserAnnotations();
      this.updateItem(currentId, { annotations: snapshot });
    }
    this.selectedIdSignal.set(id);
    this.selectionResetHandler?.();
    this.annotations.setUserMarkers([]);
    this.annotations.setUserComments([]);
    this.annotations.setImportedMarkers([]);
    this.annotations.setImportedComments([]);
    await this.pdf.loadBytes(target.bytes, target.name);
    const pageCount = this.pdf.pageCount();
    if (pageCount && pageCount !== target.pageCount) {
      this.updateItem(id, { pageCount });
    }
    let imported = this.findItem(id)?.imported ?? null;
    if (!imported) {
      try {
        imported = await this.pdf.readPdfAnnotations();
      } catch (err) {
        console.warn('PDF annotation import failed.', err);
        imported = { markers: [], comments: [] };
      }
      this.updateItem(id, { imported });
    }
    const safeImported = imported ?? { markers: [], comments: [] };
    this.annotations.setImportedMarkers(safeImported.markers);
    this.annotations.setImportedComments(safeImported.comments);
    const userSnapshot = this.findItem(id)?.annotations ?? null;
    this.annotations.restoreUserAnnotations(userSnapshot);
  }

  private findItem(id: string): PdfLibraryItem | null {
    return this.itemsSignal().find((item) => item.id === id) ?? null;
  }

  private updateItem(id: string, partial: Partial<PdfLibraryItem>): void {
    this.itemsSignal.update((items) =>
      items.map((item) => (item.id === id ? { ...item, ...partial } : item))
    );
  }

  private async clearSelection(): Promise<void> {
    const currentId = this.selectedIdSignal();
    if (currentId) {
      const snapshot = this.annotations.snapshotUserAnnotations();
      this.updateItem(currentId, { annotations: snapshot });
    }
    this.selectedIdSignal.set(null);
    this.selectionResetHandler?.();
    this.annotations.reset();
    await this.pdf.reset();
  }

  private buildDisplayName(name: string, items: PdfLibraryItem[]): string {
    const existing = new Set(items.map((item) => item.displayName));
    if (!existing.has(name)) {
      return name;
    }
    let index = 2;
    let candidate = `${name} (${index})`;
    while (existing.has(candidate)) {
      index += 1;
      candidate = `${name} (${index})`;
    }
    return candidate;
  }

  private isPdfFile(file: File): boolean {
    if (file.type === 'application/pdf') {
      return true;
    }
    if (!file.type) {
      return /\.pdf$/i.test(file.name);
    }
    return false;
  }

  private buildRandomId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `pdf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private async createThumbnail(bytes: ArrayBuffer): Promise<ThumbnailResult> {
    if (!this.isBrowser) {
      return { url: null };
    }
    const pdfjs = await this.ensurePdfJs();
    const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    try {
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const targetWidth = 150;
      const scale = viewport.width ? targetWidth / viewport.width : 1;
      const scaledViewport = page.getViewport({ scale });
      const outputScale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) {
        return { url: null, pageCount: doc.numPages };
      }
      canvas.width = Math.floor(scaledViewport.width * outputScale);
      canvas.height = Math.floor(scaledViewport.height * outputScale);
      canvas.style.width = `${scaledViewport.width}px`;
      canvas.style.height = `${scaledViewport.height}px`;
      context.save();
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.restore();
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      await page.render({ canvasContext: context, viewport: scaledViewport, transform }).promise;
      return { url: canvas.toDataURL('image/png'), pageCount: doc.numPages };
    } finally {
      await doc.destroy();
    }
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
}
