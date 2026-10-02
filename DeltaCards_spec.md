# DeltaCard — Specification v2.0 (draft)

Supersedes the v1.0 sketch in `DeltaCards_sketch.txt`. Rewritten around what WebXDC actually allows.

## 1. Vision

A contact-card WebXDC app for Delta Chat. The user keeps one card up to date and shares chosen fields with each chat. Receivers can export cards to their phone as `.vcf`.

Sibling of NostCard: same goal, but Delta Chat is the transport and the trust circle. No relays, no URL-fragment keys, no server.

## 2. Platform constraints (design drivers)

Source: https://webxdc.org/docs/spec/

| Fact | Consequence |
|---|---|
| Every chat message with an `.xdc` is a separate app. Storage is isolated and instances cannot know about each other. | No global master profile in `localStorage`. No cross-chat tracker. No cross-chat broadcast. |
| `localStorage` is per instance and is not synced between devices. | Treat it as a cache only. The source of truth is the replayed update history. |
| `update` has no sender field (`payload`, `serial`, `max_serial`, `info`, `href`, `document`, `summary`, `notify`). | The sender is not authenticated. Identity is claimed in the payload. See §6. |
| `setUpdateListener` also replays your own updates. | A new device or reinstall rebuilds state from history. |
| `sendToChat()` is user-interactive. | It can be used to export files or text. It cannot silently post to other chats. |
| No network access. | Everything is bundled. Vanilla JS, no CDN. |

## 3. Concepts

- **Instance**: the app in one chat. It is the unit of sharing.
- **Master card**: the user's full profile. It lives in the instance's `localStorage` as a cache and travels between instances as a file (§5).
- **Shared card**: the filtered subset of the master card published in one chat.
- **Directory**: all cards received in this chat. It is derived by replaying updates.

## 4. Data model

### Master card (JSON, file extension `.deltacard.json`)

```json
{
  "format": "deltacard-master",
  "v": 1,
  "rev": 1759400000000,
  "fields": {
    "name": "John Doe",
    "mobile": "+1 555-0192",
    "work_phone": "+1 555-9988",
    "email": "john@company.com",
    "org": "", "title": "", "url": "", "address": "",
    "socials": [{ "label": "Matrix", "value": "@john:example.org" }],
    "note": ""
  },
  "signingKey": null
}
```

### Update payloads

```json
{ "t": "card", "v": 1, "addr": "<selfAddr>", "rev": 1759400000000, "fields": { "name": "...", "work_phone": "..." } }
{ "t": "revoke", "v": 1, "addr": "<selfAddr>", "rev": 1759400099999 }
```

- Each `card` carries only the fields allowed for this chat. Nothing else leaves the device.
- Each `card` is a full snapshot, not a diff. A missing field means "no longer shared".
- `rev` is a millisecond timestamp, made monotonic locally as `max(Date.now(), lastRev + 1)`. It is not a plain counter in `localStorage`, so a reset cannot silently lower it. `lastRev` is also recovered from your own replayed updates.
- Receiver rule: per `addr`, keep the highest `rev`. Drop anything with `rev <=` the stored one. A `revoke` is treated as a `card` with no fields.
- Set `update.info` to "<name> updated their card". Never put field values in `info` or `summary`.
- Keep payloads small. No photos in v1. Check the size limit in the `sendUpdate` spec.

## 5. Core flows

### A. First use in a chat

1. Prefill `name` and `email` from `webxdc.selfName` and `webxdc.selfAddr`.
2. Offer: **Import my card** (file picker or paste) or **Fill in manually**.
3. Cache the master card in `localStorage`.

### B. Share in this chat

1. Show master fields with a toggle each. The name is on by default. Everything else is off by default.
2. **Publish** sends a `card` update with the toggled fields.
3. The chosen toggles are saved in the instance. They are also recoverable from your own latest replayed `card` update.
4. A banner states plainly: "Everyone in this chat can see these fields."

### C. Update the card everywhere

There is no silent cross-chat broadcast. The flow is:

1. In any instance, edit the master card. `rev` is bumped.
2. **Export master** saves a `.deltacard.json`, either as a download or through `sendToChat()` to Saved Messages.
3. In each other chat's instance, choose **Import newer master**.
4. The app shows a diff limited to the fields already shared in that chat, and asks "Publish update?". One tap publishes.
5. Fields not previously shared in that chat are never added automatically.

### D. Directory and export

- List of received cards, one entry per claimed `addr`, with search over name, org and title.
- 🟢 badge for cards changed since the last open. The last-seen `serial` is stored in `localStorage`.
- Detail view with **Export to contacts**, which generates a vCard 3.0 `.vcf`. Escape `, ; \` and newlines. Skip empty fields.
- If `<a download>` does not work on a platform, fall back to `webxdc.sendToChat({ file })`. This must be tested on Android, iOS and desktop.

### E. Stop sharing

**Stop sharing here** sends a `revoke`. This is best-effort. Earlier updates stay in the chat history and on other devices, and the UI says so.

### F. Late joiners

Tested in Delta Chat: a member added after the app message was sent does not see the app at all, and starting the app or publishing again in the old instance does not help.

- **Resend (or forward) the app message** after adding the member. Both were reported to work, and the new member then sees the existing cards.
- Show a short hint in the app: "After adding someone to the group, resend this app message."
- Still to verify: whether Resend keeps one shared instance for old and new members, whether forwarding creates a separate instance, and whether Resend is limited to the app's original sender.
- Not needed in v1: exporting and relaying the directory to migrate cards into a new instance. Revisit only if resend or forward turns out to lose the state.

## 6. Identity and trust

- WebXDC gives no authenticated sender. The `addr` in the payload is a claim.
- **v1 (honest labelling)**: show "claimed by <addr>" and the sender's display name. Do not describe cards as verified. Anyone in the chat can post a card claiming any address.
- **v1.1 (hardening, optional)**:
  - Generate an ECDSA P-256 key with WebCrypto. Put the public key and a signature over `{addr, rev, fields}` in every `card`.
  - Receivers pin the public key per `addr` on first sight (TOFU). Later cards must verify against the pinned key.
  - On a key change, show "key changed" and ask the user before accepting.
  - Include the private key in the master export file, so a new device keeps its identity.
  - First contact is still TOFU. An attacker who posts first can pin their own key. A manual comparison of a fingerprint should be possible.

## 7. UI

Two tabs, mobile first.

- **Contacts**: search, list, 🟢 badge, detail with the export button.
- **My card**: master form, per-field share toggles for this chat, Publish, Stop sharing, Re-send, Export master, Import master.

Languages: EN and SV, as in NostCard.

## 8. Privacy notes

- Field toggles apply to the whole chat. Per-recipient fields inside a group are not possible.
- Use a 1:1 chat for the most personal fields.
- Shared data is encrypted in transit by Delta Chat. Each member's device stores it.

## 9. Technical

- Vanilla HTML, CSS and JS with no build step. Zip to `.xdc` with `manifest.toml` and `icon.png`.
- Test with `webxdc-dev` and with real Delta Chat on Android, iOS and desktop.
- Pure functions in a separate module, unit-testable without a browser: `reduceUpdates`, `buildCardPayload`, `diffMaster`, `toVCard`.

## 10. Milestones

1. **M1**: per-chat share, directory, `rev` rule, `.vcf` export, EN/SV.
2. **M2**: master export and import, diff-and-publish, revoke, re-send.
3. **M3**: signed cards with key pinning (§6, v1.1).
4. **M4**: optional extras such as a small photo or custom labelled links.

## 11. Open questions

- Which export path works on all three platforms: `<a download>` or `sendToChat()`?
- Does Resend keep a single instance for old and new members, and can anyone other than the original sender use it?
- What is the maximum update payload size?
- Is a Saved Messages instance good enough as the "home" for the master file, or is a plain file simpler for users?
- Should the master card include a PGP key, given that Delta Chat already handles its own encryption keys?
