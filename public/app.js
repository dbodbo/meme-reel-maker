const CANVAS_W = 1080;
const CANVAS_H = 1920;

// Fontes de meme servidas localmente em /fonts (@fontsource)
const FONTS = {
  anton: { label: 'Anton (estilo Impact)', family: 'Anton', weight: 400 },
  bebas: { label: 'Bebas Neue', family: 'Bebas Neue', weight: 400 },
  montserrat: { label: 'Montserrat ExtraBold', family: 'Montserrat', weight: 800 },
  inter: { label: 'Inter Bold (igual ao template)', family: 'Inter', weight: 700 },
};

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const video = $('video');
const template = $('template');
const textCanvas = $('textLayer');
const barCanvas = $('barLayer');

// Posição do vídeo no canvas 1080x1920: centro (cx, cy) e zoom (largura = 1080 * zoom)
const state = {
  cx: CANVAS_W / 2,
  cy: CANVAS_H / 2,
  zoom: 1,
  bg: '#000000',
  ar: 9 / 16,
  file: null,
  framingKept: false, // true quando já existe um enquadramento (salvo ou do vídeo anterior) a reaproveitar
  texts: [],
  selected: null, // id da camada de texto selecionada
  bars: [],       // barras que tampam o vídeo (ficam entre o vídeo e o template/texto)
  selectedBar: null,
  active: 'text', // o que mostra a moldura de seleção no preview: 'text' | 'bar'
  dlBrowser: '', // navegador de onde o yt-dlp lê o login (cookies) para baixar do Instagram
};
let headerH = 0; // altura da parte opaca do template (detectada pelo alpha)
let k = 1;       // px de tela por px do canvas
let textBounds = []; // [{ id, x0, y0, x1, y1 }] em coords do canvas, atualizado a cada desenho

// ---------- persistência (data/settings.json via servidor) ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  $('saved').textContent = 'Salvando…';
  saveTimer = setTimeout(save, 400);
}

async function save() {
  const payload = { texts: state.texts, selected: state.selected, bars: state.bars, dlBrowser: state.dlBrowser };
  if (state.framingKept) {
    payload.framing = { cx: state.cx, cy: state.cy, zoom: state.zoom, bg: state.bg };
  }
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(res.statusText);
    $('saved').textContent = 'Alterações salvas';
  } catch (e) {
    $('saved').textContent = `Não foi possível salvar: ${e.message}`;
  }
}

async function loadSettings() {
  let s = {};
  try {
    s = await (await fetch('/api/settings')).json();
  } catch { /* sem configurações salvas */ }

  const f = s.framing;
  if (f && [f.cx, f.cy, f.zoom].every(Number.isFinite)) {
    Object.assign(state, { cx: f.cx, cy: f.cy, zoom: f.zoom, framingKept: true });
    if (/^#[0-9a-f]{6}$/i.test(f.bg)) state.bg = f.bg;
    $('zoom').max = Math.max(4, f.zoom * 2);
  }
  if (Array.isArray(s.texts)) {
    state.texts = s.texts.filter((t) => t && typeof t === 'object').map((t) => ({ ...defaultText(), ...t }));
    state.selected = state.texts.some((t) => t.id === s.selected) ? s.selected : state.texts[0]?.id ?? null;
  }
  if (Array.isArray(s.bars)) {
    state.bars = s.bars.filter((b) => b && typeof b === 'object').map((b) => ({ ...defaultBar(), ...b }));
    state.selectedBar = state.bars[0]?.id ?? null;
  }
  if (typeof s.dlBrowser === 'string') state.dlBrowser = s.dlBrowser;
  $('dlBrowser').value = state.dlBrowser;
  $('bg').value = state.bg;
  refreshTextUI();
  refreshBarUI();
  draw();
}

// ---------- template ----------
function detectHeader() {
  const c = document.createElement('canvas');
  c.width = template.naturalWidth;
  c.height = template.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(template, 0, 0);
  // O template é transparente fora do avatar/nome: acha a 1ª e a última linha com conteúdo
  // e considera o cabeçalho como o conteúdo + a mesma margem do topo embaixo.
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const rowHasInk = (y) => {
    for (let x = 0; x < c.width; x++) if (px[(y * c.width + x) * 4 + 3] > 10) return true;
    return false;
  };
  let first = 0;
  while (first < c.height && !rowHasInk(first)) first++;
  let last = c.height - 1;
  while (last > first && !rowHasInk(last)) last--;
  headerH = first < c.height ? last + 1 + first : 0;
  if (video.src && !state.framingKept) fit();
}
template.addEventListener('load', detectHeader); // também roda quando "Criar template" troca o PNG
if (template.complete && template.naturalWidth) detectHeader();

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- texto: layout e desenho (mesmo código no preview e no export) ----------
const fontSpec = (t) => {
  const f = FONTS[t.font] || FONTS.anton;
  return `${f.weight} ${t.size}px "${f.family}", sans-serif`;
};

function defaultText() {
  return {
    id: uid(),
    text: 'Seu texto aqui',
    font: 'anton',
    size: 90,
    fill: '#ffffff',
    stroke: '#000000',
    strokeW: 8,
    maxW: 960,
    upper: true,
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
  };
}

function layoutText(ctx, t) {
  const text = t.upper ? t.text.toUpperCase() : t.text;
  ctx.font = fontSpec(t);
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > t.maxW) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  const lh = t.size * 1.15;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  return { lines, lh, width, height: lines.length * lh };
}

// Desenha todas as camadas em coords do canvas 1080x1920 (ctx já escalado) e devolve as caixas
function drawTexts(ctx, texts) {
  const bounds = [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const t of texts) {
    const L = layoutText(ctx, t);
    const top = t.y - L.height / 2;
    L.lines.forEach((line, i) => {
      const y = top + L.lh * (i + 0.5);
      if (t.strokeW > 0) {
        ctx.lineWidth = t.strokeW * 2; // o traço é centrado; metade fica sob o preenchimento
        ctx.strokeStyle = t.stroke;
        ctx.strokeText(line, t.x, y);
      }
      ctx.fillStyle = t.fill;
      ctx.fillText(line, t.x, y);
    });
    const pad = t.strokeW + 6;
    bounds.push({
      id: t.id,
      x0: t.x - L.width / 2 - pad,
      y0: top - pad,
      x1: t.x + L.width / 2 + pad,
      y1: top + L.height + pad,
    });
  }
  return bounds;
}

const loadedFonts = new Set();
function ensureFonts(texts) {
  const pending = texts.map(fontSpec).filter((s) => !loadedFonts.has(s));
  if (!pending.length) return Promise.resolve(false);
  return Promise.all(pending.map((s) => document.fonts.load(s).then(() => loadedFonts.add(s)))).then(() => true);
}

// prepara um canvas do preview: resolução física da tela, mas desenhando em coords do canvas 1080x1920
function prepCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(stage.clientWidth * dpr);
  const h = Math.round(stage.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  return ctx;
}

// camada de cima: textos + moldura de seleção (do texto ou da barra ativa)
function drawTextPreview() {
  const ctx = prepCanvas(textCanvas);
  textBounds = drawTexts(ctx, state.texts);

  ctx.save();
  ctx.setLineDash([10 / k, 7 / k]);
  ctx.lineWidth = 2 / k;
  ctx.strokeStyle = '#4aa8ff';
  if (state.active === 'text') {
    const sel = textBounds.find((b) => b.id === state.selected);
    if (sel) ctx.strokeRect(sel.x0, sel.y0, sel.x1 - sel.x0, sel.y1 - sel.y0);
  } else {
    const bar = selectedBar();
    if (bar) {
      ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      const s = HANDLE_SIZE / k;
      for (const h of handlePoints(bar)) {
        ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
        ctx.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
      }
    }
  }
  ctx.restore();
  // fontes carregam de forma assíncrona: redesenha quando chegarem
  ensureFonts(state.texts).then((changed) => changed && drawTextPreview());
}

// camada do meio: barras (acima do vídeo, abaixo do template e do texto)
function drawBars(ctx, bars) {
  for (const b of bars) {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
}

function drawBarsPreview() {
  drawBars(prepCanvas(barCanvas), state.bars);
}

function canvasBlob(draw) {
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  draw(c.getContext('2d'));
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

async function renderOverlayBlob() {
  if (!state.texts.length) return null;
  await ensureFonts(state.texts);
  return canvasBlob((ctx) => drawTexts(ctx, state.texts));
}

const renderBarsBlob = () => (state.bars.length ? canvasBlob((ctx) => drawBars(ctx, state.bars)) : null);

// ---------- render do preview ----------
function draw() {
  k = stage.clientWidth / CANVAS_W;
  const w = CANVAS_W * state.zoom;
  const h = w * state.ar;
  Object.assign(video.style, {
    width: `${w * k}px`,
    height: `${h * k}px`,
    left: `${(state.cx - w / 2) * k}px`,
    top: `${(state.cy - h / 2) * k}px`,
  });
  $('zoom').value = state.zoom;
  $('zoomOut').textContent = `${Math.round(state.zoom * 100)}%`;
  drawBarsPreview();
  drawTextPreview();
}
new ResizeObserver(draw).observe(stage);

// altera o estado a partir de uma ação do usuário: redesenha e salva
function commit() {
  draw();
  scheduleSave();
}

const areaCenterY = () => headerH + (CANVAS_H - headerH) / 2;

function fit() {
  state.zoom = 1;
  state.cx = CANVAS_W / 2;
  state.cy = areaCenterY();
  state.framingKept = true;
  commit();
}

function cover() {
  state.zoom = Math.max(1, (CANVAS_H - headerH) / (CANVAS_W * state.ar));
  state.cx = CANVAS_W / 2;
  state.cy = areaCenterY();
  $('zoom').max = Math.max(4, state.zoom * 2);
  state.framingKept = true;
  commit();
}

function setZoom(z) {
  state.zoom = Math.min(Number($('zoom').max), Math.max(0.2, z));
  state.framingKept = true;
  commit();
}

// ---------- carregar vídeo ----------
function loadFile(file) {
  if (!file || !file.type.startsWith('video/')) return;
  state.file = file;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  $('filename').textContent = file.name;
  $('status').textContent = '';
}

video.addEventListener('loadedmetadata', () => {
  state.ar = video.videoHeight / video.videoWidth;
  $('start').value = 0;
  $('end').value = video.duration.toFixed(1);
  $('start').max = $('end').max = video.duration;
  $('empty').classList.add('hidden');
  $('controls').disabled = false;
  $('export').disabled = false;
  // mantém o enquadramento salvo (padrão); sem ele, ajusta à largura
  if (state.framingKept) draw();
  else fit();
  video.play().catch(() => {});
});

// mantém o preview em loop dentro do trecho escolhido
video.addEventListener('timeupdate', () => {
  const s = Number($('start').value);
  const e = Number($('end').value);
  if (video.currentTime >= e || video.currentTime < s - 0.3) video.currentTime = s;
});

$('file').addEventListener('change', (ev) => loadFile(ev.target.files[0]));

// ---------- downloader (link -> servidor baixa -> abre no editor) ----------
$('dlBrowser').addEventListener('change', (ev) => {
  state.dlBrowser = ev.target.value;
  scheduleSave();
});

$('dlForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('dlBtn');
  btn.disabled = true;
  $('status').textContent = 'Baixando vídeo…';
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('dlUrl').value, browser: state.dlBrowser }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    const blob = await (await fetch(data.url)).blob();
    loadFile(new File([blob], data.file, { type: blob.type || 'video/mp4' }));
    $('dlUrl').value = '';
    $('status').textContent = `Baixado: ${data.file}`;
  } catch (e) {
    $('status').textContent = `Erro: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

stage.addEventListener('dragover', (ev) => { ev.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', (ev) => {
  ev.preventDefault();
  stage.classList.remove('drop');
  loadFile(ev.dataTransfer.files[0]);
});

// ---------- mover (texto, barra ou vídeo) / zoom ----------
const selectedText = () => state.texts.find((t) => t.id === state.selected);
const selectedBar = () => state.bars.find((b) => b.id === state.selectedBar);

function toCanvas(ev) {
  const r = stage.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / k, y: (ev.clientY - r.top) / k };
}

// alças de redimensionar da barra: cantos e meios das bordas
const HANDLE_SIZE = 14; // px de tela
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
function handlePoints(b) {
  const xs = { w: b.x, '': b.x + b.w / 2, e: b.x + b.w };
  const ys = { n: b.y, '': b.y + b.h / 2, s: b.y + b.h };
  return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => ({
    h,
    x: xs[h.replace(/[ns]/, '')],
    y: ys[h.replace(/[we]/, '')],
  }));
}
function hitHandle(b, p) {
  const r = HANDLE_SIZE / k;
  return handlePoints(b).find((h) => Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r)?.h ?? null;
}

const inRect = (p, x0, y0, x1, y1) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;

let drag = null;
stage.addEventListener('pointerdown', (ev) => {
  const p = toCanvas(ev);
  const bar = selectedBar();
  const handle = state.active === 'bar' && bar ? hitHandle(bar, p) : null;
  // ordem de cima pra baixo: alça da barra > texto > barra > vídeo (última camada fica no topo)
  const textHit = [...textBounds].reverse().find((b) => inRect(p, b.x0, b.y0, b.x1, b.y1));
  const barHit = [...state.bars].reverse().find((b) => inRect(p, b.x, b.y, b.x + b.w, b.y + b.h));

  if (handle) {
    drag = { kind: 'bar-resize', handle, px: p.x, py: p.y, o: { x: bar.x, y: bar.y, w: bar.w, h: bar.h } };
  } else if (textHit) {
    selectText(textHit.id);
    const t = selectedText();
    drag = { kind: 'text', px: p.x, py: p.y, ox: t.x, oy: t.y };
  } else if (barHit) {
    selectBar(barHit.id);
    drag = { kind: 'bar-move', px: p.x, py: p.y, ox: barHit.x, oy: barHit.y };
  } else if (state.file) {
    drag = { kind: 'video', px: p.x, py: p.y, ox: state.cx, oy: state.cy };
  } else {
    return;
  }
  stage.setPointerCapture(ev.pointerId);
  stage.classList.add('dragging');
});

const MIN_BAR = 10;
stage.addEventListener('pointermove', (ev) => {
  const p = toCanvas(ev);
  if (!drag) {
    const bar = selectedBar();
    const h = state.active === 'bar' && bar ? hitHandle(bar, p) : null;
    stage.style.cursor = h ? HANDLE_CURSORS[h] : '';
    return;
  }
  const dx = p.x - drag.px;
  const dy = p.y - drag.py;
  if (drag.kind === 'text') {
    const t = selectedText();
    if (t) {
      t.x = drag.ox + dx;
      t.y = drag.oy + dy;
    }
  } else if (drag.kind === 'bar-move') {
    const b = selectedBar();
    if (b) {
      b.x = Math.round(drag.ox + dx);
      b.y = Math.round(drag.oy + dy);
      refreshBarFields();
    }
  } else if (drag.kind === 'bar-resize') {
    const b = selectedBar();
    if (b) {
      const { x, y, w, h } = drag.o;
      let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
      if (drag.handle.includes('w')) x0 += dx;
      if (drag.handle.includes('e')) x1 += dx;
      if (drag.handle.includes('n')) y0 += dy;
      if (drag.handle.includes('s')) y1 += dy;
      if (x1 - x0 < MIN_BAR) { if (drag.handle.includes('w')) x0 = x1 - MIN_BAR; else x1 = x0 + MIN_BAR; }
      if (y1 - y0 < MIN_BAR) { if (drag.handle.includes('n')) y0 = y1 - MIN_BAR; else y1 = y0 + MIN_BAR; }
      Object.assign(b, { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
      refreshBarFields();
      refreshBarLabel();
    }
  } else if (drag.kind === 'video') {
    state.cx = drag.ox + dx;
    state.cy = drag.oy + dy;
    state.framingKept = true;
  }
  commit();
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('wheel', (ev) => {
  if (!state.file) return;
  ev.preventDefault();
  setZoom(state.zoom * Math.exp(-ev.deltaY * 0.001));
}, { passive: false });

$('zoom').addEventListener('input', (ev) => setZoom(Number(ev.target.value)));
$('fit').addEventListener('click', fit);
$('cover').addEventListener('click', cover);
$('center').addEventListener('click', () => {
  state.cx = CANVAS_W / 2;
  state.cy = areaCenterY();
  state.framingKept = true;
  commit();
});
$('bg').addEventListener('input', (ev) => {
  state.bg = ev.target.value;
  state.framingKept = true;
  scheduleSave();
});

// ---------- tempo ----------
$('markStart').addEventListener('click', () => { $('start').value = video.currentTime.toFixed(1); });
$('markEnd').addEventListener('click', () => { $('end').value = video.currentTime.toFixed(1); });
$('play').addEventListener('click', () => (video.paused ? video.play() : video.pause()));

// ---------- UI de texto ----------
for (const [id, f] of Object.entries(FONTS)) {
  const o = new Option(f.label, id);
  o.style.fontFamily = `"${f.family}"`;
  $('tFont').append(o);
}

function selectText(id) {
  state.selected = id;
  state.active = 'text';
  refreshTextUI();
  commit();
}

// recria a lista e preenche o editor com a camada selecionada
function refreshTextUI() {
  const list = $('textList');
  list.replaceChildren(...state.texts.map((t, i) => new Option(`${i + 1}. ${t.text.replace(/\s+/g, ' ').slice(0, 22) || '(vazio)'}`, t.id)));
  const t = selectedText();
  $('textEditor').hidden = !t;
  if (!t) return;
  list.value = t.id;
  $('tText').value = t.text;
  $('tFont').value = t.font;
  $('tSize').value = t.size;
  $('tSizeOut').textContent = `${t.size}px`;
  $('tMaxW').value = t.maxW;
  $('tMaxWOut').textContent = `${t.maxW}px`;
  $('tFill').value = t.fill;
  $('tStroke').value = t.stroke;
  $('tStrokeW').value = t.strokeW;
  $('tUpper').checked = t.upper;
}

// edita a camada selecionada; a lista só é recriada quando o texto muda (rótulo)
function editText(patch, relist = false) {
  const t = selectedText();
  if (!t) return;
  Object.assign(t, patch);
  if (relist) {
    refreshTextUI();
  } else {
    $('tSizeOut').textContent = `${t.size}px`;
    $('tMaxWOut').textContent = `${t.maxW}px`;
  }
  commit();
}

$('addText').addEventListener('click', () => {
  // novo texto herda o estilo da camada atual (mantém o padrão) e entra um pouco abaixo dela
  const prev = selectedText() ?? state.texts.at(-1);
  const t = { ...defaultText(), y: (headerH || 300) + 160 };
  if (prev) {
    Object.assign(t, {
      font: prev.font, size: prev.size, fill: prev.fill, stroke: prev.stroke,
      strokeW: prev.strokeW, maxW: prev.maxW, upper: prev.upper,
      x: prev.x, y: Math.min(prev.y + prev.size * 1.6, CANVAS_H - 100),
    });
  }
  state.texts.push(t);
  state.selected = t.id;
  state.active = 'text';
  refreshTextUI();
  commit();
  $('tText').focus();
  $('tText').select();
});

$('delText').addEventListener('click', () => {
  const i = state.texts.findIndex((t) => t.id === state.selected);
  if (i < 0) return;
  state.texts.splice(i, 1);
  state.selected = state.texts[Math.min(i, state.texts.length - 1)]?.id ?? null;
  refreshTextUI();
  commit();
});

$('centerText').addEventListener('click', () => editText({ x: CANVAS_W / 2 }));
$('textList').addEventListener('change', (ev) => selectText(ev.target.value));
$('tText').addEventListener('input', (ev) => editText({ text: ev.target.value }, true));
$('tFont').addEventListener('change', (ev) => editText({ font: ev.target.value }));
$('tSize').addEventListener('input', (ev) => editText({ size: Number(ev.target.value) }));
$('tMaxW').addEventListener('input', (ev) => editText({ maxW: Number(ev.target.value) }));
$('tFill').addEventListener('input', (ev) => editText({ fill: ev.target.value }));
$('tStroke').addEventListener('input', (ev) => editText({ stroke: ev.target.value }));
$('tStrokeW').addEventListener('input', (ev) => editText({ strokeW: Math.max(0, Number(ev.target.value) || 0) }));
$('tUpper').addEventListener('change', (ev) => editText({ upper: ev.target.checked }));

// ---------- UI de barra ----------
function defaultBar() {
  return { id: uid(), x: 0, y: Math.round(state.cy - 70), w: CANVAS_W, h: 140, color: '#000000' };
}

const barLabel = (b, i) => `${i + 1}. barra ${b.w}×${b.h}`;

function refreshBarFields() {
  const b = selectedBar();
  if (!b) return;
  $('bX').value = b.x;
  $('bY').value = b.y;
  $('bW').value = b.w;
  $('bH').value = b.h;
}

// só atualiza o rótulo da barra selecionada (evita recriar a lista enquanto se digita)
function refreshBarLabel() {
  const i = state.bars.findIndex((b) => b.id === state.selectedBar);
  if (i >= 0 && $('barList').options[i]) $('barList').options[i].text = barLabel(state.bars[i], i);
}

function refreshBarUI() {
  const list = $('barList');
  list.replaceChildren(...state.bars.map((b, i) => new Option(barLabel(b, i), b.id)));
  const b = selectedBar();
  $('barEditor').hidden = !b;
  if (!b) return;
  list.value = b.id;
  refreshBarFields();
  $('bColor').value = b.color;
}

function selectBar(id) {
  state.selectedBar = id;
  state.active = 'bar';
  refreshBarUI();
  commit();
}

function editBar(patch) {
  const b = selectedBar();
  if (!b) return;
  Object.assign(b, patch);
  state.active = 'bar';
  refreshBarLabel();
  commit();
}

$('addBar').addEventListener('click', () => {
  // nova barra herda tamanho/cor da atual (mantém o padrão) e entra logo abaixo dela
  const prev = selectedBar() ?? state.bars.at(-1);
  const b = defaultBar();
  if (prev) {
    Object.assign(b, { x: prev.x, w: prev.w, h: prev.h, color: prev.color, y: Math.min(prev.y + prev.h + 20, CANVAS_H - prev.h) });
  }
  state.bars.push(b);
  selectBar(b.id);
});

$('delBar').addEventListener('click', () => {
  const i = state.bars.findIndex((b) => b.id === state.selectedBar);
  if (i < 0) return;
  state.bars.splice(i, 1);
  state.selectedBar = state.bars[Math.min(i, state.bars.length - 1)]?.id ?? null;
  refreshBarUI();
  commit();
});

$('barFull').addEventListener('click', () => {
  editBar({ x: 0, w: CANVAS_W });
  refreshBarFields();
  refreshBarLabel();
});
$('barList').addEventListener('change', (ev) => selectBar(ev.target.value));
const num = (v, min = -Infinity) => Math.max(min, Math.round(Number(v) || 0));
$('bX').addEventListener('input', (ev) => editBar({ x: num(ev.target.value) }));
$('bY').addEventListener('input', (ev) => editBar({ y: num(ev.target.value) }));
$('bW').addEventListener('input', (ev) => editBar({ w: num(ev.target.value, MIN_BAR) }));
$('bH').addEventListener('input', (ev) => editBar({ h: num(ev.target.value, MIN_BAR) }));
$('bColor').addEventListener('input', (ev) => editBar({ color: ev.target.value }));

// ---------- exportar ----------
$('export').addEventListener('click', async () => {
  const w = CANVAS_W * state.zoom;
  const h = w * state.ar;
  const params = {
    x: state.cx - w / 2,
    y: state.cy - h / 2,
    w,
    h,
    start: Number($('start').value),
    end: Number($('end').value),
    bg: state.bg,
  };
  const body = new FormData();
  body.append('params', JSON.stringify(params));
  body.append('video', state.file);

  const btn = $('export');
  btn.disabled = true;
  $('status').textContent = 'Enviando e renderizando… (pode levar um tempo)';
  try {
    const [bars, overlay] = await Promise.all([renderBarsBlob(), renderOverlayBlob()]);
    if (bars) body.append('bars', bars, 'bars.png');
    if (overlay) body.append('overlay', overlay, 'overlay.png');
    const res = await fetch('/render', { method: 'POST', body });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `reel_${state.file.name.replace(/\.[^.]+$/, '')}.mp4`;
    a.click();
    URL.revokeObjectURL(a.href);
    $('status').textContent = 'Pronto! Também salvo na pasta output/.';
  } catch (e) {
    $('status').textContent = `Erro: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

loadSettings();
