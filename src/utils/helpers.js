// src/utils/helpers.js
import crypto from 'crypto';

export const toFloat = (v) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === 'nan') return undefined;
    const normalized = s.replace(/\./g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : undefined;
};

export const toInt = (v, d = 1) => {
    const n = Number(String(v ?? '').trim());
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
};

export const safeStr = (v) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s && s.toLowerCase() !== 'nan' ? s : undefined;
};

export const financialStatus = (estado) => {
    const v = (estado ?? '').toLowerCase();
    return ['pagado', 'paid', 'cerrada', 'cerrado'].includes(v) ? 'paid' : 'pending';
};

export const idempotencyKey = (row) => {
    const base =
      safeStr(row['NUM_SERIE']) ||
      safeStr(row['REFERENCIA']) ||
      `${safeStr(row['CLIENTE']) ?? ''}-${safeStr(row['Fecha_ISO']) ?? ''}-${safeStr(row['Valor']) ?? ''}`;
    return crypto.createHash('sha256').update(String(base || Date.now())).digest('hex');
};

export const normErrors = (errs = []) =>
    (Array.isArray(errs) ? errs : []).map(e => ({
        field: Array.isArray(e?.field) ? e.field.join('.') : (e?.field ?? null),
        message: e?.message ?? String(e),
    }));