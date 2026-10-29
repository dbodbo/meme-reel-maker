// Aba "Criar template": redesenha o Template_Reel.psd (foto, nome, @usuário, selo) num canvas 1080x1920
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('tplCanvas');
  const ctx = canvas.getContext('2d');
  const stage = $('tplStage');
  const status = $('tplStatus');

  const MAX_PHOTO = 1024; // a foto é reduzida antes de ir para o servidor
  const state = { name: '', user: '', verified: true, color: '#ffffff', zoom: 1, dx: 0, dy: 0 };
  let psd = null; // { avatar, name, user, badge, gap, defaults }
  let photo = null; // imagem da foto de perfil
  let badge = null; // selo extraído do PSD

  const say = (msg) => (status.textContent = msg || '');

  // ---------- persistência (data/template.json) ----------
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/template/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => say('Não foi possível salvar as alterações.'));
    }, 400);
  };

  // ---------- desenho ----------
  const textFont = (l, size = l.size) => `400 ${size}px Inter`;
  const RIGHT = 1080 - 126; // limite à direita: mesma margem que a foto tem à esquerda

  // reduz o tamanho do texto só se ele passar do limite
  function fitSize(l, text, avail) {
    ctx.font = textFont(l);
    const w = ctx.measureText(text).width;
    return w > avail ? (l.size * avail) / w : l.size;
  }

  function photoScale() {
    return Math.max(psd.avatar.w / photo.width, psd.avatar.h / photo.height) * state.zoom;
  }

  // mantém a foto cobrindo o círculo todo
  function clampPhoto() {
    if (!photo) return;
    const s = photoScale();
    const mx = Math.max(0, (photo.width * s - psd.avatar.w) / 2);
    const my = Math.max(0, (photo.height * s - psd.avatar.h) / 2);
    state.dx = Math.min(mx, Math.max(-mx, state.dx));
    state.dy = Math.min(my, Math.max(-my, state.dy));
  }

  function render(c = ctx) {
    c.clearRect(0, 0, 1080, 1920);
    if (!psd) return;
    const a = psd.avatar;
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;

    c.save();
    c.beginPath();
    c.ellipse(cx, cy, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
    c.clip();
    if (photo) {
      const s = photoScale();
      c.imageSmoothingQuality = 'high';
      c.drawImage(photo, cx + state.dx - (photo.width * s) / 2, cy + state.dy - (photo.height * s) / 2, photo.width * s, photo.height * s);
    } else {
      c.fillStyle = a.color;
      c.fillRect(a.x, a.y, a.w, a.h);
    }
    c.restore();

    c.fillStyle = state.color;
    c.textBaseline = 'alphabetic';
    const showBadge = state.verified && badge;
    const nameSize = fitSize(psd.name, state.name, RIGHT - psd.name.ox - (showBadge ? psd.gap + psd.badge.w : 0));
    c.font = textFont(psd.name, nameSize);
    c.fillText(state.name, psd.name.ox, psd.name.oy);
    c.font = textFont(psd.user, fitSize(psd.user, state.user, RIGHT - psd.user.ox));
    c.fillText(state.user, psd.user.ox, psd.user.oy);

    if (showBadge) {
      c.font = textFont(psd.name, nameSize);
      const bx = psd.name.ox + c.measureText(state.name).width + psd.gap;
      c.drawImage(badge, Math.round(bx), psd.badge.y, psd.badge.w, psd.badge.h);
    }
  }

  const redraw = () => render();

  // ---------- campos ----------
  function syncFields() {
    $('tplName').value = state.name;
    $('tplUser').value = state.user;
    $('tplVerified').checked = state.verified;
    $('tplColor').value = state.color;
    $('tplZoom').value = state.zoom;
    $('tplZoomOut').textContent = `${state.zoom.toFixed(2)}×`;
    $('tplZoom').disabled = !photo;
    $('tplPhotoReset').disabled = !photo;
    $('tplPhotoClear').disabled = !photo;
  }

  const change = () => {
    clampPhoto();
    syncFields();
    redraw();
    scheduleSave();
  };

  $('tplName').addEventListener('input', (e) => { state.name = e.target.value; change(); });
  $('tplUser').addEventListener('input', (e) => { state.user = e.target.value; change(); });
  $('tplVerified').addEventListener('change', (e) => { state.verified = e.target.checked; change(); });
  $('tplColor').addEventListener('input', (e) => { state.color = e.target.value; change(); });
  $('tplZoom').addEventListener('input', (e) => { state.zoom = Number(e.target.value); change(); });
  $('tplPhotoReset').addEventListener('click', () => { state.zoom = 1; state.dx = 0; state.dy = 0; change(); });

  $('tplReset').addEventListener('click', () => {
    Object.assign(state, psd.defaults);
    change();
    say('Valores do PSD restaurados (a foto continua a mesma).');
  });

  // ---------- foto ----------
  async function uploadPhoto(img) {
    // reduz e converte para PNG antes de guardar no servidor
    const k = Math.min(1, MAX_PHOTO / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch('/api/template/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falha ao salvar a foto');
    return c;
  }

  $('tplPhoto').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      say('Carregando foto…');
      const src = await createImageBitmap(file);
      photo = await uploadPhoto(src);
      state.zoom = 1;
      state.dx = 0;
      state.dy = 0;
      say('');
      change();
    } catch (err) {
      say(`Não foi possível usar essa imagem: ${err.message}`);
    }
  });

  $('tplPhotoClear').addEventListener('click', () => {
    photo = null;
    state.zoom = 1;
    state.dx = 0;
    state.dy = 0;
    change();
    say('Foto removida (volta ao círculo do PSD).');
  });

  // arrastar / zoom da foto dentro do círculo
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 1080, y: ((e.clientY - r.top) / r.height) * 1920 };
  };
  const inCircle = (p) => {
    const a = psd.avatar;
    const nx = (p.x - (a.x + a.w / 2)) / (a.w / 2);
    const ny = (p.y - (a.y + a.h / 2)) / (a.h / 2);
    return nx * nx + ny * ny <= 1;
  };
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (!psd || !photo || !inCircle(toCanvas(e))) return;
    const p = toCanvas(e);
    drag = { px: p.x, py: p.y, dx: state.dx, dy: state.dy };
    try { stage.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!psd) return;
    const p = toCanvas(e);
    if (drag) {
      state.dx = drag.dx + (p.x - drag.px);
      state.dy = drag.dy + (p.y - drag.py);
      change();
    } else {
      stage.classList.toggle('photo-hover', !!photo && inCircle(p));
    }
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!psd || !photo || !inCircle(toCanvas(e))) return;
    e.preventDefault();
    state.zoom = Math.min(4, Math.max(1, state.zoom * (e.deltaY < 0 ? 1.05 : 1 / 1.05)));
    change();
  }, { passive: false });

  // ---------- salvar ----------
  // Renderiza em canvas próprio para não depender do tamanho do preview
  const exportBlob = () => {
    const c = document.createElement('canvas');
    c.width = 1080;
    c.height = 1920;
    render(c.getContext('2d'));
    return new Promise((r) => c.toBlob(r, 'image/png'));
  };

  $('tplDownload').addEventListener('click', async () => {
    const url = URL.createObjectURL(await exportBlob());
    const a = Object.assign(document.createElement('a'), { href: url, download: 'template_reel.png' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say('PNG gerado: template_reel.png');
  });

  $('tplUse').addEventListener('click', async () => {
    const btn = $('tplUse');
    btn.disabled = true;
    try {
      const res = await fetch('/api/template/use', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await exportBlob() });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      $('template').src = `/template.png?v=${Date.now()}`; // o Editor passa a usar o novo
      say(out.backup ? `Template atualizado no editor. O anterior foi guardado em ${out.backup}.` : 'Template atualizado no editor.');
    } catch (err) {
      say(`Não foi possível trocar o template: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- inicialização ----------
  async function init() {
    const res = await fetch('/api/template/psd');
    const info = await res.json().catch(() => null);
    // 404 em HTML = servidor antigo, iniciado antes desta aba existir
    if (!info) throw new Error('o programa precisa ser reiniciado: no terminal, pare o "npm start" com Ctrl+C e rode "npm start" de novo, depois recarregue esta página');
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    const layer = (n) => info.layers.find((l) => l.name.toLowerCase() === n);
    const [name, user, avatar, badgeL] = ['name', 'user', 'profile', 'verificado'].map(layer);
    if (!name || !user || !avatar || !badgeL) throw new Error('O PSD precisa ter as camadas: name, user, Verificado e Profile');

    await Promise.all([document.fonts.load(textFont(name)), document.fonts.load(textFont(user))]);
    badge = await new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => fail(new Error('Selo "Verificado" não pôde ser lido do PSD'));
      img.src = `/api/template/layer/${encodeURIComponent(badgeL.name)}.png`;
    });

    // distância entre o fim do nome e o selo (fixa no layout padrão; no PSD, a que está nele)
    ctx.font = textFont(name);
    const gap = info.badgeGap ?? badgeL.x - (name.ox + ctx.measureText(name.content).width);
    psd = { avatar, name, user, badge: badgeL, gap, defaults: { name: name.content, user: user.content, verified: true, color: name.color, zoom: 1, dx: 0, dy: 0 } };

    Object.assign(state, psd.defaults, await fetch('/api/template/state').then((r) => r.json()).catch(() => ({})));
    const av = await fetch('/api/template/avatar');
    if (av.ok) photo = await createImageBitmap(await av.blob());

    $('tplBox').disabled = false;
    $('tplPsd').textContent = info.source === 'psd' ? 'Template_Reel.psd carregado.' : 'Usando o layout padrão (nenhum Template_Reel.psd na pasta).';
    change();
  }

  init().catch((e) => { $('tplPsd').textContent = `Não foi possível ler o PSD: ${e.message}`; });
})();
