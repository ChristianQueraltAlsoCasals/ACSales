// Conexión de solo lectura al SQL Server del ERP (ALSOAPP).
const sql = require("mssql");

let pool = null;

function erpConfigurado() {
  const host = process.env.ERP_MSSQL_HOST;
  const user = process.env.ERP_MSSQL_USER;
  const password = process.env.ERP_MSSQL_PASSWORD;
  return Boolean(host && user && password);
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
    connectionTimeout: 20000,
    requestTimeout: 30000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

async function getPool() {
  if (!erpConfigurado()) {
    throw new Error("ERP SQL Server no configurado (faltan ERP_MSSQL_HOST, USER o PASSWORD)");
  }
  if (!pool) {
    pool = await sql.connect(getConfig());
  }
  return pool;
}

module.exports = { erpConfigurado, getPool, sql };
