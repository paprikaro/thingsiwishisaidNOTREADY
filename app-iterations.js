(() => {
  console.log('app-iterations.js (dual-pass + blur + center-fit + scroll-to-show) loaded');

  const STEP = 3;
  const PREV_KEY = `distortionStep${STEP - 1}`; // distortionStep2
  const CURR_KEY = `distortionStep${STEP}`;

  const DW = 1400, DH = 980;   // display size (10:7)
  const PW_FAST = 450, PH_FAST = 315; // fast pass
  const PW_HQ   = 900, PH_HQ   = 630; // HQ pass

  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  const nextLink = document.getElementById('next');
  const diagEl = document.getElementById('diag');

  let outlineLevel = 50;
  let idleTimer = null;
  let rafPending = false;
  let hasRenderedOnce = false; // prevent initial rings until scroll

  let lastMaskFast = null;
  let lastMaskHQ = null;

  const diag = (...msg) => { console.log('[Iterations]', ...msg); if (diagEl) diagEl.textContent = msg.join(' '); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function blurAndThreshold(mask, w, h, passes = 1, thresh = 0.5) {
    let cur = mask;
    for (let p = 0; p < passes; p++) {
      const nxt = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const yOff = y * w;
        const yPrev = y > 0 ? (y - 1) * w : yOff;
        const yNext = y + 1 < h ? (y + 1) * w : yOff;
        for (let x = 0; x < w; x++) {
          const xl = x > 0 ? x - 1 : x;
          const xr = x + 1 < w ? x + 1 : x;
          const sum =
            cur[yPrev + xl] + cur[yPrev + x] + cur[yPrev + xr] +
            cur[yOff  + xl] + cur[yOff  + x] + cur[yOff  + xr] +
            cur[yNext + xl] + cur[yNext + x] + cur[yNext + xr];
          nxt[yOff + x] = sum >= thresh * 9 ? 1 : 0;
        }
      }
      cur = nxt;
    }
    return cur;
  }

  function makeProc(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { c, g: c.getContext('2d'), w, h };
  }
  const procFast = makeProc(PW_FAST, PH_FAST);
  const procHQ   = makeProc(PW_HQ,   PH_HQ);

  function loadPrevImage() {
    return new Promise((resolve) => {
      const url = localStorage.getItem(PREV_KEY);
      if (!url) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function maskFromImage(img, target) {
    const { c, g, w, h } = target;
    g.clearRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const m = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      m[j] = lum < 128 ? 1 : 0;
    }
    return m;
  }

  function dilate(src, w, h, r) {
    if (r <= 0) return src;
    const dst = new Uint8Array(w * h);
    const r2 = r * r;
    for (let y = 0; y < h; y++) {
      const yOff = y * w;
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          const dy2 = dy * dy;
          const yyOff = yy * w;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            if (dx * dx + dy2 <= r2 && src[yyOff + xx]) { hit = 1; break; }
          }
        }
        dst[yOff + x] = hit;
      }
    }
    return dst;
  }

  function paintMaskToRGBA(mask, w, h, rgba, color) {
    const [r, g, b] = color;
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      if (mask[i]) {
        rgba[j] = r; rgba[j + 1] = g; rgba[j + 2] = b; rgba[j + 3] = 255;
      }
    }
  }

  function quantizeBinary(out) {
    for (let k = 0; k < out.length; k += 4) {
      const a = out[k + 3];
      if (a > 127) {
        const black = (out[k] + out[k + 1] + out[k + 2]) < 384;
        out[k] = out[k + 1] = out[k + 2] = black ? 0 : 255;
        out[k + 3] = 255;
      } else {
        out[k + 3] = 0;
      }
    }
  }

  function bbox(mask, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const yOff = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[yOff + x]) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function renderBands(mask, w, h, level, targetCtx, targetCanvas) {
    // Blur mask to soften pixelation
    const baseMask = blurAndThreshold(mask, w, h, 1, 0.5);

    const out = new Uint8ClampedArray(w * h * 4);
    paintMaskToRGBA(baseMask, w, h, out, [0, 0, 0]);

    const t = level / 100;
    const rings = Math.max(6, Math.round(lerp(8, 14, t)));
    const maxR = Math.round(lerp(5, Math.max(12, Math.floor(w * 0.025)), t));

    let inner = baseMask;
    for (let i = 1; i <= rings; i++) {
      const rInner = Math.round(((i - 1) / rings) * maxR);
      const rOuter = Math.round((i / rings) * maxR);
      const outer = rOuter === rInner ? inner : dilate(baseMask, w, h, rOuter);

      const band = new Uint8Array(w * h);
      for (let p = 0; p < band.length; p++) band[p] = outer[p] && !inner[p] ? 1 : 0;

      const colorBlack = i % 2 === 1;
      paintMaskToRGBA(band, w, h, out, colorBlack ? [0, 0, 0] : [255, 255, 255]);

      inner = outer;
    }

    quantizeBinary(out);

    const imgData = new ImageData(out, w, h);
    targetCtx.putImageData(imgData, 0, 0);

    const b = bbox(baseMask, w, h);
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0, 0, DW, DH);
    ctx.imageSmoothingEnabled = false;
    if (b) {
      const pad = 24;
      const scale = Math.min((DW - 2*pad) / b.w, (DH - 2*pad) / b.h);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const offsetX = DW / 2 - cx * scale;
      const offsetY = DH / 2 - cy * scale;
      ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    }
    ctx.drawImage(targetCanvas, 0, 0);
    ctx.restore();
  }

  function process(maskFast, maskHQ) {
    if (!maskFast) return;
    renderBands(maskFast, PW_FAST, PH_FAST, outlineLevel, procFast.g, procFast.c);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (maskHQ) renderBands(maskHQ, PW_HQ, PH_HQ, outlineLevel, procHQ.g, procHQ.c);
    }, 140);
  }

  function scheduleFastRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      process(lastMaskFast, lastMaskHQ);
    });
  }

  function saveCurrent() {
    try {
      const url = canvas.toDataURL('image/png');
      localStorage.setItem(CURR_KEY, url);
      diag(`Saved ${CURR_KEY}`);
    } catch (err) {
      console.error(err); diag('Save failed: ' + err.message);
    }
  }

  function onWheelCanvas(e) {
    e.preventDefault();
    // First scroll: trigger initial render
    if (!hasRenderedOnce) {
      hasRenderedOnce = true;
      scheduleFastRender();
      return;
    }
    const delta = e.deltaY;
    outlineLevel = clamp(outlineLevel + delta * 0.05, 0, 100);
    scheduleFastRender();
  }

  function buildTextMask(lines, target) {
    const { c, g, w, h } = target;
    const clean = (lines || []).map(s => (s || '').trim()).filter(Boolean);
    const textLines = clean.length ? clean : ['Fallback'];
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    const margin = Math.floor(w * 0.08);
    let fontSize = Math.floor(h * 0.62);
    const lineHeightFactor = 1.18;
    let fits = false;
    while (!fits && fontSize > 10) {
      g.font = `900 ${fontSize}px "IBM Plex Mono", monospace`;
      const widths = textLines.map(t => g.measureText(t).width);
      const maxW = Math.max(...widths);
      const totalH = textLines.length * fontSize * lineHeightFactor;
      if (maxW <= w - margin * 2 && totalH <= h - margin * 2) fits = true; else fontSize -= 3;
    }
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillStyle = '#000';
    const lh = fontSize * lineHeightFactor;
    const blockH = (textLines.length - 1) * lh;
    let y = h / 2 - blockH / 2;
    for (const line of textLines) { g.fillText(line, w / 2, y); y += lh; }
    const data = g.getImageData(0, 0, w, h).data;
    const m = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      m[j] = lum < 128 ? 1 : 0;
    }
    return m;
  }

  function init() {
    canvas.width = DW; canvas.height = DH;
    canvas.addEventListener('wheel', onWheelCanvas, { passive: false });

    loadPrevImage().then(img => {
      if (img) {
        lastMaskFast = maskFromImage(img, procFast);
        lastMaskHQ  = maskFromImage(img, procHQ);
        lastMaskFast = blurAndThreshold(lastMaskFast, procFast.w, procFast.h, 1, 0.5);
        lastMaskHQ   = blurAndThreshold(lastMaskHQ,   procHQ.w,   procHQ.h,   1, 0.5);
        diag('Using mask from distortionStep2');
      } else {
        let lines = ['Fallback'];
        try {
          const stored = JSON.parse(localStorage.getItem('inputLines') || '[]');
          if (Array.isArray(stored) && stored.some(s => (s || '').trim().length)) lines = stored;
        } catch (_) {}
        lastMaskFast = buildTextMask(lines, procFast);
        lastMaskHQ  = buildTextMask(lines, procHQ);
        lastMaskFast = blurAndThreshold(lastMaskFast, procFast.w, procFast.h, 1, 0.5);
        lastMaskHQ   = blurAndThreshold(lastMaskHQ,   procHQ.w,   procHQ.h,   1, 0.5);
        diag('Fallback mask from inputLines');
      }
      // Do NOT render yet; wait for first scroll
      ctx.clearRect(0, 0, DW, DH);
      diag(`Iterations ready (center-fit, dual-pass: fast ${PW_FAST}x${PH_FAST}, HQ ${PW_HQ}x${PH_HQ}). Scroll to show.`);
    });

    if (nextLink) {
      nextLink.addEventListener('click', (e) => {
        e.preventDefault();
        saveCurrent();
        window.location.href = nextLink.href;
      });
    }
  }

  init();
})();