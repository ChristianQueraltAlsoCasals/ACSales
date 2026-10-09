// Conexión de solo lectura al SQL Server del ERP (ALSOAPP).
const sql = require("mssql");

let pool = null;
let poolPromise = null;

const CONNECT_MS = Math.max(1000, Number(process.env.ERP_MSSQL_CONNECT_TIMEOUT_MS || 2500));
const REQUEST_MS = Math.max(1000, Number(process.env.ERP_MSSQL_REQUEST_TIMEOUT_MS || 3000));

function erpConfigurado() {
  const host = process.env.ERP_MSSQL_HOST;
  const user = process.env.ERP_MSSQL_USER;
  const password = process.env.ERP_MSSQL_PASSWORD;
  return Boolean(host && user && password);
}

function esErrorConectividadErp(err) {
  if (!err) return false;
  const code = String(err.code || err.number || "").toUpperCase();
  const name = String(err.name || "");
  const msg = String(err.message || "");
  if (
    code === "ETIMEOUT"
    || code === "ESOCKETTIMEDOUT"
    || code === "ETIMEDOUT"
    || code === "ECONNREFUSED"
    || code === "ENOTFOUND"
    || code === "EHOSTUNREACH"
    || code === "ENETUNREACH"
    || code === "ECONNRESET"
    || code === "EPIPE"
  ) {
    return true;
  }
  if (name === "ConnectionError" || name === "TimeoutError") return true;
  if (/Failed to connect to|ConnectionError|Connection lost|socket hang up|timeout|timed out|ECONNREFUSED/i.test(msg)) {
    return true;
  }
  return false;
}

function resetPool() {
  const prev = pool;
  const prevP = poolPromise;
  pool = null;
  poolPromise = null;
  if (prev) {
    try { prev.close(); } catch { /* ignore */ }
  }
  if (prevP) prevP.catch(() => {});
}

function getConfig() {
  return {
    server: process.env.ERP_MSSQL_HOST,
    port: parseInt(process.env.ERP_MSSQL_PORT || "1433", 10),
    database: process.env.ERP_MSSQL_DATABASE || "ALSOAPP",
    user: process.env.ERP_MSSQL_USER,
    password: process.env.ERP_MSSQL_PASSWORD,
    options: {
      encrypt: process.env.ERP_MSSQL_ENCRYPT !== "false",
      trustServerCertificate: process.env.ERP_MSSQL_TRUST_SERVER_CERT !== "false",
    },
    connectionTimeout: CONNECT_MS,
    requestTimeout: REQUEST_MS,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

async function getPool() {
  if (!erpConfigurado()) {
    throw new Error("ERP SQL Server no configurado (faltan ERP_MSSQL_HOST, USER o PASSWORD)");
  }
  if (!pool) {
    if (!poolPromise) {
      poolPromise = sql.connect(getConfig()).then((p) => {
        pool = p;
        return p;
      }).catch((e) => {
        poolPromise = null;
        throw e;
      });
    }
    return poolPromise;
  }
  return pool;
}

module.exports = { erpConfigurado, getPool, sql, esErrorConectividadErp, resetPool };
