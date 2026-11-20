(async () => {
  const jwt = require("/app/node_modules/jsonwebtoken");
  const { Pool } = require("/app/node_modules/pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT id FROM usuarios WHERE activo=true ORDER BY id LIMIT 1");
  const token = jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || "clau-nomes-per-desenvolupament", { expiresIn: "10m" });
  await pool.end();

  const r = await fetch("http://127.0.0.1:8102/api/facturas-compra/refrescar-pedido", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `sesion=${token}` },
    body: JSON.stringify({ pedido: "PC26-004202" }),
  });
  const j = await r.json();
  const first = (j.lineasDisponiblesBC || [])[0];
  console.log(JSON.stringify({
    status: r.status,
    importe: j.importe,
    first: first && {
      descripcion: first.descripcion,
      cantidadPedida: first.cantidadPedida,
      precioBC: first.precioBC,
      descuentoPct: first.descuentoPct,
      discountPercent: first.discountPercent,
      importeLinea: first.importeLinea,
      amountExcludingTax: first.amountExcludingTax,
    },
    ok:
      j.importe === 177.05 &&
      first?.descuentoPct === 52 &&
      first?.discountPercent === 52 &&
      first?.importeLinea === 28.53 &&
      first?.amountExcludingTax === 28.53,
  }, null, 2));

  const fs = require("fs");
  const assets = fs.readdirSync("/app/public/assets").filter((f) => f.startsWith("index-") && f.endsWith(".js"));
  const bundle = fs.readFileSync(`/app/public/assets/${assets[0]}`, "utf8");
  console.log("bundle", assets[0]);
  console.log("has dtoPctLineaBc logic marker", bundle.includes("amountExcludingTax"));
  console.log("has discountPercent client", bundle.includes("discountPercent"));
})().catch((e) => { console.error(e); process.exit(1); });
