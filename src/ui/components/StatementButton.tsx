/**
 * The month's statement of work as a workbook: what was done, by project —
 * the record an invoice is written from. One month, because that is what the
 * journal is looking at; the CLI takes any two days.
 */

import { useState } from 'react';
import { useApp } from '../state/store.ts';
import { IconImport } from './icons.tsx';

/** The last day of a YYYY-MM month. */
function lastDayOf(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const days = new Date(year!, mon!, 0).getDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

export function StatementButton({ month }: { month: string }) {
  const { app, store } = useApp();
  const [working, setWorking] = useState(false);

  const save = async () => {
    setWorking(true);
    try {
      const from = `${month}-01`;
      const to = lastDayOf(month);
      const { exportStatement, statementFilename } = await import('../../store/excelExport.ts');
      const bytes = await exportStatement(app.statement(from, to));
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = statementFilename(from, to);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      store.toast(`Saved ${link.download}.`);
    } catch (error) {
      store.toast(
        error instanceof Error ? `Could not write the statement: ${error.message}` : 'Could not write the statement.',
        'error',
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <button
      className="btn sm"
      onClick={save}
      disabled={working}
      data-testid="export-statement"
      title="This month's statement of work, as a spreadsheet"
    >
      <IconImport size={13} className="flip" /> {working ? 'Writing…' : 'Statement'}
    </button>
  );
}
