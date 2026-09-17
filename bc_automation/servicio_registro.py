"""
SERVICIO DE FONDO — arráncalo UNA VEZ y déjalo corriendo mientras
trabajas (como npm start). Abre el navegador y lo deja listo, esperando
peticiones — así cada "Registrar" es rápido, sin volver a abrir el
navegador cada vez.

El backend de Node (server.cjs) le habla a este servicio en
http://localhost:5055 después de subir el Nº de albarán/adjunto/líneas.

NOTA TÉCNICA: Playwright (API síncrona) solo puede usarse desde el MISMO
hilo (thread) donde se creó el navegador. Un servidor web con hilos
(como Flask) rompe esto con un error "greenlet: cannot switch to a
different thread", aunque se proteja con colas o candados — es un fallo
conocido de Playwright, no un despiste de código. Por eso aquí se usa el
servidor HTTP más simple de la librería estándar de Python
(http.server.HTTPServer, SIN ThreadingMixIn), que atiende TODO —
navegador y peticiones— en un único hilo, sin excepciones.

Requiere haber ejecutado login_setup.py antes al menos una vez.

Uso:
    python servicio_registro.py

Deja esta ventana ABIERTA mientras trabajas en Recepción de material.
Para pararlo, Ctrl+C en esta terminal.
"""

import base64
import json
import os
import re
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")

TENANT_ID = os.environ.get("BC_TENANT_ID", "")
ENVIRONMENT = os.environ.get("BC_ENVIRONMENT", "")
COMPANY_NAME = os.environ.get("BC_COMPANY_NAME", "")
CARPETA_PERFIL = CARPETA / "perfil_navegador"
CARPETA_CAPTURAS = CARPETA / "capturas_error"

PAGINA_PEDIDO_COMPRA = 50
CABECERA_BOOKMARK_HEX = "26000000008b01000000027bff"
PUERTO = 5055

# La página del navegador vive en esta variable global — se crea UNA VEZ
# al arrancar (en el hilo principal) y el servidor HTTP (también en el
# hilo principal, sin hilos propios) la usa en cada petición.
_pagina = None


def url_pedido_directo(numero_pedido: str) -> str:
    header = bytes.fromhex(CABECERA_BOOKMARK_HEX)
    texto_utf16 = numero_pedido.encode("utf-16-le")
    data = (header + texto_utf16)[:-1]
    b64 = base64.urlsafe_b64encode(data).decode().rstrip("=")
    bookmark = f"27_{b64}"
    empresa = COMPANY_NAME.replace(" ", "%20")
    return (
        f"https://businesscentral.dynamics.com/{TENANT_ID}/{ENVIRONMENT}/"
        f"?company={empresa}&page={PAGINA_PEDIDO_COMPRA}&bookmark={bookmark}"
    )


def cerrar_dialogo_pausa(pagina):
    for _ in range(3):
        try:
            boton = pagina.get_by_role("button", name="Refresh")
            if boton.is_visible(timeout=4000):
                boton.click()
                pagina.wait_for_timeout(4000)
            else:
                break
        except Exception:
            break


def guardar_captura_error(pagina, numero_pedido: str, etiqueta: str):
    """Guarda un pantallazo del estado del navegador al fallar, para poder
    diagnosticar sin tener que pedir una captura manual cada vez."""
    try:
        CARPETA_CAPTURAS.mkdir(exist_ok=True)
        marca_tiempo = datetime.now().strftime("%Y%m%d_%H%M%S")
        ruta = CARPETA_CAPTURAS / f"{marca_tiempo}_{numero_pedido}_{etiqueta}.png"
        pagina.screenshot(path=str(ruta))
        print(f"[servicio_registro] Captura guardada: {ruta}")
    except Exception as e:
        print(f"[servicio_registro] No pude guardar la captura de error: {e}")


def esperar_elemento(pagina, buscador, tiempo_max_seg=5, intervalo=0.15):
    """Espera activamente (reintentando cada `intervalo` segundos) a que
    `buscador(marco)` devuelva un elemento visible en alguno de los
    frames de la página. Sustituye a los sleeps fijos "por si acaso" —
    solo tarda lo que de verdad haga falta, con un tope de seguridad."""
    fin = time.time() + tiempo_max_seg
    while time.time() < fin:
        for marco in pagina.frames:
            try:
                candidato = buscador(marco)
                if candidato.is_visible(timeout=500):
                    return candidato, marco
            except Exception:
                continue
        pagina.wait_for_timeout(int(intervalo * 1000))
    return None, None


def _buscar_por_titulo(pagina):
    """Estrategia rápida (barata): por el title del tooltip "(F9)"."""
    for marco in pagina.frames:
        try:
            candidato = marco.get_by_title("(F9)", exact=False).first
            if candidato.is_visible(timeout=800):
                return candidato, marco
        except Exception:
            continue
    return None, None


def _buscar_por_role(pagina):
    """Estrategia de respaldo (cara): por el nombre accesible del botón
    (role=button). Calcula el árbol de accesibilidad de cada frame, así
    que es bastante más lenta que la de arriba — solo se usa si la
    rápida falla."""
    for marco in pagina.frames:
        try:
            candidato = marco.get_by_role(
                "button", name=re.compile("registrar", re.IGNORECASE)
            ).first
            if candidato.is_visible(timeout=1500):
                return candidato, marco
        except Exception:
            continue
    return None, None


def buscar_boton_registrar(pagina, tiempo_max_seg: int = 20):
    """Busca el botón 'Registrar...' en todos los frames, con reintentos
    durante tiempo_max_seg segundos (BC puede tardar en pintar el
    ribbon). Prioriza la estrategia rápida (por title) en cada pasada, y
    solo recurre a la lenta (por role) cuando la rápida lleva unos
    segundos sin encontrar nada."""
    inicio = time.time()
    fin = inicio + tiempo_max_seg
    intento = 0
    while time.time() < fin:
        intento += 1
        candidato, marco = _buscar_por_titulo(pagina)
        if candidato is not None:
            print(f"[servicio_registro] Botón encontrado por título en {time.time()-inicio:.1f}s (intento {intento}).")
            return candidato, marco

        # Probamos la estrategia cara pasado 1 segundo (dando un poco de
        # margen a la vía rápida) y luego cada 2 intentos — así, si el
        # title no coincide nunca (pasa a veces), no perdemos casi nada
        # de tiempo esperando su turno.
        if time.time() - inicio > 1 and intento % 2 == 0:
            candidato, marco = _buscar_por_role(pagina)
            if candidato is not None:
                print(f"[servicio_registro] Botón encontrado por role en {time.time()-inicio:.1f}s (intento {intento}).")
                return candidato, marco

        pagina.wait_for_timeout(200)
    return None, None


def registrar_un_pedido(pagina, numero_pedido: str) -> dict:
    t_total = time.time()
    resultado = {"pedido": numero_pedido, "ok": False, "error": None}

    url = url_pedido_directo(numero_pedido)
    try:
        pagina.goto(url, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        resultado["error"] = f"Error navegando: {e}"
        return resultado

    # OJO: no usamos wait_for_load_state("networkidle") — BC es una SPA
    # que sigue haciendo peticiones de fondo (auto-guardado, telemetría),
    # así que casi nunca llega a estar "networkidle" de verdad y el
    # script se tragaba el timeout completo (hasta 20s) en cada registro,
    # SIEMPRE, aunque el botón ya estuviera listo mucho antes.
    #
    # En su lugar: una espera corta fija (lo mínimo para que se pinte el
    # primer frame) y luego vamos directos a comprobar el botón cada
    # 400ms — así, si BC va rápido, el registro también va rápido, y solo
    # se alarga cuando BC de verdad tarda.
    pagina.wait_for_timeout(200)
    cerrar_dialogo_pausa(pagina)

    # Localizar "Registrar..." — buscando en TODOS los frames de la
    # página (con reintentos rápidos), porque BC renderiza el pedido
    # dentro de un iframe y el ribbon puede tardar un poco en pintarse.
    boton_registrar, marco_con_boton = buscar_boton_registrar(pagina, tiempo_max_seg=25)

    if boton_registrar is None:
        guardar_captura_error(pagina, numero_pedido, "sin_boton_registrar")
        print(f"[servicio_registro] DEBUG — {len(pagina.frames)} frame(s) en la página al fallar:")
        for marco in pagina.frames:
            print(f"[servicio_registro] DEBUG —   frame: {marco.url[:120]}")
        resultado["error"] = "No encontré el botón 'Registrar' en ningún frame."
        return resultado

    try:
        # "Registrar..." es un split button de Fluent UI — la flechita
        # está en el borde derecho del mismo botón.
        t0 = time.time()
        caja = boton_registrar.bounding_box()
        boton_registrar.click(
            position={"x": caja["width"] - 10, "y": caja["height"] / 2}, timeout=10000, force=True
        )
        print(f"[servicio_registro] Clic en la flechita: {time.time()-t0:.1f}s")

        # En vez de un sleep fijo "por si acaso", esperamos activamente a
        # que aparezca la opción 'Registrar' del menú desplegable.
        t1 = time.time()
        opcion_registrar, marco_opcion = esperar_elemento(
            pagina, lambda m: m.get_by_text("Registrar", exact=False).first, tiempo_max_seg=5
        )
        if opcion_registrar is None:
            raise Exception("No apareció la opción 'Registrar' del menú.")
        opcion_registrar.click(timeout=10000, force=True)
        print(f"[servicio_registro] Clic en la opción 'Registrar' del menú: {time.time()-t1:.1f}s")
    except Exception as e:
        guardar_captura_error(pagina, numero_pedido, "fallo_abrir_menu_registrar")
        resultado["error"] = f"No pude abrir el menú Registrar: {e}"
        return resultado

    try:
        t2 = time.time()
        opcion_recibir, _ = esperar_elemento(
            pagina, lambda m: m.get_by_text("Recibir", exact=True).first, tiempo_max_seg=5
        )
        if opcion_recibir is None:
            raise Exception("No apareció la opción 'Recibir'.")
        opcion_recibir.click(timeout=5000, force=True)
        print(f"[servicio_registro] Marcar 'Recibir': {time.time()-t2:.1f}s")
    except Exception as e:
        guardar_captura_error(pagina, numero_pedido, "fallo_marcar_recibir")
        resultado["error"] = f"No pude marcar 'Recibir': {e}"
        return resultado

    try:
        t3 = time.time()
        boton_aceptar, _ = esperar_elemento(
            pagina, lambda m: m.get_by_role("button", name="Aceptar", exact=True).first, tiempo_max_seg=5
        )
        if boton_aceptar is None:
            guardar_captura_error(pagina, numero_pedido, "sin_boton_aceptar")
            resultado["error"] = "No encontré el botón 'Aceptar'."
            return resultado
        boton_aceptar.click(timeout=5000, force=True)
        print(f"[servicio_registro] Clic en 'Aceptar': {time.time()-t3:.1f}s")
        # Aquí BC procesa el registro de verdad en el servidor. Recortado
        # de 3s a 1.5s a petición — sigue habiendo margen extra después
        # (el intento de cerrar el diálogo "Enviar documento a" y la
        # comprobación de error, más abajo) antes de dar el registro por
        # bueno, pero si empiezan a aparecer falsos "OK" en pedidos que
        # luego no aparecen registrados en BC, esto es lo primero que
        # habría que devolver a 3000.
        pagina.wait_for_timeout(1500)
    except Exception as e:
        guardar_captura_error(pagina, numero_pedido, "fallo_pulsar_aceptar")
        resultado["error"] = f"Error al pulsar Aceptar: {e}"
        return resultado

    # Diálogo "Enviar documento a" tras confirmar — cancelarlo si aparece
    # (no siempre aparece, así que un tiempo de espera corto y sin fallar
    # si no aparece).
    t4 = time.time()
    boton_cancelar, _ = esperar_elemento(
        pagina, lambda m: m.get_by_role("button", name="Cancelar", exact=True).first,
        tiempo_max_seg=1, intervalo=0.15,
    )
    if boton_cancelar is not None:
        try:
            boton_cancelar.click(timeout=5000, force=True)
            pagina.wait_for_timeout(500)
            print(f"[servicio_registro] Diálogo 'Enviar documento a' cancelado: {time.time()-t4:.1f}s")
        except Exception:
            pass
    else:
        print(f"[servicio_registro] Diálogo 'Enviar documento a' no apareció ({time.time()-t4:.1f}s comprobando).")

    # Comprobación de error: si BC no pudo registrar (campo obligatorio
    # vacío, etc.), redirige a "Mensajes de error" (page=700) en vez de
    # al pedido — hay que detectarlo y avisar, no dar el registro por
    # bueno sin comprobar.
    hubo_error = "page=700" in pagina.url
    if not hubo_error:
        for marco in pagina.frames:
            try:
                if marco.get_by_text("Mensajes de error", exact=False).first.is_visible(timeout=2000):
                    hubo_error = True
                    break
            except Exception:
                continue

    if hubo_error:
        texto_error = None
        for marco in pagina.frames:
            try:
                filas = marco.locator("[role='gridcell'], td").filter(has_text="línea")
                if filas.count() > 0:
                    texto_error = filas.first.inner_text(timeout=3000)
                    break
            except Exception:
                continue
        guardar_captura_error(pagina, numero_pedido, "error_bc_al_registrar")
        resultado["error"] = texto_error or "BC no pudo registrar el pedido (revisa BC directamente)."
        return resultado

    resultado["ok"] = True
    print(f"[servicio_registro] Tiempo total del registro: {time.time()-t_total:.1f}s")
    return resultado


class ManejadorPeticiones(BaseHTTPRequestHandler):
    def _responder(self, codigo, datos):
        cuerpo = json.dumps(datos).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_POST(self):
        if self.path != "/registrar":
            self.send_response(404)
            self.end_headers()
            return
        try:
            longitud = int(self.headers.get("Content-Length", 0))
            cuerpo = self.rfile.read(longitud) if longitud else b"{}"
            datos = json.loads(cuerpo or b"{}")
        except Exception:
            datos = {}
        numero_pedido = (datos.get("numero_pedido") or "").strip()
        if not numero_pedido:
            self._responder(400, {"error": "Falta 'numero_pedido' en el cuerpo de la petición."})
            return

        print(f"[servicio_registro] Registrando {numero_pedido}...")
        try:
            resultado = registrar_un_pedido(_pagina, numero_pedido)
        except Exception as e:
            resultado = {"pedido": numero_pedido, "ok": False, "error": f"Excepción inesperada: {e}"}
        print(f"[servicio_registro] {numero_pedido}: {'OK' if resultado['ok'] else 'ERROR — ' + str(resultado['error'])}")

        self._responder(200 if resultado["ok"] else 500, resultado)

    def do_GET(self):
        if self.path == "/salud":
            self._responder(200, {"estado": "activo"})
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # silenciamos el log por defecto — ya imprimimos lo importante nosotros


def main():
    global _pagina
    if not CARPETA_PERFIL.exists():
        raise SystemExit(f"No encuentro {CARPETA_PERFIL} — ejecuta primero: python login_setup.py")

    print("Arrancando el navegador (una sola vez, puede tardar unos segundos)...")
    with sync_playwright() as playwright:
        # --start-minimized en vez de --start-maximized: sigue siendo un
        # navegador normal (mismo comportamiento con BC, sin riesgos de
        # detección de bot ni renderizado distinto por ir headless), solo
        # que no te salta por encima mientras trabajas en otra ventana.
        contexto = playwright.chromium.launch_persistent_context(
            str(CARPETA_PERFIL),
            channel="msedge",
            headless=False,
            viewport=None,
            args=["--start-minimized"],
        )
        _pagina = contexto.pages[0] if contexto.pages else contexto.new_page()

        servidor = HTTPServer(("127.0.0.1", PUERTO), ManejadorPeticiones)
        print(f"✅ Navegador listo. Sirviendo en http://localhost:{PUERTO}")
        print("Deja esta ventana ABIERTA mientras trabajas en Recepción de material.")
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            print("\nParando el servicio...")
        finally:
            servidor.server_close()
            contexto.close()


if __name__ == "__main__":
    main()
