/**
 * Shared primitives.
 *
 * Small, unopinionated, and free of domain knowledge — a Chip does not know
 * what a blocked task is, it is told. Anything that decides *which* chip to
 * show belongs in the command layer's read models, not here.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DerivedStatus, Health } from '../../core/model.ts';
import { IconClose, IconWarning } from './icons.tsx';
import { useStore } from '../state/store.ts';

// ------------------------------------------------------------------ modal

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
  labelledBy = 'modal-title',
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    // Move focus in, so the keyboard is not left behind the overlay.
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-close])',
    );
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={ref}
      >
        <div className="modal-head">
          <h2 id={labelledBy}>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close" data-close>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  destructive = true,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={destructive ? 'btn primary' : 'btn primary'}
            style={destructive ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : undefined}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        {destructive && (
          <span style={{ color: 'var(--danger)', flex: 'none', marginTop: 2 }}>
            <IconWarning size={20} />
          </span>
        )}
        <div>{body}</div>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- toasts

export function Toasts() {
  const store = useStore();
  if (!store.toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {store.toasts.map((toast) => (
        <div key={toast.id} className={toast.tone === 'error' ? 'toast error' : 'toast'} role="status">
          <span className="grow">{toast.text}</span>
          <button
            className="btn ghost icon sm"
            onClick={() => store.dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ chips

const STATUS_LABEL: Record<DerivedStatus, string> = {
  ready: 'Ready',
  blocked: 'Blocked',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  dropped: 'Dropped',
};

const STATUS_TONE: Record<DerivedStatus, string> = {
  ready: 'accent',
  blocked: '',
  in_progress: 'info',
  waiting: 'warn',
  done: 'ok',
  dropped: '',
};

/** Always a word, never colour alone. */
export function StatusChip({ status }: { status: DerivedStatus }) {
  return <span className={`chip dot ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

const HEALTH_LABEL: Record<Health, string> = {
  not_begun: 'Not begun',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

const HEALTH_TONE: Record<Health, string> = {
  not_begun: '',
  on_track: 'ok',
  at_risk: 'warn',
  off_track: 'danger',
};

export function HealthChip({ health }: { health: Health }) {
  if (health === 'not_begun') return null;
  return <span className={`chip ${HEALTH_TONE[health]}`}>{HEALTH_LABEL[health]}</span>;
}

export function KindChip({ kind }: { kind: string }) {
  return <span className="chip kind-chip">{kind}</span>;
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="inline" style={{ gap: 8 }}>
      <div className="bar grow" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="faint mono nowrap">
        {done}/{total}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ empty state

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-mark">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------- inline editing

/**
 * Click to edit, Enter to commit, Escape to abandon. Used by the tree, the
 * graph and the sheet so renaming feels the same everywhere.
 */
export function InlineEdit({
  value,
  onCommit,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    // Double-click, not single. A single click belongs to whatever contains
    // this — selecting a row should not drop you into a text field.
    return (
      <button
        /*
          The look lives in a class, not here: an inline style cannot be
          overridden by a stylesheet, and the ready pool needs these names to
          wrap rather than end in an ellipsis.
        */
        className={className ? `inline-edit ${className}` : 'inline-edit'}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            setEditing(true);
          }
        }}
        aria-label={ariaLabel ? `${ariaLabel}: ${value}. Press Enter to rename.` : undefined}
        style={value ? undefined : { color: 'var(--text-faint)' }}
      >
        {value || placeholder || '—'}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== value) onCommit(draft.trim());
    else setDraft(value);
  };

  return (
    <input
      className="input"
      autoFocus
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      style={{ padding: '2px 6px', font: 'inherit' }}
    />
  );
}

/** A single-line add box that clears itself and stays focused. */
export function QuickAdd({
  placeholder,
  onAdd,
  label,
  buttonLabel = 'Add',
  secondary,
}: {
  placeholder: string;
  onAdd: (text: string) => void;
  label: string;
  buttonLabel?: string;
  /**
   * A second destination for the same text. One field, two answers to "when":
   * the primary claims today, this one does not claim anything.
   */
  secondary?: { label: string; title: string; testId?: string; onAdd: (text: string) => void };
}) {
  const [text, setText] = useState('');
  const submit = (to: (text: string) => void = onAdd) => {
    const clean = text.trim();
    if (!clean) return;
    to(clean);
    setText('');
  };

  return (
    <form
      className="inline"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className="input"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
      />
      <button className="btn" type="submit" disabled={!text.trim()}>
        {buttonLabel}
      </button>
      {secondary && (
        <button
          className="btn ghost"
          type="button"
          title={secondary.title}
          data-testid={secondary.testId}
          disabled={!text.trim()}
          onClick={() => submit(secondary.onAdd)}
        >
          {secondary.label}
        </button>
      )}
    </form>
  );
}
