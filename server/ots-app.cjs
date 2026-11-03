/**
 * Explorador de OTs en caliente contra ALSOAPP (dbo.ot).
 *
 *   GET /api/app/ots          listado paginado + filtros
 *   GET /api/app/ots/meta     valores distintos (estado, tipus, departamento)
 *   GET /api/app/ots/:id      una OT por id App → ficha mínima
 *
 * No sustituye la memoria histórica (IA / material propuesto); solo evita
 * tener que precargar el año entero de Jobs BC para navegar.
 */
const { erpConfigurado, getPool, sql, esErrorConectividadErp } = require("./erp-db");

function empresaAppDesdeBC(nombreEmpresa) {
  const n = String(nombreEmpresa || "").toLowerCase();
  if (n.includes("ferro")) return "0002";
  return "0001";
}

function seriePorEmpresa(emp) {
  return emp === "0002" ? "FCA" : "AC";
}

function limpiar(v) {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ano2De(fila) {
  const a = String(fila.ano ?? fila.anyo ?? "").trim();
  if (/^\d{4}$/.test(a)) return a.slice(-2);
  if (/^\d{1,2}$/.test(a)) return a.padStart(2, "0");
  return null;
}

function codigoBcDe(fila) {
  const serie = limpiar(fila.serie) || seriePorEmpresa(fila.empresa);
  const dig = String(parseInt(String(fila.codigo || fila.numero || "0").replace(/\D/g, ""), 10) || 0);
  if (!dig || dig === "0") return null;
  const a2 = ano2De(fila);
  return a2 ? `${serie}${dig.padStart(6, "0")}/${a2.length === 2 ? `20${a2}` : a2}` : `${serie}${dig.padStart(6, "0")}`;
}

/** Ficha mínima compatible con DetalleOT / codigoOTParaBC. */
function filaAFicha(fila) {
  const codigoBc = codigoBcDe(fila);
  const digitos = String(parseInt(String(fila.codigo || "").replace(/\D/g, ""), 10) || "") || String(fila.id);
  const horas = num(fila.horas);
  const maObra = num(fila.ma_obra);
  const pVenta = num(fila.preu_venta);
  const pDespesa = num(fila.preu_despesa);
  return {
    numeroOT: digitos,
    numeroOTOrigenes: {
      listado: codigoBc,
      listadoOTs: codigoBc,
      appId: fila.id,
    },
    general: {
      cliente: limpiar(fila.cliente_nombre),
      tipoTrabajo: limpiar(fila.tipo_trabajo),
      departamento: limpiar(fila.departamento),
      descripcion: limpiar(fila.descripcion) || limpiar(fila.descripcion_cliente),
      unidadNegocio: limpiar(fila.serie),
      tipoCliente: null,
      segmento: limpiar(fila.c_cost_bc) || limpiar(fila.departamento),
      estado: limpiar(fila.estado),
      estadoApp: limpiar(fila.estado),
      presupuesto: limpiar(fila.presupuesto),
    },
    resumenOT: {
      pVenta,
      pDespesa,
      beneficioNet: num(fila.benefici_net),
      maObra,
      numeroHoras: horas,
    },
    venta: {
      horas: { cantidad: horas, importe: maObra, lineas: [] },
      desplazamiento: { importe: 0, lineas: [], seCobro: false },
      materiales: { importe: 0, lineas: [] },
      otros: { importe: 0, lineas: [] },
      conceptos: [],
      importeTotalFacturado: pVenta,
    },
    compra: {
      costeRealOT: pDespesa,
      comprasReales: { lineas: [], importe: pDespesa },
      ofertas: { lineas: [], importe: 0 },
    },
    avisos: ["Fuente: ALSOAPP (búsqueda en caliente). Pulsa «Cargar líneas desde BC» para venta/compra detalladas."],
    _origenApp: true,
    _appId: fila.id,
  };
}

const SQL_SELECT = `
  SELECT
    o.id,
    o.empresa,
    LTRIM(RTRIM(CAST(o.serie AS VARCHAR(50)))) AS serie,
    LTRIM(RTRIM(CAST(o.codigo AS VARCHAR(50)))) AS codigo,
    o.ano,
    te.nombre AS estado,
    tot.tipus AS tipo_trabajo,
    d.Nombre AS departamento,
    o.descr AS descripcion,
    o.descrClient AS descripcion_cliente,
    o.codigoPTO AS presupuesto,
    LTRIM(RTRIM(o.cCostPir)) AS c_cost_bc,
    cl.razon AS cliente_nombre,
    o.dataCreat,
    o.fModificado,
    COALESCE(o.preuVenta, 0) AS preu_venta,
    COALESCE(o.preuDespessa, 0) AS preu_despesa,
    COALESCE(o.beneficiNet, 0) AS benefici_net,
    COALESCE(o.maobra, 0) AS ma_obra,
    COALESCE(o.tHores, 0) AS horas
  FROM dbo.ot o
  OUTER APPLY (
    SELECT TOP 1 c.razon
    FROM dbo.Clientes c
    WHERE LTRIM(RTRIM(CAST(c.codigo AS VARCHAR(50))))
        = LTRIM(RTRIM(CAST(o.idCliente AS VARCHAR(50))))
      AND c.empresa = o.empresa
    ORDER BY c.id
  ) cl
  LEFT JOIN dbo.tipoestadoot te ON te.id = o.estado AND te.empresa = o.empresa
  LEFT JOIN dbo.TipusOT tot ON tot.id = o.tipus AND tot.empresa = o.empresa
  LEFT JOIN dbo.Departamentos d ON d.id = o.idDepartamento
`;

function aplicarFiltros(req, where, { emp, q, cliente, estado, tipus, departamento, ano, desde, hasta }) {
  where.push("o.empresa = @emp");
  req.input("emp", sql.VarChar(10), emp);

  const qTrim = String(q || "").trim();
  if (qTrim) {
    const dig = qTrim.replace(/\D/g, "");
    if (dig.length >= 3 && /^\d+$/.test(qTrim.replace(/^AC|^FCA/i, "").replace(/[/\s-]/g, ""))) {
      req.input("dig", sql.VarChar(20), dig);
      where.push(`(
        LTRIM(RTRIM(CAST(o.codigo AS VARCHAR(50)))) = @dig
        OR RIGHT('000000' + LTRIM(RTRIM(CAST(o.codigo AS VARCHAR(50)))), 6) = RIGHT('000000' + @dig, 6)
        OR LTRIM(RTRIM(CAST(o.codigo AS VARCHAR(50)))) LIKE '%' + @dig + '%'
        OR LTRIM(RTRIM(CAST(o.codigoPTO AS VARCHAR(50)))) LIKE '%' + @dig + '%'
      )`);
    } else {
      req.input("q", sql.NVarChar(200), `%${qTrim}%`);
      where.push(`(
        o.descr LIKE @q
        OR o.descrClient LIKE @q
        OR cl.razon LIKE @q
        OR LTRIM(RTRIM(CAST(o.codigoPTO AS VARCHAR(50)))) LIKE @q
        OR LTRIM(RTRIM(CAST(o.codigo AS VARCHAR(50)))) LIKE @q
      )`);
    }
  }

  if (cliente) {
    req.input("cliente", sql.NVarChar(200), `%${String(cliente).trim()}%`);
    where.push("cl.razon LIKE @cliente");
  }
  if (estado) {
    req.input("estado", sql.NVarChar(100), String(estado).trim());
    where.push("te.nombre = @estado");
  }
  if (tipus) {
    req.input("tipus", sql.NVarChar(100), String(tipus).trim());
    where.push("tot.tipus = @tipus");
  }
  if (departamento) {
    req.input("depto", sql.NVarChar(100), String(departamento).trim());
    where.push("d.Nombre = @depto");
  }
  if (ano) {
    const a = String(ano).trim();
    const a2 = a.length === 4 ? a.slice(-2) : a;
    req.input("ano2", sql.VarChar(4), a2);
    req.input("ano4", sql.VarChar(4), a.length === 4 ? a : `20${a2}`);
    where.push("(LTRIM(RTRIM(CAST(o.ano AS VARCHAR(10)))) = @ano2 OR LTRIM(RTRIM(CAST(o.ano AS VARCHAR(10)))) = @ano4)");
  }
  if (desde) {
    req.input("desde", sql.Date, new Date(desde));
    where.push("o.dataCreat >= @desde");
  }
  if (hasta) {
    req.input("hasta", sql.Date, new Date(hasta));
    where.push("o.dataCreat < DATEADD(day, 1, @hasta)");
  }
}

module.exports = function montarOtsApp({ app, EMPRESA_NOMBRE }) {
  app.get("/api/app/ots/meta", async (req, res) => {
    if (!erpConfigurado()) {
      return res.status(503).json({ error: "ALSOAPP (ERP_MSSQL_*) no configurado." });
    }
    try {
      const emp = empresaAppDesdeBC(EMPRESA_NOMBRE ? EMPRESA_NOMBRE() : "");
      const pool = await getPool();
      const r = pool.request();
      r.timeout = 20000;
      r.input("emp", sql.VarChar(10), emp);
      const [est, tip, dep] = await Promise.all([
        pool.request().input("emp", sql.VarChar(10), emp).query(`
          SELECT DISTINCT te.nombre AS v
          FROM dbo.ot o
          JOIN dbo.tipoestadoot te ON te.id = o.estado AND te.empresa = o.empresa
          WHERE o.empresa = @emp AND te.nombre IS NOT NULL AND LTRIM(RTRIM(te.nombre)) <> ''
          ORDER BY te.nombre`),
        pool.request().input("emp", sql.VarChar(10), emp).query(`
          SELECT DISTINCT tot.tipus AS v
          FROM dbo.ot o
          JOIN dbo.TipusOT tot ON tot.id = o.tipus AND tot.empresa = o.empresa
          WHERE o.empresa = @emp AND tot.tipus IS NOT NULL AND LTRIM(RTRIM(tot.tipus)) <> ''
          ORDER BY tot.tipus`),
        pool.request().input("emp", sql.VarChar(10), emp).query(`
          SELECT DISTINCT d.Nombre AS v
          FROM dbo.ot o
          JOIN dbo.Departamentos d ON d.id = o.idDepartamento
          WHERE o.empresa = @emp AND d.Nombre IS NOT NULL AND LTRIM(RTRIM(d.Nombre)) <> ''
          ORDER BY d.Nombre`),
      ]);
      res.json({
        empresa_app: emp,
        estados: (est.recordset || []).map((x) => x.v).filter(Boolean),
        tipus: (tip.recordset || []).map((x) => x.v).filter(Boolean),
        departamentos: (dep.recordset || []).map((x) => x.v).filter(Boolean),
      });
    } catch (err) {
      console.error("[app/ots/meta]", err);
      res.status(esErrorConectividadErp(err) ? 503 : 500).json({
        error: esErrorConectividadErp(err) ? "No se pudo conectar a ALSOAPP (¿Tailscale?)." : String(err.message || err),
      });
    }
  });

  app.get("/api/app/ots", async (req, res) => {
    if (!erpConfigurado()) {
      return res.status(503).json({ error: "ALSOAPP (ERP_MSSQL_*) no configurado. Revisa .env y Tailscale." });
    }
    try {
      const emp = empresaAppDesdeBC(EMPRESA_NOMBRE ? EMPRESA_NOMBRE() : "");
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
      const offset = (page - 1) * pageSize;

      const pool = await getPool();
      // Sin filtros: últimos 12 meses (apertura rápida). Con búsqueda, sin tope de fecha.
      const hayBusqueda = Boolean(
        String(req.query.q || "").trim()
        || String(req.query.cliente || "").trim()
        || req.query.estado
        || req.query.tipus
        || req.query.departamento
        || req.query.ano
        || req.query.desde
        || req.query.hasta
      );
      let desde = req.query.desde || null;
      if (!hayBusqueda && !desde) {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 1);
        desde = d.toISOString().slice(0, 10);
      }
      const filtros = {
        emp,
        q: req.query.q,
        cliente: req.query.cliente,
        estado: req.query.estado,
        tipus: req.query.tipus,
        departamento: req.query.departamento,
        ano: req.query.ano,
        desde,
        hasta: req.query.hasta,
      };

      const rCount = pool.request();
      rCount.timeout = 20000;
      const whereCount = [];
      aplicarFiltros(rCount, whereCount, filtros);
      const whereSql = whereCount.length ? `WHERE ${whereCount.join(" AND ")}` : "";

      const countSql = `
        SELECT COUNT_BIG(1) AS n
        FROM dbo.ot o
        OUTER APPLY (
          SELECT TOP 1 c.razon
          FROM dbo.Clientes c
          WHERE LTRIM(RTRIM(CAST(c.codigo AS VARCHAR(50))))
              = LTRIM(RTRIM(CAST(o.idCliente AS VARCHAR(50))))
            AND c.empresa = o.empresa
          ORDER BY c.id
        ) cl
        LEFT JOIN dbo.tipoestadoot te ON te.id = o.estado AND te.empresa = o.empresa
        LEFT JOIN dbo.TipusOT tot ON tot.id = o.tipus AND tot.empresa = o.empresa
        LEFT JOIN dbo.Departamentos d ON d.id = o.idDepartamento
        ${whereSql}`;
      const { recordset: cntRs } = await rCount.query(countSql);
      const total = Number(cntRs?.[0]?.n) || 0;

      const rData = pool.request();
      rData.timeout = 20000;
      const whereData = [];
      aplicarFiltros(rData, whereData, filtros);
      rData.input("offset", sql.Int, offset);
      rData.input("limit", sql.Int, pageSize);
      const dataSql = `
        ${SQL_SELECT}
        ${whereSql}
        ORDER BY o.dataCreat DESC, o.id DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
      const { recordset } = await rData.query(dataSql);
      const items = (recordset || []).map(filaAFicha);

      res.json({
        empresa_app: emp,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        items,
      });
    } catch (err) {
      console.error("[app/ots]", err);
      res.status(esErrorConectividadErp(err) ? 503 : 500).json({
        error: esErrorConectividadErp(err)
          ? "No se pudo conectar a ALSOAPP (¿Tailscale?)."
          : String(err.message || err),
      });
    }
  });

  app.get("/api/app/ots/:id", async (req, res) => {
    if (!erpConfigurado()) {
      return res.status(503).json({ error: "ALSOAPP (ERP_MSSQL_*) no configurado." });
    }
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: "id inválido" });
      const emp = empresaAppDesdeBC(EMPRESA_NOMBRE ? EMPRESA_NOMBRE() : "");
      const pool = await getPool();
      const r = pool.request();
      r.timeout = 15000;
      r.input("id", sql.Int, id);
      r.input("emp", sql.VarChar(10), emp);
      const { recordset } = await r.query(`
        ${SQL_SELECT}
        WHERE o.empresa = @emp AND o.id = @id`);
      const fila = (recordset || [])[0];
      if (!fila) return res.status(404).json({ error: "OT no encontrada" });
      res.json({ ficha: filaAFicha(fila) });
    } catch (err) {
      console.error("[app/ots/:id]", err);
      res.status(esErrorConectividadErp(err) ? 503 : 500).json({
        error: esErrorConectividadErp(err)
          ? "No se pudo conectar a ALSOAPP (¿Tailscale?)."
          : String(err.message || err),
      });
    }
  });
};

module.exports._test = { filaAFicha, codigoBcDe, empresaAppDesdeBC };
