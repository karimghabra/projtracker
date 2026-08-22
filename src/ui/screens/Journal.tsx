import { useState } from 'react';
import { MONTH_NAMES, addMonths, formatRelativeDay, startOfMonth } from '../../core/dates.ts';
import type { LogEntry } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Empty } from '../components/ui.tsx';
import { StatementButton } from '../components/StatementButton.tsx';
import { IconChevronLeft, IconChevronRight, IconEdit, IconJournal, IconTrash } from '../components/icons.tsx';

/**
 * The journal is the manifest: everything recorded, read by the day. Notes sit
 * in the same stream as completions, fabrications, batch movements and run
 * steps, because "what did I do on the day the staining worked" is one
 * question, not four. Notes stay editable in place; everything else here is a
 * reading of records that live elsewhere, so it has no buttons.
 */

const KIND_TONE: Record<LogEntry['kind'], string> = {
  note: '',
  done: 'ok',
  batch: 'info',
  'batch-state': 'info',
  run: 'accent',
  'run-step': 'accent',
};

const KIND_WORD: Record<LogEntry['kind'], string> = {
  note: '',
  done: 'done',
  batch: 'inventory',
  'batch-state': 'inventory',
  run: 'run',
  'run-step': 'step',
};

export function JournalScreen() {
  const { app, run } = useApp();
  const [cursor, setCursor] = useState(() => startOfMonth(app.today));
  const [notesOnly, setNotesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const month = cursor.slice(0, 7);
  const searching = query.trim().length > 0;
  const entries: LogEntry[] = searching
    ? app
        .log()
        .filter((e) => e.kind === 'note' && e.text.toLowerCase().includes(query.trim().toLowerCase()))
    : app.log(month).filter((e) => (notesOnly ? e.kind === 'note' : true));

  const save = () => {
    const clean = text.trim();
    if (!clean) return;
    if (run((a) => a.capture(clean), { silent: true })) setText('');
  };

  const byDay = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  // Newest day first — a notebook is read backwards from today — but a day
  // itself reads forwards, morning to evening.
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return (
    <div className="dash">
      <section className="panel span-8">
        <div className="panel-head">
          <IconJournal size={15} />
          <h2>{searching ? `Search: "${query.trim()}"` : `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`}</h2>
          <span className="spacer" />
          {!searching && (
            <>
              <StatementButton month={month} />
              <button
                className={notesOnly ? 'btn sm' : 'btn sm primary'}
                aria-pressed={!notesOnly}
                data-testid="log-everything"
                onClick={() => setNotesOnly(false)}
              >
                Everything
              </button>
              <button
                className={notesOnly ? 'btn sm primary' : 'btn sm'}
                aria-pressed={notesOnly}
                data-testid="log-notes-only"
                onClick={() => setNotesOnly(true)}
              >
                Notes
              </button>
              <button
                className="btn ghost icon"
                onClick={() => setCursor(addMonths(cursor, -1))}
                aria-label="Previous month"
              >
                <IconChevronLeft />
              </button>
              <button
                className="btn ghost icon"
                onClick={() => setCursor(addMonths(cursor, 1))}
                aria-label="Next month"
              >
                <IconChevronRight />
              </button>
            </>
          )}
        </div>

        <div className="panel-body">
          {entries.length === 0 ? (
            <Empty
              title={searching ? 'Nothing matches' : notesOnly ? 'No notes this month' : 'Nothing recorded this month'}
              icon={<IconJournal size={20} />}
            >
              Write whatever is worth keeping, as it happens — and correct it later if it needs
              correcting. Completions, fabrications and run steps take their place here on their
              own.
            </Empty>
          ) : (
            <div className="stack">
              {days.map(([day, dayEntries]) => (
                <div key={day}>
                  <div className="journal-day">{formatRelativeDay(day, app.today)}</div>
                  <div className="stack tight">
                    {dayEntries.map((entry) =>
                      entry.kind === 'note' ? (
                        <NoteEntry
                          key={entry.noteId}
                          entry={entry}
                          editing={editing === entry.noteId}
                          draft={draft}
                          onDraft={setDraft}
                          onEdit={() => {
                            setDraft(entry.text);
                            setEditing(entry.noteId!);
                          }}
                          onCancel={() => setEditing(null)}
                          onSave={() => {
                            if (run((a) => a.editNote(entry.noteId!, draft), { silent: true })) {
                              setEditing(null);
                            }
                          }}
                          onDelete={() => run((a) => a.deleteNote(entry.noteId!))}
                        />
                      ) : (
                        <div className="journal-note" key={`${entry.kind}-${entry.at}-${entry.text}`} data-testid="log-entry">
                          <div className="inline" style={{ alignItems: 'flex-start' }}>
                            <span className="mono faint nowrap">{entry.at.slice(11, 16)}</span>
                            <div className="grow">
                              {entry.text}
                              {entry.period && <span className="chip warn" style={{ marginLeft: 6 }}>{entry.period}</span>}
                              {entry.parentPath && <div className="row-sub">{entry.parentPath}</div>}
                            </div>
                            <span className={`chip ${KIND_TONE[entry.kind]}`}>{KIND_WORD[entry.kind]}</span>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="span-4 stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Write</h2>
          </div>
          <div className="panel-body">
            <textarea
              className="textarea"
              style={{ minHeight: 130 }}
              value={text}
              placeholder="Ctrl+Enter to save"
              aria-label="Write a note"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <button className="btn primary" style={{ marginTop: 8 }} onClick={save} disabled={!text.trim()}>
              Save note
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Search</h2>
          </div>
          <div className="panel-body">
            <input
              className="input"
              value={query}
              placeholder="Find a note"
              aria-label="Search notes"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function NoteEntry({
  entry,
  editing,
  draft,
  onDraft,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}: {
  entry: LogEntry;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="journal-note">
      <div className="inline" style={{ alignItems: 'flex-start' }}>
        <span className="mono faint nowrap">{entry.at.slice(11, 16)}</span>
        {editing ? (
          <form
            className="inline grow"
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <input
              className="input"
              autoFocus
              value={draft}
              aria-label="Edit the note"
              data-testid="journal-edit-field"
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCancel();
              }}
            />
            <button className="btn sm primary" type="submit">
              Save
            </button>
          </form>
        ) : (
          <>
            <div className="grow" style={{ whiteSpace: 'pre-wrap' }}>
              {entry.text}
              {entry.nodeName && (
                <div>
                  <span className="chip accent" title={entry.parentPath}>{entry.nodeName}</span>
                </div>
              )}
            </div>
            <button
              className="btn ghost icon sm"
              aria-label={`Edit the note from ${entry.at.slice(11, 16)}`}
              data-testid={`journal-edit-${entry.noteId}`}
              onClick={onEdit}
            >
              <IconEdit size={13} />
            </button>
            <button className="btn ghost icon sm" aria-label="Delete note" onClick={onDelete}>
              <IconTrash size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
