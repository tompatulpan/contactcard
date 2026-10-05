# Contact Card

A contact-card [WebXDC](https://webxdc.org) app for [Delta Chat](https://delta.chat).

Keep one card up to date and publish a chosen subset of it to each chat. Everyone in the chat sees a directory of published cards and can export any card to their phone's contacts as a vCard (`.vcf`). No server, no relay — Delta Chat is the transport and the trust circle.

## How to use

1. Send `dist/contactcard.xdc` to a chat and open it.
2. Fill in your card in **My card**, tick the fields you want visible in this chat, and press **Publish**.
3. Other members do the same. The **Contacts** tab lists all published cards, with an export button on each.
4. **Export master** saves your full card as a `.contactcard.json` file. Send it to your Saved Messages chat to keep a backup that moves with you to a new device, and **Import master** there to continue editing.

Fields you do not tick never leave your device. Stopping sharing removes your card from the directory, but copies others already saw or exported stay with them.

## Development

Vanilla HTML, CSS and JS, no build step.

```
npm test     # unit tests for the pure logic in src/core.js
npm run dev  # run in the webxdc-dev simulator
npm run build  # zip src/ into dist/contactcard.xdc
```

## Status

Work in progress. The current design and roadmap are in [`ContactCard_spec.md`](ContactCard_spec.md). Cards carry a claimed sender address only; WebXDC cannot authenticate senders, so the UI labels cards as claims, never as verified. Signed cards with key pinning are planned as a later milestone.

## License

TBD
