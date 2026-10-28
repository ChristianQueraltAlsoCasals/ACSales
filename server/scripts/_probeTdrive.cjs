const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const secret = process.env.SSO_SERVICE_SECRET || "";
const palabras = [
  "tdrive", "actdrive", "acdrive", "planificacio", "planificacion", "planning",
  "tareas", "tarea", "on", "desti", "ubicacio", "cuadrante", "quadre",
  "dia", "horari", "assignacio", "colabs", "treballadors", "ausencias",
  "apps", "serveis", "integracio", "integracion", "export", "informe",
  "donde", "donde-esta", "llocs", "jornada", "calendari", "calendario",
];
const hosts = [
  "https://acconstelation.alsocasals.com",
  "https://actdrive.alsocasals.com",
];

(async () => {
  for (const host of hosts) {
    for (const p of palabras) {
      const u = `${host}/api/intern/${p}`;
      const r = await fetch(u, { headers: { "X-AC-Service": secret, Accept: "application/json" } });
      const t = await r.text();
      if (r.status === 200 || !/sessi[oó]|iniciado sesi/i.test(t)) {
        console.log(r.status, host.replace("https://", "").split(".")[0], p, t.slice(0, 100).replace(/\s+/g, " "));
      }
    }
  }
  console.log("fin");
})().catch((e) => { console.error(e); process.exit(1); });
