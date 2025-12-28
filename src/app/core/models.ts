export interface PdfPageRender {
  pageNumber: number;
  width: number;
  height: number;
  text?: string;
}

export interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TextOffsets {
  start: number;
  end: number;
}

export interface Marker {
  id: string;
  page: number;
  color: string;
  label: string;
  rects: HighlightRect[];
  text?: string;
  textOffsets?: TextOffsets;
  source: 'search' | 'selection';
  origin?: 'app' | 'pdf';
}

export interface CommentMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface CommentCard {
  id: string;
  title: string;
  page: number;
  anchorX: number;
  anchorY: number;
  bubbleX: number;
  bubbleY: number;
  messages: CommentMessage[];
  createdAt: number;
  bubbleWidth?: number;
  bubbleHeight?: number;
  origin?: 'app' | 'pdf';
}

export interface PdfHighlightAnnotation {
  id: string;
  page: number;
  rects: HighlightRect[];
  color: string;
  contents?: string;
  subject?: string;
}

export interface PdfAnnotationExport {
  highlights: PdfHighlightAnnotation[];
  comments: CommentCard[];
}

export interface PdfLibraryItem {
  id: string;
  name: string;
  displayName: string;
  bytes: ArrayBuffer;
  addedAt: number;
  pageCount?: number;
  thumbnailUrl?: string | null;
  annotations?: {
    userMarkers: Marker[];
    userComments: CommentCard[];
  };
  imported?: {
    markers: Marker[];
    comments: CommentCard[];
  };
}

export interface SearchHit {
  id: string;
  page: number;
  context: string;
  index: number;
}

export type OcrScope = 'page' | 'all';

export interface OcrResult {
  scope: OcrScope;
  page?: number;
  pageCount?: number;
  text: string;
  durationMs: number;
  source: 'text-layer' | 'ocr-simulated';
}

export interface CompareSummary {
  addedPages: number;
  removedPages: number;
  changedPages: number[];
  note: string;
}

export interface TextSpanRects {
  start: number;
  end: number;
  text: string;
  rects: HighlightRect[];
}

export interface PageTextLayout {
  page: number;
  width: number;
  height: number;
  text: string;
  spans: TextSpanRects[];
}
