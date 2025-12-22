import { Injectable, computed, signal } from '@angular/core';
import { CommentCard, CommentMessage, Marker } from '../../core/models';

const DEFAULT_COMMENT_BUBBLE_WIDTH = 240;
const DEFAULT_COMMENT_BUBBLE_HEIGHT = 0;
const DEFAULT_COMMENT_POINTER_CENTER = 50;

@Injectable({ providedIn: 'root' })
export class AnnotationFacadeService {
  private readonly selectionHighlights = signal<Marker[]>([]);
  private readonly searchHighlights = signal<Marker[]>([]);
  private readonly comments = signal<CommentCard[]>([]);

  readonly allMarkers = computed(() => [...this.searchHighlights(), ...this.selectionHighlights()]);
  readonly userMarkers = this.selectionHighlights.asReadonly();
  readonly allComments = this.comments.asReadonly();

  readonly markerCount = computed(() => this.selectionHighlights().length);
  readonly commentCount = computed(() => this.comments().length);

  addMarker(
    page: number,
    rects: Marker['rects'],
    label = '新規ハイライト',
    color = '#ffc0cb',
    source: Marker['source'] = 'selection',
    text?: string
  ): Marker {
    const marker: Marker = {
      id: crypto.randomUUID ? crypto.randomUUID() : `marker-${Date.now()}`,
      page,
      label,
      color,
      rects,
      source,
      text
    };
    if (source === 'search') {
      this.searchHighlights.update((list) => [...list.filter((m) => m.page !== page), marker]);
    } else {
      this.selectionHighlights.update((list) => [...list, marker]);
    }
    return marker;
  }

  updateMarker(id: string, partial: Partial<Marker>): void {
    this.selectionHighlights.update((list) =>
      list.map((m) => (m.id === id ? { ...m, ...partial } : m))
    );
  }

  removeMarker(id: string): void {
    this.selectionHighlights.update((list) => list.filter((m) => m.id !== id));
  }

  moveMarker(id: string, rects: Marker['rects']): void {
    this.selectionHighlights.update((list) =>
      list.map((m) => (m.id === id ? { ...m, rects } : m))
    );
  }

  private createMessage(text: string): CommentMessage {
    return {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      createdAt: Date.now()
    };
  }

  addComment(page: number, x: number, y: number, text = ''): CommentCard {
    const trimmed = text.trim();
    const messages = trimmed ? [this.createMessage(trimmed)] : [];
    const createdAt = messages[0]?.createdAt ?? Date.now();
    const comment: CommentCard = {
      id: crypto.randomUUID ? crypto.randomUUID() : `comment-${Date.now()}`,
      page,
      x,
      y,
      messages,
      createdAt,
      bubbleWidth: DEFAULT_COMMENT_BUBBLE_WIDTH,
      bubbleHeight: DEFAULT_COMMENT_BUBBLE_HEIGHT,
      pointerCenter: DEFAULT_COMMENT_POINTER_CENTER
    };
    this.comments.update((list) => [...list, comment]);
    return comment;
  }

  addReply(commentId: string, text: string): void {
    const message = this.createMessage(text);
    this.comments.update((list) =>
      list.map((c) => (c.id === commentId ? { ...c, messages: [...c.messages, message] } : c))
    );
  }

  updateComment(id: string, text: string): void {
    this.comments.update((list) =>
      list.map((c) => {
        if (c.id !== id) {
          return c;
        }
        if (!c.messages.length) {
          return { ...c, messages: [this.createMessage(text)] };
        }
        const updatedMessages = c.messages.map((m, index) =>
          index === c.messages.length - 1 ? { ...m, text } : m
        );
        return { ...c, messages: updatedMessages };
      })
    );
  }

  updateCommentLayout(
    id: string,
    layout: Partial<Pick<CommentCard, 'bubbleWidth' | 'bubbleHeight' | 'pointerCenter'>>
  ): void {
    this.comments.update((list) => list.map((c) => (c.id === id ? { ...c, ...layout } : c)));
  }

  removeComment(id: string): void {
    this.comments.update((list) => list.filter((c) => c.id !== id));
  }

  moveComment(id: string, x: number, y: number): void {
    this.comments.update((list) => list.map((c) => (c.id === id ? { ...c, x, y } : c)));
  }

  reset(): void {
    this.selectionHighlights.set([]);
    this.searchHighlights.set([]);
    this.comments.set([]);
  }

  commentsByPage(page: number): CommentCard[] {
    return this.comments().filter((c) => c.page === page);
  }

  markersByPage(page: number): Marker[] {
    return this.allMarkers().filter((m) => m.page === page);
  }

  setSearchHighlights(markers: Marker[]): void {
    this.searchHighlights.set(markers);
  }
}
