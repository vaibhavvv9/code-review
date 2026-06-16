import type { PrInfo, ReviewComment } from "../types.js";

export function ReviewResult({
  pr,
  summary,
  comments,
}: {
  pr: PrInfo | null;
  summary: string;
  comments: ReviewComment[];
}) {
  return (
    <div className="result">
      {pr && (
        <section className="pr-meta">
          <a className="pr-title" href={pr.htmlUrl} target="_blank" rel="noreferrer">
            {pr.title}
          </a>
          <div className="pr-sub">
            by {pr.author} · {pr.baseRef} ← {pr.headRef} · {pr.changedFiles} files{" "}
            <span className="add">+{pr.additions}</span>{" "}
            <span className="del">-{pr.deletions}</span>
          </div>
        </section>
      )}

      {summary && (
        <section className="summary">
          <h2>Summary</h2>
          <p>{summary}</p>
        </section>
      )}

      <section className="comments">
        <h2>
          Findings <span className="count">{comments.length}</span>
        </h2>
        {comments.length === 0 ? (
          <div className="info-box">No issues yet.</div>
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
