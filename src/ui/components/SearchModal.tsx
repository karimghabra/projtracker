import { useState } from 'react';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';
import type { ViewName } from '../AppShell.tsx';

export function SearchModal({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (view: ViewName) => void;
}) {
  const { app } = useApp();
  const [query, setQuery] = useState('');
  const hits = app.search(query).slice(0, 40);

  return (
    <Modal title="Search" onClose={onClose}>
      <input
        className="input"
        autoFocus
        value={query}
        placeholder="Names, notes, tags…"
        aria-label="Search"
        data-testid="search-input"
        onChange={(event) => setQuery(event.target.value)}
      />

      {query.trim() && (
        <div className="list">
          {hits.length === 0 && <p className="faint">Nothing matches.</p>}
          {hits.map((hit) => (
            <button
              key={`${hit.kind}-${hit.id}`}
              className="row"
              style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                onNavigate(hit.kind === 'note' ? 'journal' : 'projects');
                onClose();
              }}
            >
              <span className="chip kind-chip">{hit.kind}</span>
              <span className="grow row-title">{hit.title}</span>
              <span className="faint mono">{hit.context}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
