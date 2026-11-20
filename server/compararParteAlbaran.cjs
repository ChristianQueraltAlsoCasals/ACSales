/**
 * Cruza el material del parte de trabajo (Also) con las líneas del albarán
 * de venta (Business Central). El parte es la fuente: si un artículo está
 * en el parte y no en el albarán, o con menos cantidad, falta por facturar.
 */
const pdfParse = require("pdf-parse");

function numCant(s) {
  const t = String(s || "").trim().replace(/[^\d,.-]/g, "");
  if (!t || !/\d/.test(t)) return null;
  const n = /,/.test(t)
    ? parseFloat(t.replace(/\./g, "").replace(",", "."))
    : parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function clave(codigo) {
  return String(codigo || "").replace(/\s+/g, "").toUpperCase();
}

function fmtCant(n) {
  return Number(n).toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

async function itemsPorPagina(buf) {
  const paginas = [];
  await pdfParse(buf, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent({ disableCombineTextItems: true });
      paginas.push(
        (tc.items || [])
          .filter((it) => it.str && String(it.str).trim())
          .map((it) => ({ x: it.transform[4], y: it.transform[5], s: String(it.str).trim() }))
      );
      return "";
    },
  });
  return paginas;
}

function filasDe(items) {
  const orden = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const filas = [];
  for (const it of orden) {
    const ult = filas[filas.length - 1];
    if (ult && Math.abs(ult.y - it.y) <= 3) ult.items.push(it);
    else filas.push({ y: it.y, items: [it] });
  }
  for (const f of filas) f.items.sort((a, b) => a.x - b.x);
  return filas;
}

function textoFila(f) {
  return f.items.map((i) => i.s).join(" ");
}

function cerca(fila, x, margen) {
  return fila.items
    .filter((i) => Math.abs(i.x - x) <= margen)
    .map((i) => i.s)
    .join(" ")
    .trim();
}

function codigoYDescripcion(items) {
  const limpio = items.map((i) => i.s).filter(Boolean);
  if (!limpio.length) return { codigo: "", descripcion: "" };
  if (limpio.length === 1) {
    const m = /^(\S+)\s+(.+)$/.exec(limpio[0]);
    if (m) return { codigo: m[1], descripcion: m[2].replace(/\s+/g, " ").trim() };
    return { codigo: limpio[0], descripcion: "" };
  }
  return {
    codigo: limpio[0],
    descripcion: limpio.slice(1).join(" ").replace(/\s+/g, " ").trim(),
  };
}

function sumar(map, codigo, descripcion, qty) {
  const k = clave(codigo);
  if (!k || !(qty > 0)) return;
  const prev = map.get(k);
  if (prev) {
    prev.qty += qty;
    if (!prev.descripcion && descripcion) prev.descripcion = descripcion;
  } else {
    map.set(k, { codigo: k, descripcion: descripcion || k, qty });
  }
}

function leerAlbaran(paginas) {
  const material = new Map();
  let horas = 0;
  for (const items of paginas) {
    const filas = filasDe(items);
    const cab = filas.find((f) => f.items.some((i) => /^CANTIDAD$/i.test(i.s)));
    if (!cab) continue;
    const xCant = cab.items.find((i) => /^CANTIDAD$/i.test(i.s)).x;
    for (const f of filas) {
      if (f.y >= cab.y - 2) continue;
      if (/^TOTAL\b/i.test(textoFila(f))) break;
      const izq = f.items.filter((i) => i.x < xCant - 25);
      const { codigo, descripcion } = codigoYDescripcion(izq);
      const qty = numCant(cerca(f, xCant, 18));
      if (!codigo || qty == null) continue;
      if (/mano de obra/i.test(descripcion)) horas += qty;
      else if (qty > 0.0001) sumar(material, codigo, descripcion, qty);
    }
  }
  return { material, horas };
}

function leerParte(paginas) {
  const material = new Map();
  let horas = 0;
  for (const items of paginas) {
    const filas = filasDe(items);
    const cabMat = filas.find((f) => f.items.some((i) => /^QTY$/i.test(i.s)) && f.items.some((i) => /^Codi$/i.test(i.s) || /Art[ií]cle/i.test(i.s)));
    const cabH = filas.find((f) => f.items.some((i) => /^Hores$/i.test(i.s)));
    if (cabH) {
      const xH = cabH.items.find((i) => /^Hores$/i.test(i.s)).x;
      for (const f of filas) {
        if (f.y >= cabH.y - 2) continue;
        if (cabMat && f.y <= cabMat.y + 2) break;
        if (/^DESCRIPCI/i.test(textoFila(f))) break;
        const h = numCant(cerca(f, xH, 24));
        const nombre = f.items.filter((i) => i.x < xH - 20).map((i) => i.s).join(" ").trim();
        if (nombre && h != null && h > 0) horas += h;
      }
    }
    if (!cabMat) continue;
    const xQty = cabMat.items.find((i) => /^QTY$/i.test(i.s)).x;
    for (const f of filas) {
      if (f.y >= cabMat.y - 2) continue;
      if (/^DESCRIPCI/i.test(textoFila(f))) break;
      const izq = f.items.filter((i) => i.x < xQty - 20);
      const { codigo, descripcion } = codigoYDescripcion(izq);
      const qty = numCant(cerca(f, xQty, 22));
      if (codigo && qty != null && qty > 0.0001) sumar(material, codigo, descripcion, qty);
    }
  }
  return { material, horas };
}

function textoDe(falta, deMas) {
  const trozos = [];
  if (falta.length) {
    trozos.push(
      "Falta en el albarán: " +
        falta.map((f) => `${f.descripcion} × ${fmtCant(f.falta)} (parte ${fmtCant(f.enParte)}, albarán ${fmtCant(f.enAlbaran)})`).join("; ")
    );
  } else {
    trozos.push("El material del parte está en el albarán.");
  }
  if (deMas.length) {
    trozos.push(
      "En el albarán y no en el parte: " +
        deMas.map((f) => `${f.descripcion} × ${fmtCant(f.falta)}`).join("; ")
    );
  }
  return trozos.join(" ");
}

async function compararParteYAlbaran(albaranBuf, parteBuf) {
  const [pagAlb, pagParte] = await Promise.all([
    itemsPorPagina(albaranBuf),
    itemsPorPagina(parteBuf),
  ]);
  const alb = leerAlbaran(pagAlb);
  const par = leerParte(pagParte);
  const falta = [];
  for (const [k, lin] of par.material) {
    const enAlbaran = alb.material.get(k)?.qty || 0;
    if (lin.qty > enAlbaran + 0.001) {
      falta.push({
        codigo: lin.codigo,
        descripcion: lin.descripcion,
        enParte: lin.qty,
        enAlbaran,
        falta: Math.round((lin.qty - enAlbaran) * 1000) / 1000,
      });
    }
  }
  const deMas = [];
  for (const [k, lin] of alb.material) {
    const enParte = par.material.get(k)?.qty || 0;
    if (lin.qty > enParte + 0.001) {
      deMas.push({
        codigo: lin.codigo,
        descripcion: lin.descripcion,
        enParte,
        enAlbaran: lin.qty,
        falta: Math.round((lin.qty - enParte) * 1000) / 1000,
      });
    }
  }
  const horas = {
    parte: Math.round(par.horas * 100) / 100,
    albaran: Math.round(alb.horas * 100) / 100,
  };
  horas.cuadra = Math.abs(horas.parte - horas.albaran) < 0.05 || (horas.parte === 0 && horas.albaran === 0);
  let texto = textoDe(falta, deMas);
  if (!horas.cuadra && (horas.parte > 0 || horas.albaran > 0)) {
    texto += ` Horas: parte ${fmtCant(horas.parte)}, albarán ${fmtCant(horas.albaran)}.`;
  }
  return {
    falta,
    deMas,
    horas,
    texto,
    cuadra: falta.length === 0,
  };
}

module.exports = { compararParteYAlbaran };
