import { Injectable, computed, signal } from '@angular/core';
import { CommentCard, CommentMessage, Marker } from '../../core/models';

const DEFAULT_COMMENT_BUBBLE_WIDTH = 260;
const DEFAULT_COMMENT_BUBBLE_HEIGHT = 140;
const DEFAULT_COMMENT_BUBBLE_OFFSET = 0.12;

@Injectable({ providedIn: 'root' })
export class AnnotationFacadeService {
  private readonly selectionHighlights = signal<Marker[]>([]);
  private readonly searchHighlights = signal<Marker[]>([]);
  private readonly comments = signal<CommentCard[]>([]);
  private readonly importedMarkers = signal<Marker[]>([]);
  private readonly importedComments = signal<CommentCard[]>([]);

  readonly allMarkers = computed(() => [
    ...this.searchHighlights(),
    ...this.selectionHighlights(),
    ...this.importedMarkers()
  ]);
  readonly userMarkers = computed(() => [
    ...this.selectionHighlights(),
    ...this.importedMarkers()
  ]);
  readonly exportMarkers = this.selectionHighlights.asReadonly();
  readonly allComments = computed(() => [...this.comments(), ...this.importedComments()]);
  readonly exportComments = this.comments.asReadonly();

  readonly markerCount = computed(
    () => this.selectionHighlights().length + this.importedMarkers().length
  );
  readonly commentCount = computed(
    () => this.comments().length + this.importedComments().length
  );

  addMarker(
    page: number,
    rects: Marker['rects'],
    label = '新規ハイライト',
    color = 'var(--color-highlight-default)',
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
      text,
      origin: 'app'
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
    const anchorX = this.clamp01(x);
    const anchorY = this.clamp01(y);
    const offsetX = anchorX > 0.6 ? -DEFAULT_COMMENT_BUBBLE_OFFSET : DEFAULT_COMMENT_BUBBLE_OFFSET;
    const offsetY = anchorY > 0.6 ? -DEFAULT_COMMENT_BUBBLE_OFFSET : DEFAULT_COMMENT_BUBBLE_OFFSET;
    const bubbleX = this.clamp01(anchorX + offsetX);
    const bubbleY = this.clamp01(anchorY + offsetY);
    const titleIndex = this.comments().length + 1;
    const title = `コメント${titleIndex}`;
    const comment: CommentCard = {
      id: crypto.randomUUID ? crypto.randomUUID() : `comment-${Date.now()}`,
      title,
      page,
      anchorX,
      anchorY,
      bubbleX,
      bubbleY,
      messages,
      createdAt,
      bubbleWidth: DEFAULT_COMMENT_BUBBLE_WIDTH,
      bubbleHeight: DEFAULT_COMMENT_BUBBLE_HEIGHT,
      origin: 'app'
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

  updateCommentTitle(id: string, title: string): void {
    const nextTitle = title.trim();
    this.comments.update((list) =>
      list.map((c) => (c.id === id ? { ...c, title: nextTitle } : c))
    );
  }

  updateCommentLayout(
    id: string,
    layout: Partial<Pick<CommentCard, 'bubbleWidth' | 'bubbleHeight'>>
  ): void {
    this.comments.update((list) => list.map((c) => (c.id === id ? { ...c, ...layout } : c)));
  }

  removeComment(id: string): void {
    this.comments.update((list) => list.filter((c) => c.id !== id));
  }

  moveCommentAnchor(id: string, anchorX: number, anchorY: number): void {
    this.comments.update((list) =>
      list.map((c) => (c.id === id ? { ...c, anchorX, anchorY } : c))
    );
  }

  moveCommentBubble(id: string, bubbleX: number, bubbleY: number): void {
    this.comments.update((list) =>
      list.map((c) => (c.id === id ? { ...c, bubbleX, bubbleY } : c))
    );
  }

  reset(): void {
    this.selectionHighlights.set([]);
    this.searchHighlights.set([]);
    this.comments.set([]);
    this.importedMarkers.set([]);
    this.importedComments.set([]);
  }

  commentsByPage(page: number): CommentCard[] {
    return this.allComments().filter((c) => c.page === page);
  }

  markersByPage(page: number): Marker[] {
    return this.allMarkers().filter((m) => m.page === page);
  }

  setSearchHighlights(markers: Marker[]): void {
    this.searchHighlights.set(markers);
  }

  snapshotUserAnnotations(): { userMarkers: Marker[]; userComments: CommentCard[] } {
    return {
      userMarkers: this.cloneMarkers(this.selectionHighlights()),
      userComments: this.cloneComments(this.comments())
    };
  }

  restoreUserAnnotations(
    snapshot: { userMarkers: Marker[]; userComments: CommentCard[] } | null
  ): void {
    this.setUserMarkers(snapshot?.userMarkers ?? []);
    this.setUserComments(snapshot?.userComments ?? []);
  }

  setUserMarkers(markers: Marker[]): void {
    this.selectionHighlights.set(this.cloneMarkers(markers));
  }

  setUserComments(comments: CommentCard[]): void {
    this.comments.set(this.cloneComments(comments));
  }

  setImportedMarkers(markers: Marker[]): void {
    this.importedMarkers.set(markers);
  }

  setImportedComments(comments: CommentCard[]): void {
    this.importedComments.set(comments);
  }

  private cloneMarkers(markers: Marker[]): Marker[] {
    return markers.map((marker) => ({
      ...marker,
      rects: marker.rects.map((rect) => ({ ...rect }))
    }));
  }

  private cloneComments(comments: CommentCard[]): CommentCard[] {
    return comments.map((comment) => ({
      ...comment,
      messages: comment.messages.map((message) => ({ ...message }))
    }));
  }

  private clamp01(value: number): number {
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}
