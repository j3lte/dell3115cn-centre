/** A partial scan (jam, lost connection) is always shown, never only logged. */
export function ProblemLine({ problem }: { problem?: string }) {
  if (!problem) return null;
  return (
    <p className="msg msg-warn" role="alert">
      <strong>Partial scan.</strong> {problem}
    </p>
  );
}
