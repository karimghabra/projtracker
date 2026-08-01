/**
 * Talking to a Google spreadsheet.
 *
 * This is the only part of the backup that knows Google exists. Everything
 * above it works in `string[][]`, so the mapping is tested against a fake and
 * the real thing has no logic in it worth testing — which is the right split,
 * because the real thing cannot be tested without an account.
 *
 * No client library. The whole protocol is a signed JWT, a token exchange and
 * four REST calls, and `node:crypto` already signs RS256; pulling in
 * googleapis to save forty lines would put tens of megabytes back into an
 * installer that was just cut down from a hundred.
 *
 * Authentication is a service account rather than an OAuth consent flow. That
 * means no client secret baked into a binary that anybody can unzip, no
 * "unverified app" warning, no browser round trip — and credentials the user
 * owns and can revoke without going through us.
 */

import { createSign } from 'node:crypto';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface ServiceAccount {
  clientEmail: string;
  /** PEM, exactly as it appears in the downloaded key file. */
  privateKey: string;
}

/**
 * What the transport needs to do, and nothing more.
 *
 * Small on purpose: a fake implementing these six methods is enough to test
 * every decision the sync makes.
 */
export interface SheetsTransport {
  /** The spreadsheet's own name, so a confirmation can say what it will overwrite. */
  title(): Promise<string>;
  tabs(): Promise<string[]>;
  /** Create the tab if it is missing, and make sure it is big enough for `rows`. */
  writeTab(title: string, rows: string[][]): Promise<void>;
  readTab(title: string): Promise<string[][]>;
  deleteTab(title: string): Promise<void>;
}

// --------------------------------------------------------------- credentials

/**
 * Read a downloaded service account key.
 *
 * Deliberately strict about what it needs and clear about what is missing: the
 * commonest failure here is pasting the wrong JSON file, and "no client_email"
 * is a far better message than a 401 twenty seconds later.
 */
export function parseServiceAccount(json: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That is not a JSON file. Use the key file Google gave you when you created the service account.');
  }

  const record = parsed as Record<string, unknown>;
  if (record['type'] && record['type'] !== 'service_account') {
    throw new Error(`That key is a "${String(record['type'])}", not a service account key.`);
  }

  const clientEmail = typeof record['client_email'] === 'string' ? record['client_email'] : '';
  const privateKey = typeof record['private_key'] === 'string' ? record['private_key'] : '';
  if (!clientEmail) throw new Error('That key file has no client_email in it.');
  if (!privateKey.includes('PRIVATE KEY')) throw new Error('That key file has no private_key in it.');

  // Keys pasted through a text box arrive with the newlines escaped.
  return { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
}

/**
 * A spreadsheet id from whatever the user had in their hand: the id itself, or
 * the URL from the address bar, which is what anybody will actually paste.
 */
export function parseSpreadsheetId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(text);
  if (fromUrl) return fromUrl[1]!;
  return /^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : null;
}

// ------------------------------------------------------------------ the wire

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A range like `'My sheet'!A1`. Single quotes inside a title are doubled. */
function range(title: string, cells = ''): string {
  return encodeURIComponent(`'${title.replace(/'/g, "''")}'${cells ? `!${cells}` : ''}`);
}

export class GoogleSheets implements SheetsTransport {
  private token?: { value: string; expiresAt: number };
  private ids?: Map<string, number>;
  private name?: string;

  constructor(
    private readonly account: ServiceAccount,
    private readonly spreadsheetId: string,
    /** Injected so the token expiry is testable and the clock rule holds. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // A token lasts an hour; a backup takes seconds. Re-using it inside one run
  // is the difference between one round trip to Google and a dozen.
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;

    const issued = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: this.account.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URI,
        iat: issued,
        exp: issued + 3600,
      }),
    );

    let signature: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      signature = base64url(signer.sign(this.account.privateKey));
    } catch {
      throw new Error('That private key could not be used to sign. The key file may be damaged.');
    }

    const response = await fetch(TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      const why = body.error_description ?? body.error ?? `HTTP ${response.status}`;
      throw new Error(
        why.includes('Invalid JWT')
          ? 'Google rejected the credentials. Check the key file, and that this machine’s clock is right.'
          : `Google refused the credentials: ${why}`,
      );
    }

    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const response = await fetch(`${API}/${this.spreadsheetId}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(this.explain(response.status, detail.error?.message));
    }
    return (await response.json()) as T;
  }

  /**
   * Google's own messages are accurate and useless. Two of these three cases
   * are things the user has to fix in a browser, and saying which one saves
   * the twenty minutes it otherwise takes to work out.
   */
  private explain(status: number, message?: string): string {
    if (status === 403) {
      return `The Google spreadsheet has not been shared with ${this.account.clientEmail}. Open it in Google Sheets, press Share, and give that address Editor access.`;
    }
    if (status === 404) {
      return 'No Google spreadsheet with that link. Check the link, or that it has not been deleted.';
    }
    if (status === 429) return 'Google is rate-limiting this account. Wait a minute and try again.';
    return message ? `Google Sheets said: ${message}` : `Google Sheets returned HTTP ${status}.`;
  }

  private async load(): Promise<Map<string, number>> {
    const data = await this.call<{
      properties?: { title?: string };
      sheets?: { properties?: { sheetId?: number; title?: string } }[];
    }>('?fields=properties.title,sheets.properties(sheetId,title)');

    this.name = data.properties?.title ?? '';
    this.ids = new Map(
      (data.sheets ?? [])
        .map((sheet) => [sheet.properties?.title ?? '', sheet.properties?.sheetId ?? -1] as const)
        .filter(([title, id]) => title !== '' && id >= 0),
    );
    return this.ids;
  }

  async title(): Promise<string> {
    if (this.name === undefined) await this.load();
    return this.name ?? '';
  }

  async tabs(): Promise<string[]> {
    return [...(this.ids ?? (await this.load())).keys()];
  }

  private async batch(requests: unknown[]): Promise<void> {
    if (!requests.length) return;
    await this.call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }

  async writeTab(title: string, rows: string[][]): Promise<void> {
    const ids = this.ids ?? (await this.load());
    const width = Math.max(1, ...rows.map((row) => row.length));
    const height = Math.max(1, rows.length);

    if (!ids.has(title)) {
      await this.batch([
        { addSheet: { properties: { title, gridProperties: { rowCount: height, columnCount: width } } } },
      ]);
      await this.load();
    } else {
      // A grid does not grow to fit an update the way appending does, so it is
      // resized first; shrinking it afterwards is what keeps a spreadsheet
      // from accumulating a million empty cells over a year of backups.
      await this.batch([
        {
          updateSheetProperties: {
            properties: { sheetId: ids.get(title), gridProperties: { rowCount: height, columnCount: width } },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ]);
      await this.call(`/values/${range(title)}:clear`, { method: 'POST', body: '{}' });
    }

    await this.call(
      `/values/${range(title, 'A1')}?valueInputOption=RAW&responseValueRenderOption=UNFORMATTED_VALUE`,
      { method: 'PUT', body: JSON.stringify({ values: rows.map((row) => [...row]) }) },
    );
  }

  async readTab(title: string): Promise<string[][]> {
    // RAW on the way in and UNFORMATTED on the way out is the pair that makes
    // the round trip exact: nothing is parsed as a formula, a number or a date
    // in either direction.
    const data = await this.call<{ values?: unknown[][] }>(
      `/values/${range(title)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`,
    );
    return (data.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
  }

  async deleteTab(title: string): Promise<void> {
    const ids = this.ids ?? (await this.load());
    const id = ids.get(title);
    if (id === undefined) return;
    await this.batch([{ deleteSheet: { sheetId: id } }]);
    ids.delete(title);
  }
}
