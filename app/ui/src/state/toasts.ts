/** Tiny module-level toast bus; the Toasts component subscribes. */

export interface ToastMsg {
  id: number;
  text: string;
  error: boolean;
}

let nextId = 1;
let items: ToastMsg[] = [];
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

export function toast(text: string, error = false): void {
  const t: ToastMsg = { id: nextId++, text, error };
  items = [...items, t];
  emit();
  // errors persist longer, as before
  setTimeout(() => dismissToast(t.id), error ? 9000 : 5000);
}

export function dismissToast(id: number): void {
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

export function getToasts(): ToastMsg[] {
  return items;
}

export function subscribeToasts(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
