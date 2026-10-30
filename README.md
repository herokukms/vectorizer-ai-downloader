# Vectorizer.AI Downloader

A Chrome extension that lets you download the vector result from [vectorizer.ai](https://vectorizer.ai) as a complete, full-resolution SVG — for free.

> **Note:** This is an unofficial community tool. It is not affiliated with or endorsed by Vectorizer.AI. Use it responsibly and in accordance with the site's terms of service.

---

## What it does

Vectorizer.AI generates a vector result client-side and normally reserves the SVG download for paying users. This extension reads the vector model directly from the page's in-memory objects, reconstructs a complete SVG (every curve, every shape, not just what's visible on screen), and adds a green **DOWNLOAD SVG** button next to the original paid download link.

### Why not just scrape the canvas?

A simpler approach would be to intercept the `<canvas>` element the site renders to and serialize its pixels. That doesn't work here because:

- The site **culls drawing operations outside the viewport** — loops that aren't visible are skipped entirely.
- Large shapes get their **off-screen bezier segments approximated as straight lines** to save rendering cost.

The result would be an incomplete, viewport-dependent SVG. Instead, this extension grabs the site's `VectorImage` model itself, which contains the full, resolution-independent geometry.

---

## Requirements

- **Google Chrome** (or any Chromium-based browser: Edge, Brave, Opera, Vivaldi, etc.)
- **Developer mode** enabled in the extensions page (needed to load an unpacked extension — see below)

No build step, no dependencies, no Node.js required.

---

## Installation

### Step 1 — Download the extension files

Clone this repository or download it as a ZIP and extract it. You need a folder containing at least:
```text
vectorizer-ai-downloader/
├── manifest.json
└── content.js
```

### Step 2 — Open the extensions page
```text
In Chrome, navigate to:
chrome://extensions/
```

(On Edge: `edge://extensions/`, on Brave: `brave://extensions/`, etc.)

### Step 3 — Enable Developer mode

Toggle the **Developer mode** switch in the top-right corner of the page.

### Step 4 — Load the extension

Click the **Load unpacked** button that appeared, then select the folder containing `manifest.json`.

The extension should now appear in your extensions list. If you see any error, check the **Errors** button on the extension card — it will tell you what went wrong (usually a missing file or a JSON syntax error in `manifest.json`).

### Step 5 — Verify it's active

Make sure the extension toggle is **on** (blue). You can also pin it to the toolbar for quick access, though it has no popup UI.

---

## Usage

1. Go to [vectorizer.ai](https://vectorizer.ai) and upload an image to vectorize as usual.
2. Wait for the vectorization to finish and for the result preview to appear.
3. A green **DOWNLOAD SVG** button should appear next to the original download button.
4. Click it — the SVG is generated locally from the vector model and saved to your downloads folder.

The filename is taken from your original upload (e.g. `logo.png` → `logo.svg`). If the site doesn't expose the original filename for some reason, the file is saved as `vectorized-result.svg`.

### What if the button doesn't appear?

Check the browser console (F12 → Console tab) for messages prefixed with `[Vectorizer.AI Downloader]`:

- `Script injected, waiting for the vector result.` — the script loaded correctly.
- `Vector result captured: N shapes, WxH` — the vector model was successfully intercepted.
- `Original download button found, creating custom button.` — the UI hook succeeded.

If you don't see these messages, the extension may not be running on the page (check that it's enabled and has permission for `vectorizer.ai`). If you see the first two but not the third, the site's UI may have changed and the button selector needs updating (see [Maintenance notes](#maintenance-notes)).

---

## How it works (technical overview)

1. **Model capture.** The site's `VectorImage` instance sets `isReady = true` once all result chunks are loaded. The extension installs a setter on `Object.prototype.isReady` at `document_start` (before the site's own JS runs) to be notified of that assignment, then verifies the instance has the expected shape (`vectorShapes` and `topVectorShapes` arrays) before accepting it.

2. **UI injection.** A `MutationObserver` waits for the site's original `#App-DownloadLink` button to appear, then clones it, restyles it, and rewires its click handler to the extension's SVG export.

3. **SVG generation.** The captured model is serialized to a standalone SVG document, mirroring the site's own rendering order (gap fillers first, then per-shape fills and inner gap fillers) but **without** viewport culling. Curve types are detected by their unminified fields (`controlStartX`, `controlX`, `radiusX`, `radius`) rather than by class name, so the code survives minification.

4. **Download.** The SVG string is wrapped in a `Blob`, exposed via `URL.createObjectURL`, and downloaded through a temporary `<a download>` element.

---

## File structure
```text
vectorizer-ai-downloader/
├── manifest.json # Extension manifest (Manifest V3, content script only)
├── content.js # The entire extension logic (heavily commented)
└── README.md # This file
```

---

## Maintenance notes

This extension relies on a few assumptions about Vectorizer.AI's front-end. If the site is updated, these are the points most likely to break, in order of fragility:

| What | Where | If it breaks... |
|------|-------|-----------------|
| `Object.prototype.isReady` assignment | `content.js`, model capture section | No capture, no button. This is the **most fragile** hook — the property name could be renamed. |
| `#App-DownloadLink` selector | `content.js`, `createDownloadButton()` | The button is never injected. |
| `.showPaid` label span | `content.js`, `createDownloadButton()` | The button text isn't updated (the button still works). |
| Curve field names (`controlStartX`, `radiusX`, etc.) | `content.js`, `curvesToD()` | Unknown curve types fall back to straight lines (`L`), producing a degraded but non-crashing result. |
| `window.ResumeImage.originalFilename` | `content.js`, `onDownloadClick()` | Filename falls back to `vectorized-result.svg`. |
| Full-circle (2π) arcs | `content.js`, `curvesToD()` doc comment | Not observed in practice; if one appears, it would be skipped by the SVG renderer. A two-half split would be needed. |

To debug, open the DevTools console on a vectorizer.ai result page and look for `[Vectorizer.AI Downloader]` log lines. You can also inspect the captured `vectorImage` object by temporarily exposing it on `window` (e.g. `window.__vi = vectorImage` inside the setter) to explore its structure.

---

## Limitations

- **Only works on `vectorizer.ai/images/*` pages** (the result page), not on the upload page or the homepage.
- **Chrome only (and Chromium-based browsers).** The manifest uses Manifest V3, which Firefox supports with minor changes but is not tested here.
- **No popup UI, no options.** The extension is intentionally minimal.
- **Result depends on the site's model.** If Vectorizer.AI changes how it stores vector data, the extension may stop working until updated.

---

## License

MIT — see the original userscript header for attribution.

Based on the original userscript by [k33bs](https://gist.github.com/mateoltd/b976a33bd1c3d106d5c51b3d000a346d), itself a fix of an earlier gist by [mateoltd](https://gist.github.com/mateoltd).

---

## Disclaimer

This tool is provided for personal and educational use. Downloading vectorized output without paying may violate Vectorizer.AI's terms of service. The authors are not responsible for any consequences of using this extension. If you find Vectorizer.AI useful, consider supporting the project by purchasing a subscription.