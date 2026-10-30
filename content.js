/**
 * Vectorizer.AI Downloader - Content Script
 * ==========================================
 *
 * PURPOSE
 * -------
 * Vectorizer.AI generates a vectorized result (SVG-like geometry) client-side and
 * only reveals the SVG download to paying users. This content script reads the
 * vector model directly from the page's in-memory objects and reconstructs a
 * complete SVG, then injects a free download button next to the original one.
 *
 * WHY NOT CANVAS SCRAPING?
 * ------------------------
 * A simpler approach would be to intercept the <canvas> the site renders to and
 * serialize its pixels. That does NOT work here:
 *   - The site culls drawing operations outside the viewport (loops that are not
 *     visible are skipped entirely).
 *   - Large shapes get their off-screen bezier segments approximated as straight
 *     lines to save rendering cost.
 * The result would be an incomplete, viewport-dependent SVG. Instead, we grab the
 * site's `VectorImage` model object itself, which contains the full, resolution-
 * independent geometry, and serialize every curve from it.
 *
 * HOW WE CAPTURE THE MODEL
 * ------------------------
 * The site sets `isReady = true` on its `VectorImage` instance once all result
 * chunks have been loaded and committed. By defining a setter for `isReady` on
 * `Object.prototype`, we get notified the moment that assignment happens,
 * regardless of which (minified) class the instance belongs to. We then verify
 * the instance has the expected shape (`vectorShapes` and `topVectorShapes`
 * arrays) before accepting it.
 *
 * EXECUTION CONTEXT
 * -----------------
 * This runs as a Chrome content script in the default ISOLATED world. Content
 * scripts share the DOM with the page but not its JavaScript globals. However,
 * built-in constructors like `Object` are shared, which is why patching
 * `Object.prototype` works. We do NOT need `"world": "MAIN"` in the manifest.
 *
 * RUN TIMING
 * ----------
 * `run_at: "document_start"` is REQUIRED. The `Object.prototype.isReady` hook
 * must be installed before the site's own JavaScript runs, otherwise we miss
 * the assignment. Do not change this to `document_idle` or `document_end`.
 */

(function () {
    'use strict';

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * The captured `VectorImage` instance from the page.
     * Null until the site signals readiness. Once set, it is never replaced
     * (the site creates a single instance per vectorization result).
     * @type {object|null}
     */
    let vectorImage = null;

    /**
     * Reference to the custom download button we inject into the page UI.
     * Used as a guard to ensure the button is only created once.
     * @type {HTMLAnchorElement|null}
     */
    let customDownloadButton = null;

    console.log('[Vectorizer.AI Downloader] Script injected, waiting for the vector result.');

    // =========================================================================
    // MODEL CAPTURE
    // =========================================================================

    /**
     * Hook `isReady` on `Object.prototype` to detect when the site's
     * `VectorImage` instance becomes ready.
     *
     * We use a getter/setter pair backed by a private `__isReady` field so we
     * do not change the observable behavior of the property for the page's own
     * code. The setter fires on EVERY assignment to `isReady` on ANY object;
     * we filter for the one object that carries the vector model.
     *
     * Filter criteria (`vectorShapes` and `topVectorShapes` being present) are
     * deliberately loose: class names are minified and may change between
     * site deployments, but these property names are part of the model's
     * public shape and are unlikely to be renamed without breaking the site
     * itself.
     */
    Object.defineProperty(Object.prototype, 'isReady', {
        get() {
            return this.__isReady;
        },
        set(value) {
            this.__isReady = value;

            // `value === true` narrows to the readiness transition.
            // The two array checks confirm we are looking at the vector model.
            if (value === true && this.vectorShapes && this.topVectorShapes) {
                vectorImage = this;
                console.log(
                    `[Vectorizer.AI Downloader] Vector result captured: ` +
                    `${this.vectorShapes.length} shapes, ` +
                    `${this.imageWidth}x${this.imageHeight}`
                );
                createDownloadButton();
            }
        },
        configurable: true // Allow the page (or a future script) to redefine if needed.
    });

    // =========================================================================
    // UI INJECTION
    // =========================================================================

    /**
     * Locate the site's original download button and insert a styled clone
     * next to it that triggers our SVG export instead.
     *
     * The button is not present in the DOM at the time the model is captured
     * (the site renders its UI asynchronously), so we use a MutationObserver
     * to wait for it to appear. We disconnect the observer as soon as the
     * button has been handled to avoid unnecessary work.
     */
    function createDownloadButton() {
        // Idempotency guard: if the button already exists, do nothing.
        if (customDownloadButton) return;

        const observer = new MutationObserver((_mutations, obs) => {
            const originalButton = document.querySelector('#App-DownloadLink');
            if (!originalButton) return;

            console.log('[Vectorizer.AI Downloader] Original download button found, creating custom button.');

            // Clone the original so we inherit its classes, layout, and styles.
            // We then override the parts we need: id, href, and background color.
            customDownloadButton = originalButton.cloneNode(true);
            customDownloadButton.id = 'custom-download-button';
            customDownloadButton.href = '#'; // Neutralize the original (paid) link.
            customDownloadButton.style.backgroundColor = '#5cb85c'; // Distinct green.

            // The label lives inside a `.showPaid` span in the site's markup.
            // Update it if present; the button still works without it.
            const textSpan = customDownloadButton.querySelector('.showPaid');
            if (textSpan) textSpan.textContent = 'DOWNLOAD SVG';

            // Insert our button just before the original one.
            originalButton.parentNode.insertBefore(customDownloadButton, originalButton);

            // Use capture-phase listening and stop propagation so the site's
            // own click handlers never see this event.
            customDownloadButton.addEventListener('click', onDownloadClick, true);

            obs.disconnect();
        });

        // Observe the whole document for the button's appearance.
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Click handler for the custom download button.
     * Builds the SVG, triggers a browser download, and cleans up the object URL.
     * @param {MouseEvent} e
     */
    function onDownloadClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const svgContent = buildSvgFromData();
        const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        // Prefer the original filename (e.g. "logo.png" -> "logo.svg").
        // `ResumeImage.originalFilename` is the site's public hook for this;
        // fall back to a generic name if it is unavailable.
        let filename = 'vectorized-result.svg';
        if (window.ResumeImage && window.ResumeImage.originalFilename) {
            filename = window.ResumeImage.originalFilename.replace(/\.[^/.]+$/, '.svg');
        }

        // A hidden anchor + click is the standard way to trigger a download
        // from a Blob URL without navigating away from the page.
        const tempLink = document.createElement('a');
        tempLink.href = url;
        tempLink.download = filename;
        document.body.appendChild(tempLink);
        tempLink.click();
        document.body.removeChild(tempLink);

        // Release the Blob's memory. Safe to call immediately after `click()`.
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // SVG GENERATION
    // =========================================================================

    /**
     * Serialize the captured `VectorImage` model into a complete standalone SVG
     * document.
     *
     * This mirrors the site's own `VectorImage.drawTo()` rendering order, but
     * WITHOUT viewport culling, so every curve is emitted:
     *
     *   1. Gap fillers at the top level (2px non-scaling strokes that hide
     *      seams between adjacent shapes).
     *   2. For each shape, in model order:
     *      a. The shape's fill (a single path combining all its outer loops).
     *      b. The gap fillers for each of its inner loops (index !== 0), which
     *         hide seams around holes.
     *
     * Shapes with fully transparent fill (alpha === 0) are skipped to avoid
     * emitting no-op paths.
     *
     * @returns {string} A complete SVG document as a string.
     */
    function buildSvgFromData() {
        const vi = vectorImage;
        const out = [];

        /**
         * Emit the stroke-interface paths for a list of "gap filler" objects.
         * Each interface is drawn as a non-scaling 2px stroke using the
         * interface's ARGB color (alpha packed in the top byte).
         * @param {Array<{shouldDraw: () => boolean, argbInt: number, curves: Array}>} list
         */
        const strokeInterfaces = (list) => {
            for (const i of list) {
                if (!i.shouldDraw()) continue;
                // ARGB int -> 6-digit hex (drop alpha byte) + normalized alpha.
                const hex = '#' + (i.argbInt & 0xffffff).toString(16).padStart(6, '0');
                const alpha = (i.argbInt >>> 24) / 255;
                out.push(
                    `<path d="${curvesToD(i.curves)}" fill="none" ` +
                    `${paint('stroke', hex, alpha)} vector-effect="non-scaling-stroke"/>`
                );
            }
        };

        // 1. Top-level gap fillers. `topVectorShapes[i].vectorLoops[0]` holds the
        //    outer loop of each top shape, and its `vectorInterfacesToDraw` list
        //    contains the gap fillers for that region.
        for (const top of vi.topVectorShapes) {
            strokeInterfaces(top.vectorLoops[0].vectorInterfacesToDraw);
        }

        // 2. Per-shape fills and inner gap fillers.
        for (const shape of vi.vectorShapes) {
            const color = vi.userPalette.getMutRgba(shape.paletteIndex);

            // Skip shapes with fully transparent fill (nothing to draw).
            if (color.a !== 0) {
                // Combine all drawable outer loops into one `<path>`. Each loop
                // is closed with ' Z' so non-zero/even-odd fill rules behave
                // the same as the site's canvas fill.
                const d = shape.vectorLoopsToDraw
                    .map((loop) => curvesToD(loop.curveLoop.curves) + ' Z')
                    .join(' ');
                if (d) {
                    out.push(`<path d="${d}" ${paint('fill', color.toCssRgbHex(), color.a)}/>`);
                }
            }

            // Inner loop gap fillers: loop.index === 0 is the outer boundary
            // (already handled by the fill), so we skip it here.
            for (const loop of shape.vectorLoops) {
                if (loop.index !== 0) {
                    strokeInterfaces(loop.vectorInterfacesToDraw);
                }
            }
        }

        // Assemble the final document. viewBox, width, and height all use the
        // model's own image dimensions so the SVG renders at its native size.
        const w = vi.imageWidth;
        const h = vi.imageHeight;
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" ` +
            `viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
            // Wrap everything in a <g> that carries the shared stroke styling
            // used by every gap filler. Individual paths can still override.
            `<g stroke-width="2" stroke-linejoin="bevel">${out.join('')}</g>` +
            `</svg>`
        );
    }

    // =========================================================================
    // PRIMITIVE HELPERS
    // =========================================================================

    /**
     * Format a number for SVG output.
     * Rounds to 3 decimal places and strips trailing zeros so the output stays
     * compact (e.g. 12.5 instead of 12.500).
     * @param {number} val
     * @returns {string}
     */
    const F = (val) => Number(val.toFixed(3)).toString();

    /**
     * Build a paint attribute string (`fill="..."` or `stroke="..."`).
     *
     * SVG 1.1 does not support the CSS `rgba()` function in paint attributes,
     * so we emit a hex color plus a separate `*-opacity` attribute when alpha
     * is less than 1.
     *
     * @param {'fill'|'stroke'} attr
     * @param {string} hex   6-digit hex color (e.g. "#ff0000")
     * @param {number} alpha Normalized opacity in [0, 1]
     * @returns {string}
     */
    const paint = (attr, hex, alpha) =>
        `${attr}="${hex}"` + (alpha < 1 ? ` ${attr}-opacity="${F(alpha)}"` : '');

    /**
     * Convert an array of the site's curve objects into an SVG path `d` string.
     *
     * Curve classes are minified, so we identify the curve type by its
     * UNMINIFIED property fields. Property names survive minification because
     * they appear in the JSON/structured data produced by the backend.
     *
     * Supported curve types (in detection order):
     *   - Cubic bezier  : has `controlStartX`  -> "C"
     *   - Quadratic     : has `controlX`       -> "Q"
     *   - Elliptical arc: has `radiusX`        -> "A" (with rotation)
     *   - Circular arc  : has `radius`         -> "A" (rotation = 0)
     *   - Line          : fallback             -> "L"
     *
     * NOTE on full circles: a single 2π arc is degenerate in SVG (start == end
     * causes the renderer to skip it). The site pre-splits circles into halves
     * before emitting them, so we do not see 2π arcs in practice (0 observed
     * during testing). If one ever appears, add a two-half split here.
     *
     * @param {Array<object>} curves
     * @returns {string}
     */
    function curvesToD(curves) {
        // Every curve list is a connected polybezier; the first point starts
        // the path, and each subsequent curve ends where the next begins.
        const first = curves[0];
        const head = `M ${F(first.startX)} ${F(first.startY)} `;

        const segments = curves.map((c) => {
            const end = `${F(c.endX)} ${F(c.endY)}`;

            if ('controlStartX' in c) {
                return (
                    `C ${F(c.controlStartX)} ${F(c.controlStartY)} ` +
                    `${F(c.controlEndX)} ${F(c.controlEndY)} ${end}`
                );
            }
            if ('controlX' in c) {
                return `Q ${F(c.controlX)} ${F(c.controlY)} ${end}`;
            }
            if ('radiusX' in c) {
                // Elliptical arc: rotation is stored in radians, SVG expects degrees.
                const rotDeg = (c.rotationRad * 180) / Math.PI;
                return (
                    `A ${F(c.radiusX)} ${F(c.radiusY)} ${F(rotDeg)} ` +
                    `${c.largeArcFlag()} ${c.sweepFlag()} ${end}`
                );
            }
            if ('radius' in c) {
                // Circular arc: rotation is irrelevant (0 is fine).
                return (
                    `A ${F(c.radius)} ${F(c.radius)} 0 ` +
                    `${c.largeArcFlag()} ${c.sweepFlag()} ${end}`
                );
            }
            // Straight line.
            return `L ${end}`;
        });

        return head + segments.join(' ');
    }
})();