import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayout } from './psd.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(ROOT, 'Template_Reel.png');
const PSD = path.join(ROOT, 'Template_Reel.psd'); // opcional: base do "Criar template" (sem ele vale assets/layout.json)
const ASSETS = path.join(ROOT, 'assets');
const DEFAULT_TEMPLATE = path.join(ASSETS, 'template-padrao.png'); // usado enquanto não existir Template_Reel.png
const UPLOADS = path.join(ROOT, 'tmp');
const OUTPUT = path.join(ROOT, 'output');
const DATA = path.join(ROOT, 'data');
const DOWNLOADS = path.join(ROOT, 'downloads');
const COOKIES = path.join(ROOT, 'cookies.txt'); // opcional: cookies exportados do navegador (Instagram costuma exigir login)
const YTDLP = process.env.YTDLP || 'yt-dlp';
// Sites aceitos no downloader (inclui subdomínios)
// Navegadores de onde o yt-dlp pode ler o login (cookies) do usuário
const COOKIE_BROWSERS = ['chrome', 'chromium', 'firefox', 'brave', 'edge', 'opera', 'vivaldi'];
const DOWNLOAD_HOSTS = ['instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com'];
const SETTINGS = path.join(DATA, 'settings.json');
const TPL_STATE = path.join(DATA, 'template.json'); // edição do template (nome, @user, foto...)
const TPL_AVATAR = path.join(DATA, 'avatar.png');
const TPL_BACKUPS = path.join(DATA, 'backups');
const W = 1080;
const H = 1920;
const PORT = process.env.PORT || 3000;

mkdirSync(UPLOADS, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });

const upload = multer({ dest: UPLOADS }).fields([
  { name: 'video', maxCount: 1 },
  { name: 'bars', maxCount: 1 }, // PNG 1080x1920 com as barras (entre o vídeo e o template)
  { name: 'overlay', maxCount: 1 }, // PNG 1080x1920 com os textos (por cima de tudo)
]);
const app = express();

app.use(express.static(path.join(ROOT, 'public')));
app.use('/downloads', express.static(DOWNLOADS));
app.use('/fonts', express.static(path.join(ROOT, 'node_modules', '@fontsource')));
app.get('/template.png', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(existsSync(TEMPLATE) ? TEMPLATE : DEFAULT_TEMPLATE));

// Estado do editor (enquadramento + textos), salvo em data/settings.json
app.get('/api/settings', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(SETTINGS, 'utf8')));
  } catch {
    res.json({});
  }
});

app.put('/api/settings', express.json({ limit: '1mb' }), (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  const tmp = `${SETTINGS}.tmp`;
  writeFileSync(tmp, JSON.stringify(req.body, null, 2));
  renameSync(tmp, SETTINGS);
  res.json({ ok: true });
});

// ---------- Criar template (a partir do Template_Reel.psd) ----------
const pngSize = (b) => (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);
const writeAtomic = (file, data) => {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
};

// Camadas do PSD (textos, posições, cores) sem os pixels; o selo vai em /api/template/badge.png
app.get('/api/template/psd', (_req, res) => {
  try {
    const { width, height, layers } = loadLayout(PSD, ASSETS);
    res.json({ width, height, source: existsSync(PSD) ? 'psd' : 'padrao', layers: layers.map(({ png, ...l }) => ({ ...l, hasImage: !!png })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/template/layer/:name.png', (req, res) => {
  try {
    const layer = loadLayout(PSD, ASSETS).layers.find((l) => l.name === req.params.name);
    if (!layer?.png) return res.status(404).end();
    res.type('png').set('Cache-Control', 'no-cache').send(layer.png);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/template/state', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(TPL_STATE, 'utf8')));
  } catch {
    res.json({});
  }
});

app.put('/api/template/state', express.json({ limit: '100kb' }), (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'JSON inválido' });
  writeAtomic(TPL_STATE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Foto de perfil usada no template (o navegador manda PNG já reduzido)
app.get('/api/template/avatar', (_req, res) => {
  if (!existsSync(TPL_AVATAR)) return res.status(404).end();
  res.type('png').set('Cache-Control', 'no-cache').sendFile(TPL_AVATAR);
});

app.put('/api/template/avatar', express.raw({ type: 'image/png', limit: '15mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !pngSize(req.body)) return res.status(400).json({ error: 'Envie a foto como PNG' });
  writeAtomic(TPL_AVATAR, req.body);
  res.json({ ok: true });
});

// Passa o PNG criado a ser o template usado pelo editor (guarda o anterior em data/backups/)
app.post('/api/template/use', express.raw({ type: 'image/png', limit: '30mb' }), (req, res) => {
  const size = Buffer.isBuffer(req.body) && pngSize(req.body);
  if (!size || size.w !== W || size.h !== H) return res.status(400).json({ error: `O template precisa ser um PNG ${W}x${H}` });
  let backup = null;
  if (existsSync(TEMPLATE)) {
    mkdirSync(TPL_BACKUPS, { recursive: true });
    backup = `Template_Reel.${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    copyFileSync(TEMPLATE, path.join(TPL_BACKUPS, backup));
  }
  writeAtomic(TEMPLATE, req.body);
  res.json({ ok: true, backup: backup && `data/backups/${backup}` });
});

// Baixa o vídeo de um link (yt-dlp) para downloads/ e devolve a URL para o editor carregar
app.post('/api/download', express.json(), (req, res) => {
  let url;
  try {
    url = new URL(String(req.body?.url || '').trim());
  } catch {
    return res.status(400).json({ error: 'Link inválido' });
  }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || !DOWNLOAD_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return res.status(400).json({ error: 'Link não suportado. Use um link de Instagram, TikTok, YouTube, Facebook ou X.' });
  }

  const args = [
    '--no-playlist', '--no-warnings', '--restrict-filenames',
    '-S', 'vcodec:h264,res,acodec:aac', // h264/aac para o preview tocar em qualquer navegador
    '--merge-output-format', 'mp4',
    '-P', DOWNLOADS, '-o', '%(extractor)s_%(id)s.%(ext)s',
    '--no-simulate', '--print', 'after_move:filepath',
  ];
  const browser = COOKIE_BROWSERS.includes(req.body?.browser) ? req.body.browser : process.env.YTDLP_COOKIES_BROWSER;
  let withLogin = true;
  if (existsSync(COOKIES)) args.push('--cookies', COOKIES);
  else if (browser) args.push('--cookies-from-browser', browser);
  else withLogin = false;
  args.push('--', url.href);

  const yt = spawn(YTDLP, args);
  let out = '';
  let err = '';
  let done = false;
  const finish = (status, body) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    res.status(status).json(body);
  };
  const timer = setTimeout(() => {
    yt.kill();
    finish(504, { error: 'Tempo esgotado ao baixar o vídeo' });
  }, 180_000);

  yt.stdout.on('data', (d) => (out += d));
  yt.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  yt.on('error', (e) => {
    finish(e.code === 'ENOENT' ? 501 : 500, {
      error: e.code === 'ENOENT' ? 'yt-dlp não encontrado. Instale com: pipx install yt-dlp' : `Falha ao iniciar yt-dlp: ${e.message}`,
    });
  });
  yt.on('close', (code) => {
    const file = path.basename(out.trim().split('\n').pop() || '');
    if (code !== 0 || !file) {
      console.error(`[download] yt-dlp saiu com código ${code}:\n${err}`);
      const msg = err.split('\n').filter((l) => l.startsWith('ERROR')).pop() || err.trim().split('\n').pop();
      if (!withLogin && /empty media|log ?in|cookies|rate-limit/i.test(msg || '')) {
        return finish(502, { error: 'O Instagram exigiu login. Escolha em "Login" o navegador em que você está logado no Instagram e tente de novo.' });
      }
      if (/secretstorage/i.test(err)) {
        return finish(502, { error: 'O yt-dlp não consegue ler os cookies criptografados do navegador. Instale o módulo que falta: pipx inject yt-dlp secretstorage' });
      }
      if (/Failed to parse JSON/i.test(msg || '')) {
        return finish(502, { error: 'O Instagram devolveu uma resposta vazia (bloqueio temporário da sessão/IP ou yt-dlp desatualizado). Tente de novo em alguns minutos ou atualize o yt-dlp para a versão nightly.' });
      }
      return finish(502, { error: msg || 'Não foi possível baixar o vídeo' });
    }
    finish(200, { file, url: `/downloads/${encodeURIComponent(file)}` });
  });
});

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Recebe o vídeo (+ overlay de texto opcional) + params { x, y, w, h, start, end, bg } (coordenadas no canvas 1080x1920)
app.post('/render', upload, (req, res) => {
  const input = req.files?.video?.[0]?.path;
  const overlay = req.files?.overlay?.[0]?.path;
  const bars = req.files?.bars?.[0]?.path;
  const cleanup = () => [input, overlay, bars].forEach((f) => f && rmSync(f, { force: true }));
  try {
    if (!input) throw new Error('Nenhum vídeo enviado');
    const p = JSON.parse(req.body.params || '{}');

    const w = even(num(p.w, W));
    const h = even(num(p.h, H));
    const x = Math.round(num(p.x, 0));
    const y = Math.round(num(p.y, 0));
    const start = Math.max(0, num(p.start, 0));
    const end = num(p.end, 0);
    const bg = /^#[0-9a-f]{6}$/i.test(p.bg) ? p.bg.replace('#', '0x') : '0x000000';

    const trim = ['-ss', String(start)];
    if (end > start) trim.push('-t', String(end - start));

    // Entradas: 0 = vídeo, 1 = template, depois barras e texto (se houver).
    // Ordem das camadas: fundo -> vídeo -> barras -> template -> texto.
    const extra = [];
    const addInput = (file) => {
      extra.push('-loop', '1', '-i', file);
      return extra.filter((a) => a === '-i').length + 1; // índice da entrada (template é a 1)
    };
    const barsIdx = bars ? addInput(bars) : null;
    const textIdx = overlay ? addInput(overlay) : null;

    const chain = [
      `color=c=${bg}:s=${W}x${H}:r=30[bg]`,
      `[0:v]scale=${w}:${h}:flags=lanczos,setsar=1[v]`,
      `[bg][v]overlay=${x}:${y}:shortest=1[l0]`,
    ];
    let last = 'l0';
    [barsIdx, 1, textIdx].filter(Boolean).forEach((idx, n) => {
      chain.push(`[${last}][${idx}:v]overlay=0:0:shortest=1[l${n + 1}]`);
      last = `l${n + 1}`;
    });
    chain.push(`[${last}]format=yuv420p[out]`);
    const filter = chain.join(';');

    const name = `reel_${Date.now()}.mp4`;
    const out = path.join(OUTPUT, name);
    const args = [
      '-y', ...trim, '-i', input,
      '-loop', '1', '-i', existsSync(TEMPLATE) ? TEMPLATE : DEFAULT_TEMPLATE,
      ...extra,
      '-filter_complex', filter,
      '-map', '[out]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '-shortest',
      out,
    ];

    const ff = spawn('ffmpeg', args);
    let log = '';
    ff.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
    ff.on('error', (e) => {
      cleanup();
      res.status(500).json({ error: `Falha ao iniciar ffmpeg: ${e.message}` });
    });
    ff.on('close', (code) => {
      cleanup();
      if (code !== 0) return res.status(500).json({ error: 'ffmpeg falhou', log });
      res.download(out, name);
    });
  } catch (e) {
    cleanup();
    res.status(400).json({ error: e.message });
  }
});

// Só aceita conexões da própria máquina (o servidor roda ffmpeg/yt-dlp e não tem login)
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`Reel Maker em http://localhost:${PORT}`));
