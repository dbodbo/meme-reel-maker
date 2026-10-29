import { existsSync, readFileSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

// Leitor mínimo de PSD (8 bits, RGB): só o que o "Criar template" precisa.
// Devolve as camadas (nome, caixa, texto/fonte/tamanho/cor das camadas de texto) e,
// para camadas de pixels (ex.: o selo "Verificado"), o recorte em PNG.

let cache = null; // { mtime, data }

// Sem PSD na pasta, usa o layout padrão embutido (assets/layout.json + assets/verificado.png)
export function defaultLayout(dir) {
  const layout = JSON.parse(readFileSync(`${dir}/layout.json`, 'utf8'));
  const png = readFileSync(`${dir}/verificado.png`);
  return { ...layout, layers: layout.layers.map((l) => ({ visible: true, opacity: 1, ...l, ...(l.kind === 'pixel' ? { png } : {}) })) };
}

// PSD do usuário, se existir; senão o layout padrão
export function loadLayout(psdFile, assetsDir) {
  return existsSync(psdFile) ? readPsd(psdFile) : defaultLayout(assetsDir);
}

export function readPsd(file) {
  const mtime = statSync(file).mtimeMs;
  if (cache?.file === file && cache.mtime === mtime) return cache.data;
  const data = parse(readFileSync(file));
  cache = { file, mtime, data };
  return data;
}

function parse(buf) {
  if (buf.toString('latin1', 0, 4) !== '8BPS' || buf.readUInt16BE(4) !== 1) throw new Error('Arquivo não é um PSD válido');
  if (buf.readUInt16BE(22) !== 8 || buf.readUInt16BE(24) !== 3) throw new Error('Só PSD RGB de 8 bits é suportado');
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);

  let p = 26;
  p += 4 + buf.readUInt32BE(p); // color mode data
  p += 4 + buf.readUInt32BE(p); // image resources
  p += 4; // tamanho da seção layer+mask
  p += 4; // tamanho do layer info
  const count = Math.abs(buf.readInt16BE(p));
  p += 2;

  const layers = [];
  for (let i = 0; i < count; i++) {
    const L = { top: buf.readInt32BE(p), left: buf.readInt32BE(p + 4), bottom: buf.readInt32BE(p + 8), right: buf.readInt32BE(p + 12), channels: [] };
    const nch = buf.readUInt16BE(p + 16);
    p += 18;
    for (let c = 0; c < nch; c++, p += 6) L.channels.push({ id: buf.readInt16BE(p), len: buf.readUInt32BE(p + 2) });
    p += 8; // assinatura + modo de mistura
    L.opacity = buf.readUInt8(p) / 255;
    L.visible = !(buf.readUInt8(p + 2) & 2);
    p += 4;
    const extraLen = buf.readUInt32BE(p);
    p += 4;
    Object.assign(L, parseExtra(buf.subarray(p, p + extraLen)));
    p += extraLen;
    layers.push(L);
  }

  // Dados dos canais, na mesma ordem das camadas
  for (const L of layers) {
    const w = L.right - L.left;
    const h = L.bottom - L.top;
    for (const ch of L.channels) {
      if (w > 0 && h > 0) ch.data = decodeChannel(buf, p, ch.len, w, h);
      p += ch.len;
    }
  }

  const out = layers.map((L) => {
    const base = {
      name: L.name,
      x: L.left, y: L.top, w: L.right - L.left, h: L.bottom - L.top,
      visible: L.visible, opacity: L.opacity,
    };
    if (L.text) return { ...base, kind: 'text', ...L.text };
    if (L.solidColor) return { ...base, kind: 'shape', color: L.solidColor };
    return { ...base, kind: 'pixel', png: toPng(L) };
  });
  return { width, height, layers: out };
}

// Campos extras da camada: nome unicode (luni), cor sólida (SoCo) e texto (TySh)
function parseExtra(ex) {
  let q = 4 + ex.readUInt32BE(0); // layer mask
  q += 4 + ex.readUInt32BE(q); // blending ranges
  const nameLen = ex[q];
  let name = ex.toString('latin1', q + 1, q + 1 + nameLen);
  q += 1 + nameLen;
  q = Math.ceil(q / 4) * 4;
  const res = {};
  while (q + 12 <= ex.length) {
    const key = ex.toString('latin1', q + 4, q + 8);
    const len = ex.readUInt32BE(q + 8);
    const body = ex.subarray(q + 12, q + 12 + len);
    q += 12 + len;
    if (key === 'luni') name = readUnicode(body);
    else if (key === 'TySh') res.text = parseText(body);
    else if (key === 'SoCo') res.solidColor = parseSolidColor(body);
  }
  return { name: name.replace(/\0+$/, ''), ...res };
}

function readUnicode(body) {
  const n = body.readUInt32BE(0);
  return Buffer.from(body.subarray(4, 4 + n * 2)).swap16().toString('utf16le');
}

// Camada de preenchimento sólido: descritor com Rd/Grn/Bl (doubles 'doub' de 0 a 255)
function parseSolidColor(body) {
  const s = body.toString('latin1');
  const get = (k) => {
    const i = s.indexOf(k);
    const j = i < 0 ? -1 : s.indexOf('doub', i);
    return j < 0 ? 0 : Math.round(body.readDoubleBE(j + 4));
  };
  const hex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${hex(get('Rd'))}${hex(get('Grn'))}${hex(get('Bl'))}`;
}

// TySh: transformação (xx, xy, yx, yy, tx, ty) + descritor com o EngineData (texto, fonte, tamanho, cor)
function parseText(body) {
  const [xx, , , yy, tx, ty] = Array.from({ length: 6 }, (_, i) => body.readDoubleBE(2 + i * 8));
  const s = body.toString('latin1');
  const engine = s.slice(s.indexOf('/EngineDict'));
  const text = (/\/Text \(\xfe\xff((?:[^)\\]|\\.)*)\)/s.exec(engine) || [])[1] || '';
  const decoded = Buffer.from(text.replace(/\\(.)/gs, '$1'), 'latin1').swap16().toString('utf16le').replace(/[\r\n]+$/, '');
  const rawFont = (/\/FontSet\s*\[\s*<<\s*\/Name \(\xfe\xff([^)]*)\)/s.exec(engine) || [])[1];
  const font = rawFont ? Buffer.from(rawFont, 'latin1').swap16().toString('utf16le') : 'Inter-Regular';
  const size = Number((/\/FontSize ([\d.]+)/.exec(engine) || [])[1] || 0);
  const fill = (/\/FillColor\s*<<\s*\/Type \d+\s*\/Values \[ ([\d.\s-]+)\]/s.exec(engine) || [])[1];
  const [, r = 1, g = 1, b = 1] = (fill || '').trim().split(/\s+/).map(Number);
  const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return {
    content: decoded,
    font,
    size: size * yy, // tamanho efetivo em px (o PSD escala o texto pela transformação)
    color: `#${hex(r)}${hex(g)}${hex(b)}`,
    // origem do texto: início da linha de base
    ox: tx,
    oy: ty,
    scaleX: xx,
  };
}

// Canal em RAW (0), RLE/PackBits (1) ou ZIP (2)
function decodeChannel(buf, start, len, w, h) {
  const comp = buf.readUInt16BE(start);
  const data = buf.subarray(start + 2, start + len);
  if (comp === 0) return data;
  if (comp === 2) return zlib.inflateSync(data);
  if (comp !== 1) throw new Error(`Compressão de canal ${comp} não suportada`);
  const out = Buffer.alloc(w * h);
  let src = h * 2; // tabela com o tamanho de cada linha
  let dst = 0;
  for (let row = 0; row < h; row++) {
    const end = src + data.readUInt16BE(row * 2);
    while (src < end) {
      const n = data.readInt8(src++);
      if (n >= 0) {
        data.copy(out, dst, src, src + n + 1);
        dst += n + 1;
        src += n + 1;
      } else if (n !== -128) {
        out.fill(data[src++], dst, dst + 1 - n);
        dst += 1 - n;
      }
    }
  }
  return out;
}

// RGBA -> PNG (sem libs)
function toPng(L) {
  const w = L.right - L.left;
  const h = L.bottom - L.top;
  if (w <= 0 || h <= 0) return null;
  const ch = (id) => L.channels.find((c) => c.id === id)?.data;
  const [r, g, b] = [0, 1, 2].map(ch);
  if (!r || !g || !b) return null;
  const a = ch(-1);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      raw.writeUInt32BE(((r[i] << 24) | (g[i] << 16) | (b[i] << 8) | (a ? a[i] : 255)) >>> 0, row + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
