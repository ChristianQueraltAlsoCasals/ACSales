/**
 * Logo de la ficha de cliente (imagen de Business Central) para el correo
 * a los encargados. Recorta el margen vacío y lo deja pequeño.
 */
const zlib = require("zlib");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ANCHO = 120;
const MAX_ALTO = 28;
const MAX_PIXELS = 12_000_000;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo, datos) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(datos.length, 0);
  const t = Buffer.from(tipo);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, datos])), 0);
  return Buffer.concat([len, t, datos, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function leerPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG)) return null;
  let off = 8;
  let w = 0;
  let h = 0;
  let bit = 0;
  let color = 0;
  let inter = 0;
  let paleta = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const tipo = buf.toString("latin1", off + 4, off + 8);
    const datos = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (tipo === "IHDR") {
      w = datos.readUInt32BE(0);
      h = datos.readUInt32BE(4);
      bit = datos[8];
      color = datos[9];
      inter = datos[12];
    } else if (tipo === "PLTE") paleta = datos;
    else if (tipo === "tRNS") trns = datos;
    else if (tipo === "IDAT") idat.push(datos);
    else if (tipo === "IEND") break;
  }
  if (!w || !h || bit !== 8 || inter !== 0) return null;
  if (w * h > MAX_PIXELS) return null;
  const canales = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!canales) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = w * canales;
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    if (pos >= raw.length) return null;
    const filtro = raw[pos++];
    const fila = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const izquierda = i >= canales ? fila[i - canales] : 0;
      const arriba = prev[i];
      const arribaIzq = i >= canales ? prev[i - canales] : 0;
      const x = fila[i];
      if (filtro === 1) fila[i] = (x + izquierda) & 255;
      else if (filtro === 2) fila[i] = (x + arriba) & 255;
      else if (filtro === 3) fila[i] = (x + ((izquierda + arriba) >> 1)) & 255;
      else if (filtro === 4) fila[i] = (x + paeth(izquierda, arriba, arribaIzq)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * canales;
      const o = (y * w + x) * 4;
      if (color === 6) {
        rgba[o] = fila[s];
        rgba[o + 1] = fila[s + 1];
        rgba[o + 2] = fila[s + 2];
        rgba[o + 3] = fila[s + 3];
      } else if (color === 2) {
        rgba[o] = fila[s];
        rgba[o + 1] = fila[s + 1];
        rgba[o + 2] = fila[s + 2];
        rgba[o + 3] = 255;
      } else if (color === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = fila[s];
        rgba[o + 3] = 255;
      } else if (color === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = fila[s];
        rgba[o + 3] = fila[s + 1];
      } else if (color === 3 && paleta) {
        const idx = fila[s] * 3;
        rgba[o] = paleta[idx] || 0;
        rgba[o + 1] = paleta[idx + 1] || 0;
        rgba[o + 2] = paleta[idx + 2] || 0;
        rgba[o + 3] = trns && fila[s] < trns.length ? trns[fila[s]] : 255;
      }
    }
    prev = fila;
  }
  return { w, h, rgba };
}

function distancia(rgba, i, fondo) {
  return Math.abs(rgba[i] - fondo[0]) + Math.abs(rgba[i + 1] - fondo[1]) + Math.abs(rgba[i + 2] - fondo[2]);
}

function recortar(rgba, w, h) {
  const esquinas = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  const fondo = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    fondo[c] = Math.round(esquinas.reduce((a, i) => a + rgba[i + c], 0) / esquinas.length);
  }
  const vacio = (i) => rgba[i + 3] < 16 || distancia(rgba, i, fondo) < 36;
  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;
  const filaVacia = (y) => {
    const base = y * w * 4;
    for (let x = 0; x < w; x++) if (!vacio(base + x * 4)) return false;
    return true;
  };
  const colVacia = (x, y0, y1) => {
    for (let y = y0; y <= y1; y++) if (!vacio((y * w + x) * 4)) return false;
    return true;
  };
  while (top < bottom && filaVacia(top)) top++;
  while (bottom > top && filaVacia(bottom)) bottom--;
  while (left < right && colVacia(left, top, bottom)) left++;
  while (right > left && colVacia(right, top, bottom)) right--;
  if (right - left < 8 || bottom - top < 4) return null;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw === w && ch === h) return { rgba, w, h };
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    rgba.copy(out, y * cw * 4, ((top + y) * w + left) * 4, ((top + y) * w + left + cw) * 4);
  }
  return { rgba: out, w: cw, h: ch };
}

function escalar(rgba, w, h, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * h) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * w) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          const aa = rgba[i + 3];
          r += rgba[i] * aa;
          g += rgba[i + 1] * aa;
          b += rgba[i + 2] * aa;
          a += aa;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (!a || !n) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function escribirPng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Devuelve un PNG pequeño o null si no hay imagen útil. */
function prepararLogoCorreo(buffer, contentType) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 32 || buf.length > 4 * 1024 * 1024) return null;
  const esPng = buf.subarray(0, 8).equals(PNG);
  const esJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!esPng && !esJpeg) return null;
  if (esJpeg) {
    if (buf.length > 80 * 1024) return null;
    return { mime: "image/jpeg", base64: buf.toString("base64"), ancho: MAX_ANCHO, alto: MAX_ALTO };
  }
  const img = leerPng(buf);
  if (!img) return null;
  const rec = recortar(img.rgba, img.w, img.h);
  if (!rec) return null;
  const escala = Math.min(MAX_ANCHO / rec.w, MAX_ALTO / rec.h, 1);
  const dw = Math.max(1, Math.round(rec.w * escala));
  const dh = Math.max(1, Math.round(rec.h * escala));
  const pequeno = dw === rec.w && dh === rec.h ? rec.rgba : escalar(rec.rgba, rec.w, rec.h, dw, dh);
  const png = escribirPng(pequeno, dw, dh);
  return { mime: "image/png", base64: png.toString("base64"), ancho: dw, alto: dh };
}

module.exports = { prepararLogoCorreo };
