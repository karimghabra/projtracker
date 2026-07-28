import { useSyncExternalStore } from "react";

import { dismissToast, getToasts, subscribeToasts } from "../state/toasts";

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  return (
    <div className="toast-stack" data-testid="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={"toast" + (t.error ? " err" : "")}
          data-testid="toast"
          role={t.error ? "alert" : "status"}
          onClick={() => dismissToast(t.id)}
          title="Dismiss"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
