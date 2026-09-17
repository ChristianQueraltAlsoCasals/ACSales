import fs from 'fs';
import { adaptarFilasJob, adaptarFacturasPDF, descripcionesDeFacturasPDF, construirFichasOT, enriquecerFichasConAtributos, materialPropuestoParaOT, compararMaterialOT, normalizarNumeroOT } from './src/agenteInteligente.js';

const archivos = ['Factura_venta_P001723','Factura_venta_P25000028','Factura_venta_P26000432','Factura_venta_P26000549'].map(n => ({
  nombre: n + '.pdf', base64: fs.readFileSync('/mnt/user-data/uploads/' + n + '.pdf').toString('base64')
}));
const resp = await fetch('http://localhost:3000/api/facturas/pdf', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({archivos}) });
const { data: facturas } = await resp.json();
const proyectos = JSON.parse(fs.readFileSync('/mnt/user-data/uploads/proyectos.json','utf8')).data;
const mapa = construirFichasOT(adaptarFilasJob(proyectos), adaptarFacturasPDF(facturas), []);
const descPorOT = descripcionesDeFacturasPDF(facturas);
for (const [clave, descs] of descPorOT) {
  const f = mapa.get(clave); if (!f) continue;
  const act = f.general.descripcion || "";
  const nuevas = descs.filter(d => !act.toLowerCase().includes(d.toLowerCase()));
  if (nuevas.length) f.general.descripcion = act ? act + " · " + nuevas.join(" · ") : nuevas.join(" · ");
}
await enriquecerFichasConAtributos(mapa, { tamanoLote: 500 });

const ficha = mapa.get(normalizarNumeroOT('AC013997/2026'));
const prop = materialPropuestoParaOT(ficha, mapa);
console.log('Material propuesto para OT 13997 (base', prop.baseOTs, 'OTs):');
prop.articulos.forEach(a => console.log(`  ${(a.codigo||'—').padEnd(16)} ${a.descripcion.slice(0,42).padEnd(43)} ${Math.round(a.pct*100)}% · ${a.unidadesPropuestas} ud · ${a.precioMediano}€`));

const f14126 = mapa.get(normalizarNumeroOT('AC014126/2026'));
const comprasSim = [
  { "Nº": "PR000000921836", "Descripción": "Unión Gibault tubo PVC diámetro 90", Cantidad: 2, "Importe línea": 30 },
  { "Nº": "PR000001111111", "Descripción": "Válvula compuerta 2\"", Cantidad: 1, "Importe línea": 55 },
];
const dif = compararMaterialOT(f14126.venta.materiales.lineas, comprasSim);
console.log('\nDiferencias OT 14126: coste sin facturar', Math.round(dif.costeNoFacturado) + '€ (' + dif.nFaltaCobrar + ')', '· venta sin coste', Math.round(dif.ventaSinCoste) + '€ (' + dif.nSinCoste + ')');
dif.items.slice(0,8).forEach(i => console.log(`  [${i.estado.padEnd(17)}] ${i.descripcion.slice(0,42).padEnd(43)} C:${i.udsCompradas}ud/${Math.round(i.costeCompra)}€ V:${i.udsVendidas}ud/${Math.round(i.importeVenta)}€`));
