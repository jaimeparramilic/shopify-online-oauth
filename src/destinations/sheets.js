import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

// ADC (Application Default Credentials): local con `gcloud auth application-default login`,
// o Service Account adjunta al servicio en Cloud Run.
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

export async function ensureTab({ spreadsheetId, sheetName }) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const found = meta.data.sheets?.find(s => s.properties?.title === sheetName);
  if (found) return found.properties.sheetId;

  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  return resp.data.replies?.[0]?.addSheet?.properties?.sheetId;
}

export async function setHeaderIfEmpty({ spreadsheetId, sheetName, header }) {
  const sheets = await getSheetsClient();
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });
  const has = (read.data.values?.[0]?.length || 0) > 0;
  if (has) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header] },
  });
}

export async function appendRows({ spreadsheetId, sheetName, rows }) {
  if (!rows?.length) return { inserted: 0 };
  const sheets = await getSheetsClient();
  const chunk = 1000;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: slice },
    });
    inserted += slice.length;
  }
  return { inserted };
}

export async function writeToSheet({ spreadsheetId, sheetName, header, rows }) {
  await ensureTab({ spreadsheetId, sheetName });
  await setHeaderIfEmpty({ spreadsheetId, sheetName, header });
  return appendRows({ spreadsheetId, sheetName, rows });
}
