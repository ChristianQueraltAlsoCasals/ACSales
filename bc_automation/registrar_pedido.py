"""
PRUEBA con pausa de seguridad: abre el pedido (enlace directo, ya
confirmado que funciona), hace clic en "Registrar..." → deja marcado
"Recibir" → y se PARA justo antes de pulsar "Aceptar", para que puedas
comprobar en pantalla que todo está bien antes de que se contabilice de
verdad. Una vez confirmemos que esto va perfecto, se quita la pausa para
dejarlo todo automático (sin pasos sueltos), tal como se pidió.

Requiere haber ejecutado login_setup.py antes al menos una vez.

Uso:
    python registrar_pedido.py PC26-003241
"""

import base64
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")

TENANT_ID = os.environ.get("BC_TENANT_ID", "")
ENVIRONMENT = os.environ.get("BC_ENVIRONMENT", "")
COMPANY_NAME = os.environ.get("BC_COMPANY_NAME", "")
CARPETA_PERFIL = CARPETA / "perfil_navegador"

PAGINA_PEDIDO_COMPRA = 50
CABECERA_BOOKMARK_HEX = "26000000008b01000000027bff"


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
                print("Apareció el diálogo de pausa de BC — pulsando Refresh...")
                boton.click()
                pagina.wait_for_timeout(4000)
            else:
                break
        except Exception:
            break


def main():
    print("[versión script: registrar-automatico-v3-deteccion-error]")
    if len(sys.argv) < 2:
        print("Uso: python registrar_pedido.py PC26-003241")
        sys.exit(1)
    numero_pedido = sys.argv[1]

    if not CARPETA_PERFIL.exists():
        print(f"No encuentro {CARPETA_PERFIL} — ejecuta primero: python login_setup.py")
        sys.exit(1)

    with sync_playwright() as p:
        contexto = p.chromium.launch_persistent_context(
            str(CARPETA_PERFIL),
            channel="msedge",
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )
        pagina = contexto.pages[0] if contexto.pages else contexto.new_page()

        url = url_pedido_directo(numero_pedido)
        print(f"Abriendo directamente: {url}")
        try:
            pagina.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"⚠️ Error navegando (puede ser normal si BC tarda): {e}")
        pagina.wait_for_timeout(4000)
        cerrar_dialogo_pausa(pagina)
        pagina.wait_for_timeout(2000)

        print("Esperando a que termine de cargar la barra de botones...")
        try:
            pagina.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        pagina.wait_for_timeout(5000)

        print(f"La página tiene {len(pagina.frames)} frame(s) — buscando 'Registrar' en todos...")
        marco_con_boton = None
        boton_registrar = None
        for marco in pagina.frames:
            try:
                candidato = marco.get_by_title("(F9)", exact=False).first
                if candidato.is_visible(timeout=3000):
                    marco_con_boton = marco
                    boton_registrar = candidato
                    print(f"  → encontrado en el frame: {marco.url[:80]}")
                    break
            except Exception:
                continue

        print("Abriendo el menú 'Registrar...'...")
        try:
            if boton_registrar is None:
                raise Exception("No encontré el botón 'Registrar' en NINGÚN frame de la página.")
            caja = boton_registrar.bounding_box()
            if not caja:
                raise Exception("No pude obtener la posición del botón Registrar.")
            boton_registrar.click(
                position={"x": caja["width"] - 10, "y": caja["height"] / 2},
                timeout=10000,
                force=True,
            )
            pagina.wait_for_timeout(1000)
            # Del menú desplegable, la PRIMERA opción "Registrar..." (no
            # "Registrar e imprimir" ni las otras variantes) — en el
            # MISMO frame donde encontramos el botón.
            marco_con_boton.get_by_text("Registrar", exact=False).first.click(timeout=10000, force=True)
            pagina.wait_for_timeout(2000)
        except Exception as e:
            print(f"⚠️ No pude abrir el menú Registrar: {e}")
            captura = CARPETA / f"error_registrar_{numero_pedido}.png"
            pagina.screenshot(path=str(captura))
            print(f"Captura del error: {captura}")
            input("Pulsa Enter para cerrar el navegador... ")
            contexto.close()
            return

        print("Marcando la opción 'Recibir'...")
        try:
            encontrado_recibir = False
            for marco in pagina.frames:
                try:
                    candidato = marco.get_by_text("Recibir", exact=True).first
                    if candidato.is_visible(timeout=2000):
                        candidato.click(timeout=5000, force=True)
                        encontrado_recibir = True
                        break
                except Exception:
                    continue
            if not encontrado_recibir:
                print("⚠️ No encontré la opción 'Recibir' en ningún frame.")
            pagina.wait_for_timeout(500)
        except Exception as e:
            print(f"⚠️ No pude marcar 'Recibir': {e}")

        captura = CARPETA / f"antes_de_aceptar_{numero_pedido}.png"
        pagina.screenshot(path=str(captura))
        print(f"📸 Captura guardada: {captura}")
        print("Confirmando (pulsando Aceptar)...")
        try:
            confirmado = False
            for marco in pagina.frames:
                try:
                    candidato = marco.get_by_role("button", name="Aceptar", exact=True).first
                    if candidato.is_visible(timeout=2000):
                        candidato.click(timeout=5000, force=True)
                        confirmado = True
                        break
                except Exception:
                    continue
            if not confirmado:
                print("⚠️ No encontré el botón 'Aceptar' en ningún frame.")
            pagina.wait_for_timeout(5000)

            # Tras confirmar, BC suele mostrar un segundo diálogo
            # ("Enviar documento a") preguntando cómo enviar el
            # documento de confirmación — no lo queremos, así que lo
            # cancelamos automáticamente.
            print("Comprobando si aparece el diálogo 'Enviar documento a'...")
            try:
                for marco in pagina.frames:
                    try:
                        candidato = marco.get_by_role("button", name="Cancelar", exact=True).first
                        if candidato.is_visible(timeout=4000):
                            print("  → apareció 'Enviar documento a' — pulsando Cancelar.")
                            candidato.click(timeout=5000, force=True)
                            pagina.wait_for_timeout(2000)
                            break
                    except Exception:
                        continue
            except Exception:
                pass

            captura_final = CARPETA / f"resultado_registro_{numero_pedido}.png"
            pagina.screenshot(path=str(captura_final))
            print(f"📸 Captura del resultado: {captura_final}")

            # COMPROBACIÓN DE ERROR — si BC no ha podido registrar el
            # pedido (campo obligatorio vacío, etc.), en vez de un pedido
            # normal muestra la pantalla "Mensajes de error" (page=700).
            # Si pasa esto, hay que avisarlo claramente, no dar el
            # registro por bueno sin comprobarlo.
            hubo_error = False
            texto_error = None
            if "page=700" in pagina.url:
                hubo_error = True
            else:
                for marco in pagina.frames:
                    try:
                        if marco.get_by_text("Mensajes de error", exact=False).first.is_visible(timeout=2000):
                            hubo_error = True
                            break
                    except Exception:
                        continue

            if hubo_error:
                # Intentar sacar el texto concreto del error, de la fila
                # resaltada en la lista de "Mensajes de error".
                for marco in pagina.frames:
                    try:
                        filas = marco.locator("[role='gridcell'], td").filter(has_text="línea")
                        if filas.count() > 0:
                            texto_error = filas.first.inner_text(timeout=3000)
                            break
                    except Exception:
                        continue
                print()
                print("=" * 70)
                print("❌ BC NO HA PODIDO REGISTRAR EL PEDIDO — ha dado un error.")
                if texto_error:
                    print(f"   Motivo: {texto_error}")
                else:
                    print("   (no pude extraer el texto exacto — revisa la captura/pantalla)")
                print(f"   Número de pedido: {numero_pedido}")
                print(f"   URL de la pantalla de error: {pagina.url}")
                print("=" * 70)
            else:
                print("✅ Todo parece correcto — revisa igualmente la captura y el pedido en BC.")
        except Exception as e:
            print(f"⚠️ Error al pulsar Aceptar: {e}")

        input("Pulsa Enter para cerrar el navegador... ")
        contexto.close()


if __name__ == "__main__":
    main()
