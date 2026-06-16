// Types shared between the web UI and the backend API responses.

export interface PrInfo {
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  htmlUrl: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "correctness" | "security" | "quality" | "performance";
export type ReviewFocus = "all" | Category;

export interface ReviewComment {
  file: string;
  line: number | null;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  suggestion: string | null;
}

export interface Review {
  summary: string;
  comments: ReviewComment[];
}

export interface ReviewResponse {
  pr: PrInfo;
  review: Review;
}

export interface ReviewConfig {
  model?: string;
  focus?: ReviewFocus;
  maxComments?: number;
}

// Streaming events emitted by POST /api/review/stream.
export type StreamEvent =
  | { type: "pr"; pr: PrInfo }
  | { type: "status"; message: string }
  | { type: "summary"; summary: string }
  | { type: "comment"; comment: ReviewComment }
  | { type: "done"; review: Review }
  | { type: "error"; error: string };
