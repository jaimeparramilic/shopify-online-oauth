// src/utils/customer.js
import { shopify } from '../config/shopify.js';

const DEFAULT_EMAIL = 'no@gmail.com';
const DEFAULT_FIRST = 'sin';
const DEFAULT_LAST = 'nombre';

export const isValidEmail = (e) => !!(e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim()));

export const splitName = (nameIn) => {
    if (!nameIn) return { first: DEFAULT_FIRST, last: DEFAULT_LAST };
    const parts = String(nameIn).trim().split(/\s+/);
    const first = parts.shift() || DEFAULT_FIRST;
    const last = parts.length ? parts.join(' ') : DEFAULT_LAST;
    return { first, last };
};

const customersCache = new Map(); // email -> customerId

export async function ensureCustomerId({ session, email, first, last, phone }) {
    const clean = String(email || '').trim().toLowerCase();
    if (!isValidEmail(clean)) return null;
    if (customersCache.has(clean)) return customersCache.get(clean);

    const gql = new shopify.clients.Graphql({ session });
    const found = await gql.query({
        data: {
            query: `query FindCustomer($q: String!) { customers(first: 1, query: $q) { edges { node { id legacyResourceId } } } }`,
            variables: { q: `email:${clean}` },
        },
    });

    const legacyIdRaw = found?.body?.data?.customers?.edges[0]?.node?.legacyResourceId;
    const numericIdFromGQL = legacyIdRaw != null ? Number(legacyIdRaw) : null;
    if (Number.isFinite(numericIdFromGQL)) {
        customersCache.set(clean, numericIdFromGQL);
        return numericIdFromGQL;
    }

    const rest = new shopify.clients.Rest({ session });
    const create = await rest.post({
        path: 'customers',
        data: { customer: { email: clean, first_name: first, last_name: last, phone, tags: ['csv-import'] } },
        type: 'json',
    });

    const createdNumericId = create?.body?.customer?.id ?? null;
    if (Number.isFinite(createdNumericId)) {
        customersCache.set(clean, createdNumericId);
        return createdNumericId;
    }
    return null;
}