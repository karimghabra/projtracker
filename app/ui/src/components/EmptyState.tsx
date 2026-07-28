import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  text: ReactNode;
  action?: ReactNode;
  testid?: string;
}

export function EmptyState({ icon, text, action, testid }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid={testid}>
      {icon && <div className="empty-icon">{icon}</div>}
      <p>{text}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
