// Autenticación contra los usuarios del ERP (ACapp), igual que el resto de apps AC:
// mismo usuario y contraseña. El rol dentro de ACsales NO viene del ERP.
const crypto = require("crypto");
const { pool, sembrarUsuario } = require("./db");
const { getPool, sql } = require("./erp-db");

function verificarPasswordAcapp(password, salt, hashGuardado) {
  const hash = crypto
    .createHash("sha512")
    .update(String(password) + String(salt ?? ""))
    .digest("hex")
    .toLowerCase();
  return hash === String(hashGuardado ?? "").toLowerCase();
}

function normalizarUsuario(texto) {
  return String(texto || "").trim().replace(/\s+/g, " ");
}

function normalitzarEmpresaCodi(empresa) {
  let s = String(empresa == null ? "" : empresa).trim();
  if (!s) return null;
  if (/^\d{1,4}$/.test(s)) s = s.padStart(4, "0");
  return s;
}

function normalitzarCodiTreballador(codi) {
  let s = String(codi == null ? "" : codi).trim();
  if (!s) return null;
  if (/^\d{1,4}$/.test(s)) s = s.padStart(4, "0");
  return s;
}

async function buscarUsuarioErp(username, empresa) {
  const login = normalizarUsuario(username);
  const p = await getPool();
  const result = await p.request()
    .input("username", sql.NVarChar, login)
    .input("empresa", sql.VarChar, String(empresa).trim())
    .query(`
      SELECT
        u.id,
        u.username,
        u.password,
        u.salt,
        u.nombre,
        u.email,
        u.empresa,
        LTRIM(RTRIM(CAST(u.Trabajador AS NVARCHAR(50)))) AS codi_treballador,
        LTRIM(RTRIM(t.Nombre)) AS nom_treballador
      FROM dbo.usuarios u
      LEFT JOIN dbo.Trabajadores t
        ON LTRIM(RTRIM(CAST(t.Codigo AS NVARCHAR(50)))) = LTRIM(RTRIM(CAST(u.Trabajador AS NVARCHAR(50))))
       AND t.empresa = u.empresa
      WHERE LOWER(LTRIM(RTRIM(u.username))) = LOWER(@username)
        AND u.empresa = @empresa
        AND u.dbaixa IS NULL
    `);
  return result.recordset[0] || null;
}

function emailPerErp(erpUser) {
  const email = String(erpUser.email || "").trim().toLowerCase();
  if (email) return email;
  return `erp-${erpUser.id}-${erpUser.empresa}@erp.acsales.local`;
}

async function asegurarUsuarioLocal(erpUser) {
  const nombre = String(erpUser.nombre || erpUser.username || "").trim()
    || String(erpUser.username).trim();
  const username = String(erpUser.username).trim();
  let email = emailPerErp(erpUser);

  const codiTr = normalitzarCodiTreballador(erpUser.codi_treballador);
  const empTr = normalitzarEmpresaCodi(erpUser.empresa);
  const nomTr = String(erpUser.nom_treballador || "").trim() || null;

  const { rows: porErp } = await pool.query(
    "SELECT id, activo FROM usuarios WHERE erp_id = $1 AND empresa = $2",
    [erpUser.id, erpUser.empresa]
  );

  let existente = porErp[0];
  if (!existente) {
    const { rows: porUser } = await pool.query(
      `SELECT id, activo FROM usuarios
       WHERE lower(coalesce(username, '')) = lower($1)
         AND (erp_id IS NULL OR (erp_id = $2 AND empresa = $3))
       ORDER BY id LIMIT 1`,
      [username, erpUser.id, erpUser.empresa]
    );
    existente = porUser[0];
  }

  if (existente) {
    if (!existente.activo) return { bloqueado: true };
    try {
      const { rows } = await pool.query(
        `UPDATE usuarios SET username = $1, nombre = $2, email = $3,
                erp_id = $4, empresa = $5,
                codi_treballador = COALESCE($6, codi_treballador),
                empresa_treballador = COALESCE($7, empresa_treballador),
                nom_treballador = COALESCE($8, nom_treballador),
                auth_origen = 'erp'
         WHERE id = $9
         RETURNING id, nombre, username, email, rol, activo,
                   codi_treballador, empresa_treballador, nom_treballador`,
        [username, nombre, email, erpUser.id, erpUser.empresa, codiTr, empTr, nomTr, existente.id]
      );
      return rows[0];
    } catch (e) {
      if (e.code === "23505") {
        email = `erp-${erpUser.id}-${erpUser.empresa}@erp.acsales.local`;
        const { rows } = await pool.query(
          `UPDATE usuarios SET username = $1, nombre = $2, email = $3,
                  erp_id = $4, empresa = $5,
                  codi_treballador = COALESCE($6, codi_treballador),
                  empresa_treballador = COALESCE($7, empresa_treballador),
                  nom_treballador = COALESCE($8, nom_treballador),
                  auth_origen = 'erp'
           WHERE id = $9
           RETURNING id, nombre, username, email, rol, activo,
                     codi_treballador, empresa_treballador, nom_treballador`,
          [username, nombre, email, erpUser.id, erpUser.empresa, codiTr, empTr, nomTr, existente.id]
        );
        return rows[0];
      }
      throw e;
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios
         (nombre, username, email, password_hash, rol, activo, empresa, erp_id, auth_origen,
          codi_treballador, empresa_treballador, nom_treballador)
       VALUES ($1, $2, $3, NULL, 'usuari', TRUE, $4, $5, 'erp', $6, $7, $8)
       RETURNING id, nombre, username, email, rol, activo,
                 codi_treballador, empresa_treballador, nom_treballador`,
      [nombre, username, email, erpUser.empresa, erpUser.id, codiTr, empTr, nomTr]
    );
    await sembrarUsuario(rows[0].id, email);
    return rows[0];
  } catch (e) {
    if (e.code === "23505") {
      email = `erp-${erpUser.id}-${erpUser.empresa}@erp.acsales.local`;
      const { rows } = await pool.query(
        `INSERT INTO usuarios
           (nombre, username, email, password_hash, rol, activo, empresa, erp_id, auth_origen,
            codi_treballador, empresa_treballador, nom_treballador)
         VALUES ($1, $2, $3, NULL, 'usuari', TRUE, $4, $5, 'erp', $6, $7, $8)
         RETURNING id, nombre, username, email, rol, activo,
                   codi_treballador, empresa_treballador, nom_treballador`,
        [nombre, username, email, erpUser.empresa, erpUser.id, codiTr, empTr, nomTr]
      );
      await sembrarUsuario(rows[0].id, email);
      return rows[0];
    }
    throw e;
  }
}

module.exports = {
  verificarPasswordAcapp,
  buscarUsuarioErp,
  asegurarUsuarioLocal,
  normalizarUsuario,
};
