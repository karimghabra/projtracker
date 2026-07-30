/**
 * Writing the board out as a workbook.
 *
 * The vault is already plain text, so this is not a backup — it is for the
 * people who want a spreadsheet: a supervisor, a collaborator, a grant report.
 * Whatever it writes, the importer reads back into the same shape.
 */

import { useState } from 'react';
import { useApp } from '../state/store.ts';
import { IconImport } from './icons.tsx';

export function ExportButton() {
  const { app, store } = useApp();
  const [working, setWorking] = useState(false);

  const save = async () => {
    setWorking(true);
    try {
      const { exportWorkbook, exportFilename } = await import('../../store/excelExport.ts');
      const bytes = await exportWorkbook(app.state, app.today);
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(app.today);
      document.body.append(link);
      link.click();
      link.remove();
      // Revoke on the next turn: revoking synchronously races the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);

      store.toast(`Saved ${link.download}.`);
    } catch (error) {
      store.toast(
        error instanceof Error ? `Could not export: ${error.message}` : 'Could not export.',
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
      data-testid="export-xlsx"
      title="Write everything out as a spreadsheet"
    >
      <IconImport size={13} className="flip" /> {working ? 'Exporting…' : 'Export'}
    </button>
  );
}
