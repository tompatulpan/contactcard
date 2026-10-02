// Pure logic shared by the app and the Node tests; no DOM or webxdc access here.

export const FIELD_KEYS = ['name', 'mobile', 'work_phone', 'email', 'org', 'title', 'url', 'address', 'note'];

export const FIELD_LABELS = {
  name: 'Name',
  mobile: 'Mobile',
  work_phone: 'Work phone',
  email: 'Email',
  org: 'Organisation',
  title: 'Title',
  url: 'Website',
  address: 'Address',
  note: 'Note',
};

const isFilled = (v) => typeof v === 'string' && v !== '';

export function nextRev(lastRev, now) {
  return Math.max(now, lastRev + 1);
}

// Only keeps known keys with non-empty string values, because payloads come from untrusted peers.
export function sanitizeFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const key of FIELD_KEYS) {
    if (isFilled(fields[key])) out[key] = fields[key];
  }
  return out;
}

export function buildCardPayload(master, allowedFields, addr, rev) {
  const keys = new Set(['name', ...allowedFields]);
  const fields = {};
  for (const key of keys) {
    if (FIELD_KEYS.includes(key) && isFilled(master.fields[key])) fields[key] = master.fields[key];
  }
  return { t: 'card', v: 1, addr, rev, fields };
}

// Keeps the highest rev per claimed addr; `revoke` is a card with no fields.
export function reduceUpdates(state, payload) {
  if (!payload || (payload.t !== 'card' && payload.t !== 'revoke')) return state;
  if (typeof payload.addr !== 'string' || payload.addr === '' || !Number.isFinite(payload.rev)) return state;
  const current = state[payload.addr];
  if (current && payload.rev <= current.rev) return state;
  const revoked = payload.t === 'revoke';
  return {
    ...state,
    [payload.addr]: {
      addr: payload.addr,
      rev: payload.rev,
      fields: revoked ? {} : sanitizeFields(payload.fields),
      revoked,
    },
  };
}

// Only fields already shared in this chat are proposed; new fields are never added automatically.
export function diffMaster(master, sharedKeys, publishedFields) {
  const keys = new Set(['name', ...sharedKeys]);
  const changes = [];
  for (const key of FIELD_KEYS) {
    if (!keys.has(key)) continue;
    const from = publishedFields[key] ?? '';
    const to = master.fields[key] ?? '';
    if (from !== to) changes.push({ key, from, to });
  }
  return changes;
}

const escapeVCard = (s) =>
  s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

export function toVCard(card) {
  const f = card.fields;
  const name = f.name || card.addr;
  const space = name.lastIndexOf(' ');
  const given = space === -1 ? name : name.slice(0, space);
  const family = space === -1 ? '' : name.slice(space + 1);

  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`FN:${escapeVCard(name)}`);
  lines.push(`N:${escapeVCard(family)};${escapeVCard(given)};;;`);
  if (f.org) lines.push(`ORG:${escapeVCard(f.org)}`);
  if (f.title) lines.push(`TITLE:${escapeVCard(f.title)}`);
  if (f.mobile) lines.push(`TEL;TYPE=CELL:${escapeVCard(f.mobile)}`);
  if (f.work_phone) lines.push(`TEL;TYPE=WORK:${escapeVCard(f.work_phone)}`);
  if (f.email) lines.push(`EMAIL:${escapeVCard(f.email)}`);
  if (f.url) lines.push(`URL:${escapeVCard(f.url)}`);
  if (f.address) lines.push(`ADR;TYPE=HOME:;;${escapeVCard(f.address)};;;;`);
  if (f.note) lines.push(`NOTE:${escapeVCard(f.note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}
