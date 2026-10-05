import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptPublished, buildCardPayload, diffMaster, isBehindChat, isStaleImport, nextRev, parseMaster, reduceUpdates, toVCard } from '../src/core.js';

const master = {
  format: 'deltacard-master',
  v: 1,
  rev: 1,
  fields: {
    name: 'John Doe',
    mobile: '+1 555-0192',
    work_phone: '+1 555-9988',
    email: 'john@company.com',
    address: 'Home street 1',
  },
};

const apply = (payloads) => payloads.reduce(reduceUpdates, {});

test('field filtering: unshared fields never leave the device', () => {
  const p = buildCardPayload(master, ['work_phone', 'email'], 'john@company.com', 10);
  assert.deepEqual(Object.keys(p.fields).sort(), ['email', 'name', 'work_phone']);
  assert.equal(p.fields.mobile, undefined);
  assert.equal(p.fields.address, undefined);
});

test('field filtering: name is always included, unknown keys are ignored', () => {
  const p = buildCardPayload(master, ['__proto__', 'secret'], 'a@x', 10);
  assert.deepEqual(Object.keys(p.fields), ['name']);
});

test('rev rule: out-of-order and duplicate updates keep the newest card', () => {
  const card = (rev, phone) => ({ t: 'card', addr: 'a@x', rev, fields: { name: 'A', work_phone: phone } });
  const state = apply([card(3, 'three'), card(1, 'one'), card(2, 'two'), card(3, 'dup')]);
  assert.equal(state['a@x'].rev, 3);
  assert.equal(state['a@x'].fields.work_phone, 'three');
});

test('rev rule: a newer card replaces fields no longer shared', () => {
  const state = apply([
    { t: 'card', addr: 'a@x', rev: 1, fields: { name: 'A', mobile: '1' } },
    { t: 'card', addr: 'a@x', rev: 2, fields: { name: 'A' } },
  ]);
  assert.equal(state['a@x'].fields.mobile, undefined);
});

test('rev rule: nextRev stays monotonic when the clock goes backwards', () => {
  assert.equal(nextRev(100, 50), 101);
  assert.equal(nextRev(100, 500), 500);
});

test('rev rule: malformed payloads are ignored', () => {
  const state = apply([
    null,
    { t: 'other', addr: 'a@x', rev: 1 },
    { t: 'card', addr: '', rev: 1 },
    { t: 'card', addr: 'a@x', rev: 'x' },
  ]);
  assert.deepEqual(state, {});
});

test('known v1 limitation: a spoofed addr claim with a higher rev overwrites the victim', () => {
  // WebXDC updates carry no authenticated sender; signed cards (spec §6, v1.1) would change this.
  const state = apply([
    { t: 'card', addr: 'alice@x', rev: 1, fields: { name: 'Alice', mobile: '111' } },
    { t: 'card', addr: 'alice@x', rev: 2, fields: { name: 'Mallory', mobile: '666' } },
  ]);
  assert.equal(state['alice@x'].fields.name, 'Mallory');
});

test('revoke: clears fields but keeps the entry marked as revoked', () => {
  const state = apply([
    { t: 'card', addr: 'a@x', rev: 1, fields: { name: 'A' } },
    { t: 'revoke', addr: 'a@x', rev: 2 },
  ]);
  assert.equal(state['a@x'].revoked, true);
  assert.deepEqual(state['a@x'].fields, {});
});

test('diff-publish: only previously shared fields are proposed', () => {
  const edited = {
    ...master,
    rev: 2,
    fields: { ...master.fields, work_phone: '+1 555-0000', mobile: '+1 555-1111' },
  };
  const published = { name: 'John Doe', work_phone: '+1 555-9988' };
  const changes = diffMaster(edited, ['work_phone'], published);
  assert.deepEqual(changes, [{ key: 'work_phone', from: '+1 555-9988', to: '+1 555-0000' }]);
});

test('diff-publish: no change yields no proposal; removed value counts as change', () => {
  assert.deepEqual(diffMaster(master, ['email'], { name: 'John Doe', email: 'john@company.com' }), []);
  const cleared = { ...master, fields: { ...master.fields, email: '' } };
  assert.deepEqual(diffMaster(cleared, ['email'], { name: 'John Doe', email: 'john@company.com' }), [
    { key: 'email', from: 'john@company.com', to: '' },
  ]);
});

test('vCard: envelope, structure and escaping', () => {
  const vcf = toVCard({
    addr: 'a@x',
    rev: 1,
    fields: { name: 'Jane Q Doe', work_phone: '+1 555', org: 'Acme, Inc.; HQ', note: 'line1\nline2' },
  });
  const lines = vcf.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCARD');
  assert.equal(lines[1], 'VERSION:3.0');
  assert.ok(lines.includes('FN:Jane Q Doe'));
  assert.ok(lines.includes('N:Doe;Jane Q;;;'));
  assert.ok(lines.includes('TEL;TYPE=WORK:+1 555'));
  assert.ok(lines.includes('ORG:Acme\\, Inc.\\; HQ'));
  assert.ok(lines.includes('NOTE:line1\\nline2'));
  assert.equal(lines[lines.length - 2], 'END:VCARD');
});

test('vCard: empty fields are skipped and addr is the FN fallback', () => {
  const vcf = toVCard({ addr: 'a@x', rev: 1, fields: {} });
  assert.ok(vcf.includes('FN:a@x'));
  assert.ok(!vcf.includes('TEL'));
  assert.ok(!vcf.includes('EMAIL'));
});

test('master: default share toggles survive export and import, and are sanitized', () => {
  const parsed = parseMaster({
    format: 'deltacard-master',
    rev: 5,
    fields: { name: 'A', mobile: '1', junk: 'x' },
    share: ['mobile', 'name', 'bogus', '__proto__'],
  });
  assert.deepEqual(parsed.share, ['mobile']);
  assert.deepEqual(parsed.fields, { name: 'A', mobile: '1' });
  assert.equal(parsed.rev, 5);
});

test('master: older files without share load with no defaults; invalid files are rejected', () => {
  assert.deepEqual(parseMaster({ format: 'deltacard-master', rev: 1, fields: { name: 'A' } }).share, []);
  assert.equal(parseMaster({ format: 'other', fields: {} }), null);
  assert.equal(parseMaster({ format: 'deltacard-master', fields: null }), null);
  assert.equal(parseMaster(null), null);
});

test('import guard: an older file is stale only when its shared fields differ from the published card', () => {
  const published = { addr: 'a@x', rev: 20, revoked: false, fields: { name: 'A', mobile: 'new' } };
  const olderSame = { fields: { name: 'A', mobile: 'new', org: 'unshared' }, rev: 10 };
  const olderDiffers = { fields: { name: 'A', mobile: 'old' }, rev: 10 };
  assert.equal(isStaleImport(olderSame, published), false);
  assert.equal(isStaleImport(olderDiffers, published), true);
});

test('import guard: newer files and missing publications are accepted', () => {
  const published = { addr: 'a@x', rev: 20, revoked: false, fields: { name: 'A', mobile: 'new' } };
  const newerDiffers = { fields: { name: 'A', mobile: 'newer still' }, rev: 30 };
  assert.equal(isStaleImport(newerDiffers, published), false);
  assert.equal(isStaleImport({ fields: { name: 'A' }, rev: 0 }, undefined), false);
  assert.equal(isStaleImport({ fields: { name: 'A' }, rev: 0 }, { ...published, revoked: true }), false);
});

test('diff direction: the banner adopts only when the chat card is newer', () => {
  const published = { addr: 'a@x', rev: 20, revoked: false, fields: { name: 'A' } };
  assert.equal(isBehindChat({ rev: 10 }, published), true);
  assert.equal(isBehindChat({ rev: 20 }, published), false);
  assert.equal(isBehindChat({ rev: 30 }, published), false);
  assert.equal(isBehindChat({ rev: 0 }, undefined), false);
  assert.equal(isBehindChat({ rev: 10 }, { ...published, revoked: true }), false);
});

test('adopt: a newer published card overwrites only the keys it carries', () => {
  const local = { fields: { name: 'Old', mobile: '111', note: 'private' }, rev: 10 };
  const published = { addr: 'a@x', rev: 20, revoked: false, fields: { name: 'New', mobile: '222' } };
  const adopted = adoptPublished(local, published);
  assert.deepEqual(adopted.fields, { name: 'New', mobile: '222', note: 'private' });
  assert.equal(adopted.rev, 20);
});

test('adopt: keys absent from the chat card stay local', () => {
  const local = { fields: { name: 'A', mobile: '111' }, rev: 20 };
  const published = { addr: 'a@x', rev: 30, revoked: false, fields: { name: 'A' } };
  assert.deepEqual(adoptPublished(local, published).fields, { name: 'A', mobile: '111' });
});
