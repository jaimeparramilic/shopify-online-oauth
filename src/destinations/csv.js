import fs from 'fs';
import path from 'path';

function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}



/**
 * Escribe/append en CSV. Crea carpeta y header si el archivo no existe o está vacío.
 * @param {string} filePath Ruta del CSV
 * @param {string[]} header Encabezados
 * @param {Array<Array<any>>} rows Filas
 * @param {boolean} includeBom Incluir BOM UTF-8 (útil para Excel)
 */
export async function writeCsv({ filePath, header, rows, includeBom = false }) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  let writeHeader = true;
  try {
    const st = await fs.promises.stat(filePath);
    writeHeader = st.size === 0;
  } catch {
    writeHeader = true;
  }

  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  if (includeBom && writeHeader) stream.write('\uFEFF');
  if (writeHeader) stream.write(header.map(toCsvValue).join(',') + '\n');
  for (const r of rows) stream.write(r.map(toCsvValue).join(',') + '\n');

  await new Promise((res, rej) => {
    stream.on('error', rej);
    stream.end(res);
  });

  return { written: rows.length, filePath };
}
