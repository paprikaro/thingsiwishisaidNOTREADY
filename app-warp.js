(() => {
  console.log('app-warp.js loaded');
  const STEP = 1;
  const CURR_KEY = `distortionStep${STEP}`;

  const DW = 1000, DH = 700; // display size
  const canvas = document.getElementById('mainCanvas');
  const ctx = canvas.getContext('2d');
  const nextLink = document.getElementById('next');
  const diagEl = document.getElementById('diag');

  let warpLevel = 0; // 0..100
  let lines = ['Ako'];

  const diag = (...msg) => { console.log('[Warp]', ...msg); if (diagEl) diagEl.textContent = msg.join(' '); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function loadLines() {
    try {
      const stored = JSON.parse(localStorage.getItem('inputLines') || '[]');
      if (Array.isArray(stored) && stored.some(s => (s || '').trim().length)) {
        lines = stored.map(s => (s || '').trim()).filter(Boolean);
      }
    } catch (_) {}
    if (!lines.length) lines = ['Ako'];
    lines = lines.slice(0, 3);
  }

  function computeFontSizeForLine(text, maxWidth, baseSize = 48) {
    let size = baseSize;
    ctx.font = `900 ${size}px "IBM Plex Mono", monospace`;
    while (ctx.measureText(text).width > maxWidth && size > 14) {
      size -= 2;
      ctx.font = `900 ${size}px "IBM Plex Mono", monospace`;
    }
    return size;
  }

  // 0 bars -> 50 rainbow arcs -> 100 concentric circles (centered)
  function drawWarp() {
    canvas.width = DW; canvas.height = DH;
    ctx.clearRect(0, 0, DW, DH);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, DW, DH);

    const t = warpLevel / 100;
    const cx = DW / 2;
    const cyCircle = DH / 2;
    const barYBase = DH * 0.35;
    const barSpacing = 110;
    const margin = 40;

    const radiusBase = Math.min(DW, DH) * 0.32;
    const arcCyBase = DH * 0.6;
    const arcSpanMax = Math.PI * 1.6;

    const bands = [
      { inset: 0 },
      { inset: 60 },
      { inset: 120 },
    ].slice(0, lines.length);

    bands.forEach((band, idx) => {
      const text = lines[idx] || '';
      if (!text) return;

      const maxTextW = DW * 0.8;
      const fontSize = computeFontSizeForLine(text, maxTextW, 48);
      ctx.font = `900 ${fontSize}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = '#000';

      const barY = barYBase + idx * barSpacing;
      const barW = DW * 0.8;
      const barX0 = cx - barW / 2;

      const inset = band.inset;
      const rOutBase = radiusBase - inset;
      const rOut = Math.max(rOutBase, fontSize * 2.2);

      const arcR = rOut;
      const arcSpan = lerp(Math.PI, arcSpanMax, clamp((t - 0.0) / 0.5, 0, 1));
      const arcStart = Math.PI;
      const arcCy = arcCyBase;

      const circleR = rOut;
      const circleStart = Math.PI;

      const totalW = ctx.measureText(text).width;
      let advance = 0;

      for (let ci = 0; ci < text.length; ci++) {
        const ch = text[ci];
        const cw = ctx.measureText(ch).width;
        const u = (advance + cw * 0.5) / totalW;

        const barX = barX0 + u * barW;
        const barYpos = barY;
        const barAngle = 0;

        const arcAngle = arcStart + arcSpan * u;
        const arcX = cx + arcR * Math.cos(arcAngle);
        const arcY = arcCy + arcR * Math.sin(arcAngle);
        const arcTangent = arcAngle + Math.PI / 2;

        const circAngle = circleStart + Math.PI * 2 * u;
        const circX = cx + circleR * Math.cos(circAngle);
        const circY = cyCircle + circleR * Math.sin(circAngle);
        const circTangent = circAngle + Math.PI / 2;

        let px, py, ang;
        if (t <= 0.5) {
          const k = t / 0.5;
          px = lerp(barX, arcX, k);
          py = lerp(barYpos, arcY, k);
          ang = lerp(barAngle, arcTangent, k);
        } else {
          const k = (t - 0.5) / 0.5;
          px = lerp(arcX, circX, k);
          py = lerp(arcY, circY, k);
          ang = lerp(arcTangent, circTangent, k);
        }

        px = clamp(px, margin, DW - margin);
        py = clamp(py, margin, DH - margin);

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.fillText(ch, -cw / 2, fontSize * 0.35);
        ctx.restore();

        advance += cw;
      }
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
    const delta = e.deltaY;
    warpLevel = clamp(warpLevel + delta * 0.05, 0, 100);
    drawWarp();
  }

  if (nextLink) {
    nextLink.addEventListener('click', (e) => {
      e.preventDefault();
      saveCurrent();
      window.location.href = nextLink.href;
    });
  }

  function init() {
    canvas.width = DW; canvas.height = DH;
    canvas.addEventListener('wheel', onWheelCanvas, { passive: false });
    loadLines();
    drawWarp();
    diag('Warp ready (1000x700). Scroll over canvas to warp.');
  }

  init();
})();