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

export interface Marker {
  id: string;
  page: number;
  color: string;
  label: string;
  rects: HighlightRect[];
  text?: string;
  source: 'search' | 'selection';
}

export interface CommentMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface CommentCard {
  id: string;
  page: number;
  x: number;
  y: number;
  messages: CommentMessage[];
  createdAt: number;
  bubbleWidth?: number;
  bubbleHeight?: number;
  pointerCenter?: number;
}

export interface SearchHit {
  id: string;
  page: number;
  context: string;
  index: number;
}

export interface OcrResult {
  page: number;
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
