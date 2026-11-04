export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}
