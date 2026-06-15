// Types shared between the side panel UI and the backend API responses.

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
