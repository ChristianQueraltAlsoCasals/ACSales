/**
 * Importa server/data/*.json → Postgres (app_state).
 * Uso (con DB arriba y DATABASE_URL en el .env de la raíz):
 *   node --max-old-space-size=8192 scripts/import-data-json.js
 *
 * bcData se parte automáticamente en estado.bcData.<fuente> (límite JSONB).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
require("dotenv").config();
const { init, setDoc, mergeEstado, getPool } = require("../db");

const DATA = path.join(__dirname, "..", "data");

function leerJson(nombre) {
  const p = path.join(DATA, nombre);
  if (!fs.existsSync(p)) {
    console.log(`[import] skip ${nombre} (no existe)`);
    return null;
  }
  const mb = (fs.statSync(p).size / 1e6).toFixed(1);
  console.log(`[import] leyendo ${nombre} (${mb} MB)…`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  await init();
  const pool = getPool();

  const recepcion = leerJson("recepcion.json");
  if (recepcion) {
    await setDoc("recepcion", recepcion);
    console.log("[import] recepcion OK");
  }

  const avisos = leerJson("avisos.json");
  if (avisos) {
    await setDoc("avisos", avisos);
    console.log("[import] avisos OK");
  }

  const registro = leerJson("registro_facturas_compra.json");
  if (registro) {
    await setDoc("registro_facturas_compra", Array.isArray(registro) ? registro : []);
    console.log(`[import] registro_facturas_compra OK (${Array.isArray(registro) ? registro.length : 0} filas)`);
  }

  const atributos = leerJson("atributos.json");
  if (atributos) {
    await setDoc("atributos", atributos);
    console.log(`[import] atributos OK (${Object.keys(atributos).length} claves)`);
  }

  const estado = leerJson("estado.json");
  if (estado && typeof estado === "object") {
    const keys = Object.keys(estado);
    console.log(`[import] estado → ${keys.length} claves: ${keys.join(", ")}`);
    // Una a una para no duplicar 400 MB en un solo UPDATE enorme si falla a mitad
    for (const k of keys) {
      const t0 = Date.now();
      await mergeEstado({ [k]: estado[k] });
      console.log(`[import] estado.${k} OK (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }

  const { rows } = await pool.query(
    "SELECT clave, pg_column_size(valor) AS bytes FROM app_state ORDER BY clave"
  );
  console.log("[import] resumen app_state:");
  for (const r of rows) {
    console.log(`  ${r.clave}: ${(r.bytes / 1e6).toFixed(2)} MB`);
  }
  await pool.end();
  console.log("[import] listo");
}

main().catch((err) => {
  console.error("[import] ERROR", err);
  process.exit(1);
});
