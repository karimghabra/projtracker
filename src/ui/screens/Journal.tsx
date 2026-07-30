import { useState } from 'react';
import { MONTH_NAMES, addMonths, formatRelativeDay, startOfMonth } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { Empty } from '../components/ui.tsx';
import { IconChevronLeft, IconChevronRight, IconJournal, IconTrash } from '../components/icons.tsx';

export function JournalScreen() {
  const { app, run } = useApp();
  const [cursor, setCursor] = useState(() => startOfMonth(app.today));
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');

  const month = cursor.slice(0, 7);
  const notes = query.trim()
    ? app.journal().filter((n) => n.text.toLowerCase().includes(query.trim().toLowerCase()))
    : app.journal(month);

  const save = () => {
    const clean = text.trim();
    if (!clean) return;
    if (run((a) => a.capture(clean), { silent: true })) setText('');
  };

  const byDay = new Map<string, typeof notes>();
  for (const note of notes) {
    const day = note.at.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(note);
    else byDay.set(day, [note]);
  }

  return (
    <div className="dash">
      <section className="panel span-8">
        <div className="panel-head">
          <IconJournal size={15} />
          <h2>{query.trim() ? `Search: "${query.trim()}"` : `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`}</h2>
          <span className="spacer" />
          {!query.trim() && (
            <>
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
          {notes.length === 0 ? (
            <Empty title={query.trim() ? 'Nothing matches' : 'No notes this month'} icon={<IconJournal size={20} />}>
              Notes are an append-only stream. Write whatever is worth keeping; nothing parses them
              or turns them into tasks.
            </Empty>
          ) : (
            <div className="stack">
              {[...byDay.entries()].map(([day, dayNotes]) => (
                <div key={day}>
                  <div className="journal-day">{formatRelativeDay(day, app.today)}</div>
                  <div className="stack tight">
                    {dayNotes.map((note) => (
                      <div className="journal-note" key={note.id}>
                        <div className="inline" style={{ alignItems: 'flex-start' }}>
                          <span className="mono faint nowrap">{note.at.slice(11, 16)}</span>
                          <div className="grow" style={{ whiteSpace: 'pre-wrap' }}>
                            {note.text}
                            {note.nodeName && (
                              <div>
                                <span className="chip accent">{note.nodeName}</span>
                              </div>
                            )}
                          </div>
                          <button
                            className="btn ghost icon sm"
                            aria-label="Delete note"
                            onClick={() => run((a) => a.deleteNote(note.id))}
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
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
