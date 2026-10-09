const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { pool, sembrarUsuario } = require("./db");
const { erpConfigurado, esErrorConectividadErp, resetPool } = require("./erp-db");
const {
  verificarPasswordAcapp,
  buscarUsuarioErp,
  asegurarUsuarioLocal,
  normalizarUsuario,
} = require("./erp-auth");
const {
  configurat: constellationConfigurat,
  consultarAcces,
  consumirTicket,
  validarCredencial,
  rolDesDeNivell,
} = require("./constellation");
const { resolverEmailEnvio } = require("./achuman-client");

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "clau-nomes-per-desenvolupament";
const COOKIE = "sesion";
const DIAS_SESION = 30;
const EMPRESA_DEFECTE = String(process.env.ERP_EMPRESA_DEFECTE || "0001").trim();

const accesCache = new Map();
const ACCES_CACHE_MS = 60_000;
const emailCache = new Map();
const EMAIL_CACHE_MS = 10 * 60_000;

function crearToken(usuario) {
  return jwt.sign({ id: usuario.id }, SECRET, { expiresIn: `${DIAS_SESION}d` });
}

function ponerCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SEGURA === "true",
    maxAge: DIAS_SESION * 24 * 60 * 60 * 1000,
  });
}

function datosPublicos(u) {
  return {
    id: u.id,
    nombre: u.nom_treballador || u.nombre,
    username: u.username,
    email: u.email,
    email_empresa: u.email_empresa || null,
    email_envio: u.email_envio || u.email_empresa || null,
    rol: u.rol,
    nom_treballador: u.nom_treballador || null,
    codi_treballador: u.codi_treballador || null,
    empresa_treballador: u.empresa_treballador || null,
    portal_rol: u.portal_rol || null,
    portal_super: !!u.portal_super,
  };
}

function aplicarPermisos(usuario, portal) {
  if (!usuario) return usuario;
  if (!portal || portal.omitit || !constellationConfigurat()) {
    return {
      ...usuario,
      portal_rol: usuario.rol === "admin" ? "admin" : "usuari",
      portal_super: false,
    };
  }
  if (!portal.ok) {
    return {
      ...usuario,
      portal_rol: null,
      portal_super: false,
    };
  }
  const portalSuper = !!portal.portal_super;
  const portalRol = portalSuper
    ? "admin"
    : (portal.rol || (portal.nivell === "admin" || portal.nivell === "gestio" ? "admin" : "usuari"));
  return {
    ...usuario,
    portal_rol: portalRol,
    portal_super: portalSuper,
  };
}

async function consultarAccesCache(username) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return { ok: false };
  const hit = accesCache.get(key);
  if (hit && Date.now() - hit.ts < ACCES_CACHE_MS) return hit.portal;
  const portal = await consultarAcces(username);
  accesCache.set(key, { ts: Date.now(), portal });
  return portal;
}

async function enriquecerConPortal(usuario) {
  if (!usuario) return usuario;
  const clau = usuario.username || usuario.email;
  if (!constellationConfigurat()) {
    return aplicarPermisos(usuario, { omitit: true });
  }
  try {
    const portal = await consultarAccesCache(clau);
    let u = usuario;
    const treballador = portal.treballador || portal.usuari?.treballador || null;
    if (portal.ok && portal.acces && treballador && (treballador.codigo || treballador.nom)) {
      const codi = treballador.codigo || null;
      const empresa = treballador.empresa || null;
      const nom = treballador.nom || null;
      const { rows } = await pool.query(
        `UPDATE usuarios SET
           codi_treballador = COALESCE($1, codi_treballador),
           empresa_treballador = COALESCE($2, empresa_treballador),
           nom_treballador = COALESCE($3, nom_treballador)
         WHERE id = $4
         RETURNING id, nombre, username, email, rol, activo,
                   codi_treballador, empresa_treballador, nom_treballador, email_empresa`,
        [codi, empresa, nom, usuario.id]
      );
      if (rows[0]) u = { ...usuario, ...rows[0] };
    }
    return aplicarPermisos(u, portal);
  } catch {
    return aplicarPermisos(usuario, { ok: false });
  }
}

/** Resuelve y cachea email_empresa (AChuman) para envío Graph. */
async function enriquecerConEmailEmpresa(usuario) {
  if (!usuario) return usuario;
  const cacheKey = String(usuario.id || usuario.username || "");
  const hit = emailCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < EMAIL_CACHE_MS) {
    return { ...usuario, email_empresa: hit.email, email_envio: hit.email };
  }

  const r = await resolverEmailEnvio(usuario);
  if (r.email) {
    emailCache.set(cacheKey, { ts: Date.now(), email: r.email });
    try {
      await pool.query(
        `UPDATE usuarios SET email_empresa = $1 WHERE id = $2`,
        [r.email, usuario.id]
      );
    } catch { /* columna puede no existir aún en instancias viejas */ }
    return { ...usuario, email_empresa: r.email, email_envio: r.email };
  }
  return { ...usuario, email_envio: null };
}

async function enriquecerUsuario(usuario) {
  let u = await enriquecerConPortal(usuario);
  u = await enriquecerConEmailEmpresa(u);
  return u;
}

async function exigirAccesPortal(username, res) {
  if (!constellationConfigurat()) return true;
  const r = await consultarAcces(username);
  if (!r.ok) {
    res.status(r.status || 503).json({
      error: r.error || "No se ha podido validar el acceso con ACconstelation",
    });
    return false;
  }
  if (!r.trobat) {
    res.status(403).json({
      error: "Tu usuario no está dado de alta en ACconstelation para ACsales.",
    });
    return false;
  }
  if (!r.actiu || !r.acces) {
    res.status(403).json({
      error: "No tienes permiso en ACconstelation para acceder a ACsales.",
    });
    return false;
  }
  return true;
}

async function asegurarDesdePortal(portalUsuari, nivell) {
  const username = String(portalUsuari?.username || "").trim();
  if (!username) return null;

  const treball = portalUsuari?.treballador || null;
  const codiTr = treball?.codigo || portalUsuari?.codi_treballador || null;
  const empTr = treball?.empresa || portalUsuari?.empresa_treballador || null;
  const nomTr = treball?.nom || portalUsuari?.nom_treballador || null;

  const { rows } = await pool.query(
    `SELECT id, nombre, username, email, rol, activo,
            codi_treballador, empresa_treballador, nom_treballador, email_empresa
     FROM usuarios
     WHERE lower(coalesce(username, '')) = lower($1)
     LIMIT 1`,
    [username]
  );
  if (rows[0]) {
    if (!rows[0].activo) return { bloqueado: true };
    if (codiTr || nomTr) {
      await pool.query(
        `UPDATE usuarios
         SET codi_treballador = COALESCE($1, codi_treballador),
             empresa_treballador = COALESCE($2, empresa_treballador),
             nom_treballador = COALESCE($3, nom_treballador)
         WHERE id = $4`,
        [codiTr, empTr, nomTr, rows[0].id]
      );
      rows[0].codi_treballador = codiTr || rows[0].codi_treballador;
      rows[0].empresa_treballador = empTr || rows[0].empresa_treballador;
      rows[0].nom_treballador = nomTr || rows[0].nom_treballador;
    }
    return rows[0];
  }

  const nombre = String(nomTr || portalUsuari.nom || username).trim();
  const rol = rolDesDeNivell(nivell);
  const email = `${username.replace(/\s+/g, ".").toLowerCase()}@sso.acsales.local`;
  const password_hash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  const { rows: creados } = await pool.query(
    `INSERT INTO usuarios (nombre, username, email, password_hash, rol, activo, auth_origen,
                            codi_treballador, empresa_treballador, nom_treballador)
     VALUES ($1, $2, $3, $4, $5, TRUE, 'sso', $6, $7, $8)
     RETURNING id, nombre, username, email, rol, activo,
               codi_treballador, empresa_treballador, nom_treballador, email_empresa`,
    [nombre, username, email, password_hash, rol, codiTr, empTr, nomTr]
  );
  await sembrarUsuario(creados[0].id, email);
  return creados[0];
}

async function requiereSesion(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: "No has iniciado sesión" });
    const datos = jwt.verify(token, SECRET);
    const { rows } = await pool.query(
      `SELECT id, nombre, username, email, rol, activo,
              codi_treballador, empresa_treballador, nom_treballador, email_empresa
       FROM usuarios WHERE id = $1`,
      [datos.id]
    );
    if (!rows[0] || !rows[0].activo) {
      return res.status(401).json({ error: "Sesión no válida" });
    }
    req.usuario = await enriquecerUsuario(rows[0]);
    next();
  } catch {
    return res.status(401).json({ error: "Sesión caducada, vuelve a entrar" });
  }
}

router.post("/login", async (req, res) => {
  const login = normalizarUsuario(req.body?.usuario);
  const password = String(req.body?.password || "");
  const empresa = String(req.body?.empresa || EMPRESA_DEFECTE).trim();
  if (!login || !password) {
    return res.status(400).json({ error: "Falta el usuario o la contraseña" });
  }
  try {
    let erpCaido = !erpConfigurado();
    if (erpConfigurado()) {
      try {
        const erpUser = await buscarUsuarioErp(login, empresa);
        if (erpUser && verificarPasswordAcapp(password, erpUser.salt, erpUser.password)) {
          const local0 = await asegurarUsuarioLocal(erpUser);
          if (local0?.bloqueado) {
            return res.status(403).json({
              error: "Usuario desactivado en ACsales. Contacta con un administrador.",
            });
          }
          let local = local0;
          if (!(await exigirAccesPortal(local.username, res))) return;
          local = await enriquecerUsuario(local);
          ponerCookie(res, crearToken(local));
          return res.json(datosPublicos(local));
        }
        // ERP ha respondido: no usar cache si la pass no coincide
      } catch (e) {
        console.error("Error consultando el ERP en el login:", e.message);
        if (esErrorConectividadErp(e)) resetPool();
        erpCaido = true;
      }
    }

    if (erpCaido && constellationConfigurat()) {
      const portalCache = await validarCredencial({
        username: login,
        password,
        empresa,
      });
      if (portalCache.ok && portalCache.acces && portalCache.usuari) {
        const local0 = await asegurarDesdePortal(portalCache.usuari, portalCache.nivell);
        if (!local0) {
          return res.status(500).json({ error: "No se ha podido crear la sesión" });
        }
        if (local0.bloqueado) {
          return res.status(403).json({
            error: "Usuario desactivado en ACsales. Contacta con un administrador.",
          });
        }
        let local = await enriquecerUsuario(local0);
        ponerCookie(res, crearToken(local));
        return res.json({ ...datosPublicos(local), modo_degradado: true, erp_disponible: false });
      }
      if (portalCache.ok && !portalCache.acces) {
        return res.status(403).json({
          error: "No tienes acceso a ACsales. Pide acceso en ACconstelation.",
        });
      }
    }

    const { rows } = await pool.query(
      `SELECT * FROM usuarios WHERE activo = TRUE
         AND password_hash IS NOT NULL
         AND (lower(coalesce(username, '')) = lower($1) OR lower(email) = lower($1))`,
      [login]
    );
    const u = rows[0];
    const ok = u && (await bcrypt.compare(password, u.password_hash));
    if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    let uu = u;
    const clauPortal = uu.username || uu.email;
    if (!(await exigirAccesPortal(clauPortal, res))) return;
    uu = await enriquecerUsuario(uu);

    ponerCookie(res, crearToken(uu));
    res.json(datosPublicos(uu));
  } catch (e) {
    console.error("Error en login:", e);
    res.status(500).json({ error: "No se ha podido validar el usuario" });
  }
});

async function manejarSso(req, res) {
  const ticket = String(req.query.ticket || req.body?.ticket || "").trim();
  if (!ticket) {
    if (req.method === "GET") return res.status(400).send("Falta el ticket SSO");
    return res.status(400).json({ error: "Falta el ticket SSO" });
  }
  try {
    const r = await consumirTicket(ticket);
    if (!r.ok) {
      if (req.method === "GET") {
        return res.status(r.status || 403).send(r.error || "Ticket no válido");
      }
      return res.status(r.status || 403).json({ error: r.error || "Ticket no válido" });
    }
    const local0 = await asegurarDesdePortal(r.usuari, r.nivell);
    if (!local0) {
      if (req.method === "GET") return res.status(500).send("No se ha podido crear la sesión");
      return res.status(500).json({ error: "No se ha podido crear la sesión" });
    }
    if (local0.bloqueado) {
      if (req.method === "GET") {
        return res.status(403).send("Usuario desactivado en esta aplicación.");
      }
      return res.status(403).json({ error: "Usuario desactivado en esta aplicación." });
    }
    let local = local0;
    local = await enriquecerUsuario(local);
    ponerCookie(res, crearToken(local));
    if (req.method === "GET") {
      const dest = process.env.SSO_REDIRECT || "/";
      return res.redirect(dest);
    }
    return res.json(datosPublicos(local));
  } catch (e) {
    console.error("Error en SSO:", e);
    if (req.method === "GET") return res.status(500).send("Error en el acceso SSO");
    return res.status(500).json({ error: "Error en el acceso SSO" });
  }
}

router.get("/sso", manejarSso);
router.post("/sso", manejarSso);

router.get("/portal", (_req, res) => {
  const url = String(
    process.env.CONSTELLATION_PUBLIC_URL
      || process.env.CONSTELLATION_URL
      || ""
  ).trim().replace(/\/+$/, "");
  res.json({
    configurat: constellationConfigurat(),
    url: url || null,
    gestio_url: url ? `${url}/gestio/` : null,
  });
});

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get("/me", requiereSesion, async (req, res) => {
  res.json(datosPublicos(req.usuario));
});

module.exports = { router, requiereSesion };
