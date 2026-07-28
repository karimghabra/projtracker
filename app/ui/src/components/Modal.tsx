import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  testid?: string;
}

/**
 * Native <dialog>, opened modally (Escape closes it, focus is trapped by the
 * browser). Content is only mounted while open so per-open state resets.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  testid,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className}
      data-testid={testid}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {open && (
        <>
          <h3>{title}</h3>
          <div className="body">{children}</div>
          {footer && <div className="actions">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
