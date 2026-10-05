import {
  adoptPublished,
  FIELD_KEYS,
  FIELD_LABELS,
  buildCardPayload,
  diffMaster,
  isBehindChat,
  isStaleImport,
  nextRev,
  parseMaster,
  reduceUpdates,
  sanitizeFields,
  toVCard,
} from './core.js';

const webxdc = window.webxdc;
const selfAddr = webxdc.selfAddr;
const selfName = webxdc.selfName;

const $ = (id) => document.getElementById(id);

// Received data is untrusted: always build DOM with textContent, never innerHTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

// localStorage is only a cache; the card directory is rebuilt from replayed updates.
let master = store.get('dc_master', null) || {
  format: 'contactcard-master',
  v: 1,
  rev: 0,
  fields: { name: selfName, email: selfAddr },
};
let shareKeys = store.get('dc_share', null);
const lastSeen = store.get('dc_lastSeen', 0);

let cards = {};
const cardSerial = {};
let maxSerial = 0;
let selectedAddr = null;

const ownPublished = () => (cards[selfAddr] && !cards[selfAddr].revoked ? cards[selfAddr].fields : {});
const currentShare = () => shareKeys ?? Object.keys(ownPublished());

function formatDate(ms) {
  return new Date(ms).toLocaleString(navigator.language, { dateStyle: 'medium', timeStyle: 'short' });
}

let statusTimer;
function setStatus(text) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status').textContent = ''; }, 6000);
}

function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function sendFileToChat(name, text, message) {
  if (typeof webxdc.sendToChat !== 'function') {
    setStatus('sendToChat is not available here.');
    return;
  }
  try {
    await webxdc.sendToChat({ file: { name, plainText: text }, text: message });
  } catch (e) {
    setStatus(`sendToChat failed: ${e}`);
  }
}

const safeFileName = (s) => (s || 'contact').replace(/[^\w.-]+/g, '_').slice(0, 40);

// ---- Contacts tab ----

function primaryChannel(card) {
  return card.fields.work_phone || card.fields.mobile || card.fields.email || '';
}

function renderContacts() {
  const q = $('search').value.trim().toLowerCase();
  const visible = Object.values(cards)
    .filter((c) => !c.revoked)
    .filter((c) => !q || [c.fields.name, c.fields.org, c.fields.title].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.fields.name || a.addr).localeCompare(b.fields.name || b.addr));

  $('empty').hidden = Object.values(cards).some((c) => !c.revoked);
  const list = $('list');
  list.replaceChildren();
  for (const card of visible) {
    const isNew = card.addr !== selfAddr && cardSerial[card.addr] > lastSeen;
    const title = el('div', {}, card.fields.name || card.addr);
    if (card.addr === selfAddr) title.append(el('span', { class: 'meta' }, ' (you)'));
    if (isNew) title.append(el('span', { class: 'badge' }, '🟢 Updated'));
    list.append(
      el(
        'div',
        { class: 'card', onclick: () => { selectedAddr = card.addr; renderContacts(); } },
        title,
        el('div', {}, primaryChannel(card)),
        el('div', { class: 'meta' }, `Updated ${formatDate(card.rev)} · claimed by ${card.addr}`),
      ),
    );
  }
  renderDetail();
}

function renderDetail() {
  const box = $('detail');
  box.replaceChildren();
  const card = selectedAddr && cards[selectedAddr];
  if (!card || card.revoked) return;

  const dl = el('dl');
  for (const key of FIELD_KEYS) {
    if (!card.fields[key]) continue;
    dl.append(el('dt', {}, FIELD_LABELS[key]), el('dd', {}, card.fields[key]));
  }
  dl.append(el('dt', {}, 'Sender (claimed, not verified)'), el('dd', {}, card.addr));

  const vcf = toVCard(card);
  const fileName = `${safeFileName(card.fields.name)}.vcf`;
  const row = el(
    'div',
    { class: 'row' },
    el('button', { class: 'primary', onclick: () => downloadFile(fileName, vcf, 'text/vcard') }, '📥 Export to phone contacts'),
  );
  if (typeof webxdc.sendToChat === 'function') {
    row.append(el('button', { onclick: () => sendFileToChat(fileName, vcf, card.fields.name || '') }, 'Send .vcf to a chat'));
  }
  box.append(el('div', { class: 'detail' }, dl, row));
}

// ---- My card tab ----

function buildForm() {
  const form = $('master-form');
  form.replaceChildren();
  const checked = new Set(currentShare());
  for (const key of FIELD_KEYS) {
    const input = el('input', { type: 'text', id: `f-${key}`, value: master.fields[key] || '' });
    const share = el('input', { type: 'checkbox', id: `s-${key}`, checked: key === 'name' || checked.has(key), disabled: key === 'name' });
    form.append(
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'name', htmlFor: `f-${key}` }, FIELD_LABELS[key]),
        input,
        el('label', { class: 'share' }, share, ' share'),
      ),
    );
  }
}

const readFormFields = () => sanitizeFields(Object.fromEntries(FIELD_KEYS.map((k) => [k, $(`f-${k}`).value.trim()])));
const readShareKeys = () => FIELD_KEYS.filter((k) => k !== 'name' && $(`s-${k}`).checked);

// Bumps master.rev only when the content actually changed; share toggles never bump it.
function commitForm() {
  const fields = readFormFields();
  if (JSON.stringify(fields) !== JSON.stringify(master.fields)) {
    master = { ...master, rev: nextRev(master.rev, Date.now()), fields };
  }
  shareKeys = readShareKeys();
  master = { ...master, share: shareKeys };
  store.set('dc_master', master);
  store.set('dc_share', shareKeys);
}

function liveCardCount(includeSelf) {
  const addrs = new Set(Object.values(cards).filter((c) => !c.revoked).map((c) => c.addr));
  if (includeSelf) addrs.add(selfAddr);
  else addrs.delete(selfAddr);
  return addrs.size;
}

function publish() {
  commitForm();
  const rev = nextRev(cards[selfAddr]?.rev ?? 0, Date.now());
  // Keep master.rev in the chat's ordering, so an exported master file can be
  // compared against the card published in this chat on any device.
  if (rev > master.rev) {
    master = { ...master, rev };
    store.set('dc_master', master);
  }
  const payload = buildCardPayload(master, shareKeys, selfAddr, rev);
  const count = liveCardCount(true);
  webxdc.sendUpdate({ payload, info: `${selfName} updated their card`, summary: `${count} cards` }, '');
  setStatus('Published to this chat.');
  $('diff').hidden = true;
}

function stopSharing() {
  if (Object.keys(ownPublished()).length === 0) {
    setStatus('Nothing is shared in this chat.');
    return;
  }
  // Keep the toggles so publishing again later is one tap.
  if (shareKeys === null) {
    shareKeys = Object.keys(ownPublished()).filter((k) => k !== 'name');
    store.set('dc_share', shareKeys);
  }
  const rev = nextRev(cards[selfAddr].rev, Date.now());
  const payload = { t: 'revoke', v: 1, addr: selfAddr, rev };
  webxdc.sendUpdate({ payload, info: `${selfName} stopped sharing their card`, summary: `${liveCardCount(false)} cards` }, '');
  setStatus('Stopped sharing in this chat.');
}

function renderDiff() {
  const box = $('diff');
  const published = cards[selfAddr];
  if (!published || published.revoked) {
    box.hidden = true;
    return;
  }
  // Another device published a newer card: offer to adopt it instead of
  // silently republishing this device's stale local values over it.
  const behind = isBehindChat(master, published);
  const keys = behind ? Object.keys(published.fields) : currentShare();
  const changes = diffMaster(master, keys, published.fields);
  if (changes.length === 0) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(
    el('strong', {}, behind
      ? 'The card in this chat is newer than the one here. Adopt it into your master?'
      : 'Your master card changed. Update this chat?'),
  );
  for (const c of changes) {
    // In adopt mode the local master is what changes, so the arrow runs local → published.
    const from = behind ? c.to : c.from;
    const to = behind ? c.from : c.to;
    box.append(
      el('div', {}, `${FIELD_LABELS[c.key]}: `, el('span', { class: 'from' }, from || '(empty)'), ' → ', el('span', { class: 'to' }, to || '(removed)')),
    );
  }
  box.append(
    el(
      'div',
      { class: 'row' },
      behind
        ? el('button', { class: 'primary', onclick: adoptFromChat }, 'Adopt into my master')
        : el('button', { class: 'primary', onclick: publish }, 'Publish update'),
    ),
  );
  box.hidden = false;
}

function adoptFromChat() {
  const published = cards[selfAddr];
  if (!published || published.revoked || !isBehindChat(master, published)) return;
  master = adoptPublished(master, published);
  store.set('dc_master', master);
  buildForm();
  renderDiff();
  setStatus('The card published in this chat is now your master.');
}

function importMaster(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    setStatus('Not valid JSON.');
    return;
  }
  const imported = parseMaster(data);
  if (!imported) {
    setStatus('Not a Contact Card master file.');
    return;
  }
  // The card published in this chat is the only ordering shared with the
  // exporting device; the local master.rev is never compared across devices.
  if (isStaleImport(imported, cards[selfAddr])) {
    setStatus('This chat has a newer card than this file. Publish first, then export a new master.');
    return;
  }
  master = imported;
  store.set('dc_master', master);
  // Toggles chosen in this chat win over the imported defaults.
  if (shareKeys === null && Object.keys(ownPublished()).length === 0) {
    shareKeys = imported.share;
    store.set('dc_share', shareKeys);
  }
  buildForm();
  setStatus('Master card imported.');
  if ($('autopublish').checked) {
    publish();
    setStatus('Master card imported and published.');
    return;
  }
  renderDiff();
}

function exportMaster() {
  commitForm();
  return JSON.stringify(master, null, 2);
}

// ---- Wiring ----

function showTab(name) {
  $('view-contacts').hidden = name !== 'contacts';
  $('view-mycard').hidden = name !== 'mycard';
  $('tab-contacts').classList.toggle('active', name === 'contacts');
  $('tab-mycard').classList.toggle('active', name === 'mycard');
}

$('tab-contacts').onclick = () => showTab('contacts');
$('tab-mycard').onclick = () => showTab('mycard');
$('search').oninput = renderContacts;
$('save-master').onclick = () => {
  commitForm();
  setStatus('Master card saved on this device.');
  renderDiff();
};
$('publish').onclick = publish;

let stopTimer = null;
function disarmStop() {
  clearTimeout(stopTimer);
  stopTimer = null;
  $('stop-sharing').textContent = 'Stop sharing here';
}
$('stop-sharing').onclick = () => {
  if (stopTimer === null) {
    $('stop-sharing').textContent = 'Tap again to confirm';
    stopTimer = setTimeout(disarmStop, 5000);
    return;
  }
  disarmStop();
  stopSharing();
};
$('export-master').onclick = () => downloadFile('contactcard-master.json', exportMaster(), 'application/json');
// importFiles opens Delta Chat's picker with recent attachments; the plain input is the fallback.
$('import-file-btn').onclick = async () => {
  if (typeof webxdc.importFiles !== 'function') {
    $('import-file').click();
    return;
  }
  try {
    const [file] = await webxdc.importFiles({ extensions: ['.json'], mimeTypes: ['application/json'] });
    if (file) importMaster(await file.text());
  } catch (e) {
    setStatus(`Import failed: ${e}`);
  }
};
$('import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (file) importMaster(await file.text());
  e.target.value = '';
};
$('import-paste').onclick = () => importMaster($('import-text').value);
$('autopublish').checked = store.get('dc_autopublish', false);
$('autopublish').onchange = (e) => store.set('dc_autopublish', e.target.checked);
$('spoof').onclick = () => {
  const victim = Object.keys(cards).find((a) => a !== selfAddr) ?? 'victim@example.org';
  const rev = nextRev(cards[victim]?.rev ?? 0, Date.now());
  const payload = { t: 'card', v: 1, addr: victim, rev, fields: { name: `Spoofed by ${selfName}`, mobile: '000' } };
  webxdc.sendUpdate({ payload, info: 'A card was updated' }, '');
};

if (typeof webxdc.sendToChat === 'function') {
  $('export-master').after(
    el('button', { type: 'button', onclick: () => sendFileToChat('contactcard-master.json', exportMaster(), 'My Contact Card master') }, 'Send master to a chat'),
  );
}

function saveLastSeen() {
  store.set('dc_lastSeen', maxSerial);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveLastSeen();
});
window.addEventListener('pagehide', saveLastSeen);

// Until the user chooses, the share toggles mirror what the replayed own card already exposes.
function syncShareBoxes() {
  if (shareKeys !== null) return;
  const published = new Set(Object.keys(ownPublished()));
  for (const key of FIELD_KEYS) {
    if (key !== 'name') $(`s-${key}`).checked = published.has(key);
  }
}

function renderAll() {
  syncShareBoxes();
  renderContacts();
  renderDiff();
}

buildForm();
renderAll();

webxdc.setUpdateListener((update) => {
  maxSerial = Math.max(maxSerial, update.serial);
  const next = reduceUpdates(cards, update.payload);
  if (next !== cards) {
    cards = next;
    cardSerial[update.payload.addr] = update.serial;
  }
  if (update.serial === update.max_serial) renderAll();
}, 0);
