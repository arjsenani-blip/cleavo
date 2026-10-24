# Cooky

A personal build of [CardMirror](https://github.com/ant981228/cardmirror) 1.15.0 for Public Forum debate.
It reads and writes the same Verbatim `.docx` files, with these additions:

| Feature | How to use it | Shortcut |
| --- | --- | --- |
| **Create PF Cite** | Run it, paste an article link. It reads the page and writes the full NSDA cite — author, qualifications, full date, title, publication, URL, date accessed — ending with your signature (`// arjun 🦡`, Settings → Cite signature). An empty tag line goes above the cite, with the cursor in it, for your tag. It never cuts or highlights the card. It asks Claude only when something (usually qualifications) can't be found on the page or the author's profile page. | ⌘⌥X |
| **Evidence Search** | Sign in with your Tabroom account, describe the card you want in plain words, and insert results as their authors cut them. Uses AI to plan searches and rank cards when AI is on; keyword search otherwise. | ⌘⌥⇧E |
| **Case mode / Block mode** | Case mode puts a glow around each card by its role — cyan uniqueness, gold link, orange internal link, red impact — and shows each missing piece as an empty pink box where it belongs, with **Find evidence**. The Argument Map sidebar lists the same thing per contention. The glows are display-only: nothing is written into the document or the `.docx`. | ⌘⌥⇧M |
| **Save to Downloads** | Writes a `.docx` copy straight into `~/Downloads` (no dialog; a taken name gets " (2)"). | ⌘⌥⇧S |
| **Page view** | The document sits in the middle of the window as a page, like a PDF. Settings → Appearance → Page view. | — |
| **Shrink (Verbatim-style)** | Select a whole card and press ⌘8: only plain, unread text shrinks — underlined, emphasized, bold, highlighted and shaded text stays full size. | ⌘8 |
| **Tag fix** | F7 never turns a cite into tag text. A selection that touches the cite keeps it as the card's cite. F7 on a cite gives it an empty tag above. | F7 |

Settings → Comments & AI also has **OpenCaselist caselist** (leave empty for the newest Public Forum caselist).

## Build

```bash
npm install && npm --prefix apps/desktop install
npm run desktop:pack     # → apps/desktop/release/mac-universal/Cooky.app
```

Auto-update is off in this build: CardMirror's own updates would replace it.

## License

Required Notice: Copyright (c) 2026 Anthony Trufanov. CardMirror is licensed under the
PolyForm Noncommercial License 1.0.0 (see `LICENSE`). Cooky is a modified version for
personal, noncommercial use and is distributed under the same license.
