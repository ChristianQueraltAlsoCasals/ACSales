const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

/** Límite práctico bajo el tope JSONB de Postgres (~256 MB). */
const JSONB_SAFE_BYTES = 240 * 1024 * 1024;

let _pg = null;

function getPool() {
  if (!_pg) {
    if (!process.env.DATABASE_URL) {
      throw new Error("Falta DATABASE_URL en el entorno (.env en la raíz del repo).");
    }
    _pg = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: "-c client_encoding=UTF8",
    });
  }
  return _pg;
}

/** Proxy compatible con auth/erp-auth (esperan `pool.query`). */
const pool = {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
};

/** Hook vacío (otras apps siembran datos por usuario; ACsales no). */
async function sembrarUsuario(_usuarioId, _email) {
  return;
}

async function init() {
  const p = getPool();
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await p.query(schema);
  const { rows } = await p.query("SELECT count(*)::int AS n FROM app_state");
  console.log(`[db] Postgres OK · app_state con ${rows[0].n} clave(s)`);

  const { rows: usuarios } = await p.query("SELECT count(*)::int AS n FROM usuarios");
  if (usuarios[0].n === 0) {
    const username = (process.env.ADMIN_USER || "admin").toLowerCase();
    const email = (process.env.ADMIN_EMAIL || "admin@empresa.local").toLowerCase();
    const password = process.env.ADMIN_PASSWORD || "canviam123";
    const hash = await bcrypt.hash(password, 10);
    await p.query(
      `INSERT INTO usuarios (nombre, username, email, password_hash, rol, auth_origen)
       VALUES ($1, $2, $3, $4, 'admin', 'local')`,
      ["Admin", username, email, hash]
    );
    console.log(`[db] Usuario administrador local creado: ${username} (${email})`);
  }
  return p;
}

async function getDoc(clave, fallback = {}) {
  const { rows } = await getPool().query(
    "SELECT valor FROM app_state WHERE clave = $1",
    [clave]
  );
  if (!rows.length) return fallback;
  return rows[0].valor;
}

async function setDoc(clave, valor) {
  const json = JSON.stringify(valor ?? {});
  if (Buffer.byteLength(json) > JSONB_SAFE_BYTES) {
    throw new Error(
      `Documento "${clave}" supera ~240 MB (${(Buffer.byteLength(json) / 1e6).toFixed(0)} MB). ` +
        "Hay que partirlo (como bcData por fuente)."
    );
  }
  await getPool().query(
    `INSERT INTO app_state (clave, valor, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, updated_at = now()`,
    [clave, json]
  );
}

async function deleteDoc(clave) {
  await getPool().query("DELETE FROM app_state WHERE clave = $1", [clave]);
}

async function upsertEstadoKey(client, claveCompleta, valor) {
  const json = JSON.stringify(valor);
  const bytes = Buffer.byteLength(json);
  if (bytes > JSONB_SAFE_BYTES) {
    throw new Error(
      `Clave ${claveCompleta} supera el límite JSONB (${(bytes / 1e6).toFixed(1)} MB).`
    );
  }
  await client.query(
    `INSERT INTO app_state (clave, valor, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, updated_at = now()`,
    [claveCompleta, json]
  );
}

/**
 * GET estado: reconstruye bcData desde estado.bcData.<fuente>
 * (el resto de claves top-level siguen en estado.<clave>).
 */
async function getEstado() {
  const { rows } = await getPool().query(
    `SELECT clave, valor FROM app_state WHERE clave LIKE 'estado.%'`
  );
  const out = {};
  const bcData = {};
  let hasBcParts = false;

  for (const r of rows) {
    const rest = r.clave.slice("estado.".length);
    if (rest === "bcData") {
      // legado: un solo blob (no debería existir tras el split)
      out.bcData = r.valor;
      continue;
    }
    if (rest.startsWith("bcData.")) {
      hasBcParts = true;
      bcData[rest.slice("bcData.".length)] = r.valor;
      continue;
    }
    out[rest] = r.valor;
  }

  if (hasBcParts) {
    out.bcData = { ...(out.bcData && typeof out.bcData === "object" ? out.bcData : {}), ...bcData };
  }
  return out;
}

/**
 * POST estado: si viene bcData como objeto, se guarda UNA fila por fuente
 * (estado.bcData.pedidos_venta, …) para no superar el límite JSONB de ~256 MB.
 */
async function mergeEstado(patch) {
  const keys = Object.keys(patch || {});
  const client = await getPool().connect();
  const guardadas = [];
  try {
    await client.query("BEGIN");
    for (const k of keys) {
      const valor = patch[k];
      if (k === "bcData" && valor && typeof valor === "object" && !Array.isArray(valor)) {
        // Quitar blob monolítico si existía
        await client.query(`DELETE FROM app_state WHERE clave = 'estado.bcData'`);
        const fuentes = Object.keys(valor);
        for (const fuente of fuentes) {
          await upsertEstadoKey(client, `estado.bcData.${fuente}`, valor[fuente]);
          guardadas.push(`bcData.${fuente}`);
        }
        // Fuentes que ya no vienen en el patch: no las borramos en un merge parcial.
        // Si el cliente manda bcData completo (comportamiento actual), todas se reescriben.
      } else {
        await upsertEstadoKey(client, `estado.${k}`, valor);
        guardadas.push(k);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return guardadas;
}

async function deleteEstado() {
  await getPool().query(`DELETE FROM app_state WHERE clave LIKE 'estado.%'`);
}

module.exports = {
  init,
  getPool,
  pool,
  sembrarUsuario,
  getDoc,
  setDoc,
  deleteDoc,
  getEstado,
  mergeEstado,
  deleteEstado,
};
