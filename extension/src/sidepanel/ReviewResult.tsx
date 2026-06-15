import type { ReviewResponse, ReviewComment, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function ReviewResult({ data }: { data: ReviewResponse }) {
  const { pr, review } = data;
  const comments = [...review.comments].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <div className="result">
      <section className="pr-meta">
        <a className="pr-title" href={pr.htmlUrl} target="_blank" rel="noreferrer">
          {pr.title}
        </a>
        <div className="pr-sub">
          by {pr.author} · {pr.baseRef} ← {pr.headRef} · {pr.changedFiles} files{" "}
          <span className="add">+{pr.additions}</span> <span className="del">-{pr.deletions}</span>
        </div>
      </section>

      <section className="summary">
        <h2>Summary</h2>
        <p>{review.summary}</p>
      </section>

      <section className="comments">
        <h2>
          Findings <span className="count">{comments.length}</span>
        </h2>
        {comments.length === 0 ? (
          <div className="info-box">No issues found. The changes look good.</div>
        ) : (
          comments.map((c, i) => <CommentCard key={i} comment={c} />)
        )}
      </section>
    </div>
  );
}

function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <div className="comment-card">
      <div className="comment-head">
        <span className={`badge sev-${comment.severity}`}>{comment.severity}</span>
        <span className={`badge cat-${comment.category}`}>{comment.category}</span>
      </div>
      <div className="comment-title">{comment.title}</div>
      <div className="comment-loc">
        {comment.file}
        {comment.line != null ? `:${comment.line}` : ""}
      </div>
      <p className="comment-desc">{comment.description}</p>
      {comment.suggestion && (
        <div className="suggestion">
          <div className="suggestion-label">Suggestion</div>
          <pre>{comment.suggestion}</pre>
        </div>
      )}
    </div>
  );
}
