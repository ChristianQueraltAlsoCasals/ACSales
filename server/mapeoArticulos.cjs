/**
 * Mapeo Also→Ferros para unir históricos de artículos.
 * CSV embebido en ACSales (producción no tiene el bot montado).
 *
 * Ruta por defecto:  data/mapeo_reemplazo_items.csv  (junto a server/ → ../data)
 * Override:          MAPEO_ARTICULOS_CSV=/ruta/absoluta.csv
 *
 * En cada subida a producción: sustituir ese CSV por la versión actualizada
 * del bot (Bot_Sustituir_Productes/salida/mapeo_reemplazo_items.csv).
 */
const fs = require("fs");
const path = require("path");

const RUTAS_CANDIDATAS = [
  // Producción Docker: /app/data/... (WORKDIR /app, CSV copiado a data/)
  path.resolve(__dirname, "data/mapeo_reemplazo_items.csv"),
  // Dev local: ACSales/data/... (server/ está en ACSales/server)
  path.resolve(__dirname, "../data/mapeo_reemplazo_items.csv"),
];

/** Estados que NO enlazan historial (sin producto usable o omitidos). */
const ESTADOS_EXCLUIDOS = new Set([
  "DRY_RUN",
  "SKIP_YA_HECHO",
  "SKIP_BLOQUEADO",
  "SKIP_CATS",
  "FAIL_CREATE",
  "FAIL_CATS",
  "",
]);

function rutaMapeo() {
  const env = (process.env.MAPEO_ARTICULOS_CSV || "").trim();
  if (env && fs.existsSync(env)) return env;
  for (const r of RUTAS_CANDIDATAS) {
    if (fs.existsSync(r)) return r;
  }
  return null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function cargarMapeo() {
  const ruta = rutaMapeo();
  if (!ruta) {
    return { ok: false, error: "CSV mapeo no encontrado en data/mapeo_reemplazo_items.csv", ruta: null, pares: [], porCodigo: {} };
  }
  const texto = fs.readFileSync(ruta, "utf8");
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) {
    return { ok: true, ruta, pares: [], porCodigo: {}, n: 0 };
  }
  const headers = parseCsvLine(lineas[0]).map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);
  const iViejo = idx("codigo_viejo");
  const iNuevo = idx("codigo_nuevo");
  const iDesc = idx("descripcion");
  const iEst = idx("estado");

  const pares = [];
  const porCodigo = {};

  for (let i = 1; i < lineas.length; i++) {
    const cols = parseCsvLine(lineas[i]);
    const viejo = String(cols[iViejo] || "").trim();
    const nuevo = String(cols[iNuevo] || "").trim();
    const estado = String(cols[iEst] || "").trim();
    const descripcion = String(cols[iDesc] || "").trim();
    if (!viejo || !nuevo) continue;
    if (ESTADOS_EXCLUIDOS.has(estado)) continue;
    const pendienteSync =
      estado === "PENDIENTE" ||
      estado === "PENDIENTE_BLOQUEO" ||
      estado === "FAIL_VERIFY";
    const meta = {
      codigo_viejo: viejo,
      codigo_nuevo: nuevo,
      descripcion,
      estado,
      pendienteSync,
      empresaViejo: "Also",
      empresaNuevo: "Ferros",
    };
    pares.push(meta);
    porCodigo[viejo] = meta;
    porCodigo[nuevo] = meta;
  }

  return { ok: true, ruta, pares, porCodigo, n: pares.length };
}

module.exports = { cargarMapeo, rutaMapeo, ESTADOS_EXCLUIDOS };
