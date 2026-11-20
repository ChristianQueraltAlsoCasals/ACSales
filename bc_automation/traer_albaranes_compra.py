"""
Trae los albaranes de compra a un borrador de factura de compra (ruta rápida).

1) Abre la ficha por deep link (page=51 + Purchase Header No. IS '{factura}').
2) Preferencia ribbon: «Traer líneas de recepción de proveedor»;
   si no, Línea > Acciones > Traer albaranes de compra.
3) Filtra Nº pedido una vez, selecciona filas, Aceptar.
No registra. No cambia pagos. No copia líneas por API.

Usa el perfil de Edge (bc_automation/perfil_navegador).

Uso:
    python traer_albaranes_compra.py PFC26-003647 PC26-004163

La última línea de la salida estándar es JSON.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")

TENANT_ID = os.environ.get("BC_TENANT_ID", "")
ENVIRONMENT = os.environ.get("BC_ENVIRONMENT", "")
COMPANY_NAME = os.environ.get("BC_COMPANY_NAME", "")
CARPETA_PERFIL = CARPETA / "perfil_navegador"
CARPETA_CAPTURAS = CARPETA / "capturas_error"
PAGINA_FACTURA_COMPRA = int(os.environ.get("BC_PAGE_FACTURA_COMPRA", "51"))
PAGINA_LISTA_FACTURAS = int(os.environ.get("BC_PAGE_LISTA_FACTURAS_COMPRA", "9308"))

# SOLO recepción / albaranes de compra. NUNCA «contrato de suscripción».
# El truncado «co…ipción» NO se usa: confunde recepción con suscripción.
ACCION_TRAER = re.compile(
    r"Traer albaranes(?:\s+de)?\s+compra|Get Receipt Lines",
    re.I,
)
ACCION_TRAER_RECEPCION = re.compile(
    r"Traer l[ií]neas de recepci[oó]n(?:\s+de\s+proveedor)?|"
    r"Traer lineas de recepcion(?:\s+de\s+proveedor)?|"
    r"Get Receipt Lines|"
    r"recepci[oó]n de proveedor",
    re.I,
)
ACCION_TRAER_EXCLUIDA = re.compile(
    r"contrato|suscripci|subscription|suscripcion",
    re.I,
)
TITULO_DIALOGO = re.compile(
    r"Traer l[ií]ns\.?\s*albar|Get Receipt Lines|l[ií]neas de recepci|"
    r"Traer l[ií]neas.{0,20}albar|Traer albaranes",
    re.I,
)
TITULO_DIALOGO_MAL = re.compile(r"contrato|suscripci|subscription|suscripcion", re.I)
COL_PEDIDO = re.compile(r"N\.?\s*[º°o]\.?\s*pedido", re.I)
# En el diálogo «Traer líns. albarán» la columna es «Nº documento» (ALBCxx-…).
COL_DOCUMENTO = re.compile(
    r"N\.?\s*[º°o]\.?\s*documento|Document\s*No\.?",
    re.I,
)
COL_ALBARAN = re.compile(r"^N\.?\s*[º°o]\.?\s*albar[aá]n$", re.I)
POPUP_FILTRO = re.compile(
    r"Mostrar solo l[ií]neas donde|Show only (?:rows?|lines?) where",
    re.I,
)
COL_DESCRIPCION = re.compile(r"^Descripci[oó]n$", re.I)
NUM_ALBARAN = re.compile(r"ALBC\d{2}-\d+", re.I)
TOTAL_FACTURA = re.compile(
    r"(?:Importe\s+total|Total\s+IVA\s+incl\.?|Total\s+Amount\s+Incl\.?\s*VAT|Total)\s*[:\s]*([\d.,]+)",
    re.I,
)
TEXTO_LOGIN = ("login.microsoftonline.com", "login.live.com", "login.windows.net")
ROLES_CLICK = ("menuitem", "button", "link", "tab")


def log(mensaje: str) -> None:
    print(mensaje, file=sys.stderr, flush=True)


def liberar_perfil_edge() -> int:
    """Mata Edge que tenga abierto bc_automation/perfil_navegador (lock de Playwright)."""
    import subprocess

    marcador = str(CARPETA_PERFIL).replace("/", "\\").lower()
    matados = 0
    try:
        out = subprocess.check_output(
            ["wmic", "process", "where", "name='msedge.exe'", "get", "ProcessId,CommandLine", "/FORMAT:LIST"],
            text=True,
            errors="ignore",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:
        log(f"No he podido listar Edge ({e}).")
        return 0
    pid = None
    cmd = ""
    for linea in (out or "").splitlines():
        if linea.startswith("CommandLine="):
            cmd = linea[len("CommandLine=") :].strip()
        elif linea.startswith("ProcessId="):
            pid = (linea[len("ProcessId=") :] or "").strip()
            if pid and cmd and marcador in cmd.lower():
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/PID", pid],
                        check=False,
                        capture_output=True,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    matados += 1
                    log(f"Cerrado Edge del perfil (PID {pid}).")
                except Exception as e:
                    log(f"No he podido cerrar PID {pid}: {e}")
            pid = None
            cmd = ""
    if matados:
        time.sleep(1.5)
    return matados


def _url_bc(pagina_id: int, numero_factura: str | None = None) -> str:
    empresa = quote(COMPANY_NAME, safe="")
    base = (
        f"https://businesscentral.dynamics.com/{TENANT_ID}/{ENVIRONMENT}/"
        f"?company={empresa}&page={pagina_id}"
    )
    if numero_factura:
        filtro_q = quote(f"'No.' IS '{numero_factura}'", safe="")
        return f"{base}&filter={filtro_q}"
    return base


def url_lista_facturas_compra() -> str:
    """Lista de facturas de compra sin filtro OData (el filtro se aplica en la columna Nº)."""
    return _url_bc(PAGINA_LISTA_FACTURAS)


def url_ficha_factura_compra(numero_factura: str) -> str:
    """Deep link a la ficha (page=51). Filtro: 'Purchase Header'.'No.' IS 'PFCxx-…'.

    Confirmado por Maria (PFC26-003650). PRIMARY frente a filtrar la lista a mano.
    Bookmark opcional; sin él BC abre la ficha filtrada por Nº. dc=0 evita caché vieja.
    """
    empresa = quote(COMPANY_NAME, safe="")
    filtro_q = quote(f"'Purchase Header'.'No.' IS '{numero_factura}'", safe="")
    return (
        f"https://businesscentral.dynamics.com/{TENANT_ID}/{ENVIRONMENT}/"
        f"?company={empresa}&page={PAGINA_FACTURA_COMPRA}&filter={filtro_q}&dc=0"
    )


def url_factura_compra(numero_factura: str) -> str:
    """Alias del deep link page=51 (ruta rápida del botón verde)."""
    return url_ficha_factura_compra(numero_factura)

def captura(pagina, factura: str, etiqueta: str) -> str | None:
    try:
        CARPETA_CAPTURAS.mkdir(exist_ok=True)
        marca = datetime.now().strftime("%Y%m%d_%H%M%S")
        ruta = CARPETA_CAPTURAS / f"{marca}_{factura}_{etiqueta}.png"
        pagina.screenshot(path=str(ruta))
        log(f"Captura: {ruta}")
        return str(ruta)
    except Exception as e:
        log(f"No he podido guardar la captura ({e}).")
        return None


def maximizar(pagina) -> None:
    """Intenta maximizar una vez. Nunca bloquea el flujo si falla."""
    try:
        cliente = pagina.context.new_cdp_session(pagina)
        info = cliente.send("Browser.getWindowForTarget")
        wid = info["windowId"]
        try:
            cliente.send(
                "Browser.setWindowBounds",
                {"windowId": wid, "bounds": {"windowState": "maximized"}},
            )
        except Exception:
            try:
                cliente.send(
                    "Browser.setWindowBounds",
                    {
                        "windowId": wid,
                        "bounds": {
                            "windowState": "normal",
                            "left": 40,
                            "top": 40,
                            "width": 1400,
                            "height": 900,
                        },
                    },
                )
            except Exception:
                pass
    except Exception:
        pass


def cerrar_dialogo_pausa(pagina) -> None:
    for _ in range(2):
        pulsado = False
        for marco in pagina.frames:
            for nombre in ("Refresh", "Actualizar"):
                try:
                    boton = marco.get_by_role("button", name=nombre)
                    if boton.first.is_visible(timeout=250):
                        boton.first.click()
                        pagina.wait_for_timeout(400)
                        pulsado = True
                        break
                except Exception:
                    continue
            if pulsado:
                break
        if not pulsado:
            return


def es_login(pagina) -> bool:
    try:
        url = pagina.url or ""
    except Exception:
        return False
    return any(trozo in url for trozo in TEXTO_LOGIN)


def esperar_ocupado(pagina, segundos: float = 12) -> None:
    fin = time.time() + segundos
    pagina.wait_for_timeout(150)
    while time.time() < fin:
        ocupado = False
        for marco in pagina.frames:
            for sel in ("[role='progressbar']", ".spa-preload-overlay", "text=/Trabajando|Working on it|Cargando/i"):
                try:
                    if marco.locator(sel).first.is_visible(timeout=120):
                        ocupado = True
                        break
                except Exception:
                    continue
            if ocupado:
                break
        if not ocupado:
            return
        pagina.wait_for_timeout(200)


def _visible(locator, limite: int = 20):
    try:
        n = min(locator.count(), limite)
    except Exception:
        return []
    salida = []
    for i in range(n):
        el = locator.nth(i)
        try:
            if el.is_visible():
                salida.append(el)
        except Exception:
            continue
    return salida


def nombres_visibles(pagina, limite: int = 40) -> list[str]:
    vistos = []
    for marco in pagina.frames:
        for role in ("button", "menuitem", "tab"):
            try:
                loc = marco.get_by_role(role)
                n = min(loc.count(), limite)
            except Exception:
                continue
            for i in range(n):
                try:
                    el = loc.nth(i)
                    if not el.is_visible():
                        continue
                    nombre = (el.inner_text(timeout=400) or "").strip().replace("\n", " ")
                except Exception:
                    continue
                if nombre and nombre not in vistos:
                    vistos.append(nombre[:80])
                if len(vistos) >= limite:
                    return vistos
    return vistos


def buscar(pagina, patron: re.Pattern, roles=ROLES_CLICK, raiz=None):
    ambitos = [raiz] if raiz is not None else list(pagina.frames)
    for ambito in ambitos:
        if ambito is None:
            continue
        for role in roles:
            try:
                loc = ambito.get_by_role(role, name=patron)
            except Exception:
                continue
            for el in _visible(loc, 8):
                return el
        # Fallback: title / aria-label / texto (el ribbon trunca el nombre).
        try:
            candidatos = []
            for sel in (
                "button, [role='button'], [role='menuitem']",
            ):
                try:
                    loc = ambito.locator(sel)
                    n = min(loc.count(), 80)
                except Exception:
                    continue
                for i in range(n):
                    el = loc.nth(i)
                    try:
                        if not el.is_visible():
                            continue
                        texto = " ".join(
                            [
                                el.get_attribute("aria-label") or "",
                                el.get_attribute("title") or "",
                                el.inner_text(timeout=300) or "",
                            ]
                        )
                        texto = " ".join(texto.split())
                    except Exception:
                        continue
                    if not texto or not patron.search(texto):
                        continue
                    candidatos.append(el)
                    break
                if candidatos:
                    return candidatos[0]
        except Exception:
            pass
        try:
            loc = ambito.get_by_text(patron)
            for el in _visible(loc, 6):
                return el
        except Exception:
            pass
    return None


def _click_el(el, etiqueta: str = "") -> bool:
    """Click normal → force → JS. Los overlays de BC interceptan el pointer."""
    try:
        el.scroll_into_view_if_needed(timeout=1200)
    except Exception:
        pass
    try:
        el.click(timeout=2500)
        return True
    except Exception as e1:
        try:
            el.click(timeout=2500, force=True)
            return True
        except Exception as e2:
            try:
                el.evaluate("n => n.click()")
                return True
            except Exception as e3:
                log(f"No he podido pulsar {etiqueta or 'elemento'}: {e1} / {e2} / {e3}")
                return False


def pulsar(pagina, patron: re.Pattern, roles=ROLES_CLICK, raiz=None) -> bool:
    el = buscar(pagina, patron, roles, raiz)
    if el is None:
        return False
    return _click_el(el, patron.pattern)


def esperar_texto(pagina, patron: re.Pattern, segundos: float = 15) -> bool:
    fin = time.time() + segundos
    while time.time() < fin:
        for marco in pagina.frames:
            try:
                if marco.get_by_text(patron).first.is_visible(timeout=300):
                    return True
            except Exception:
                continue
        pagina.wait_for_timeout(300)
    return False


def localizar_dialogo(pagina):
    for marco in pagina.frames:
        try:
            dialogos = marco.get_by_role("dialog")
        except Exception:
            continue
        for el in _visible(dialogos, 6):
            try:
                texto = el.inner_text(timeout=800) or ""
            except Exception:
                continue
            if TITULO_DIALOGO_MAL.search(texto):
                continue
            if TITULO_DIALOGO.search(texto):
                return el
        try:
            titulo = marco.get_by_text(TITULO_DIALOGO).first
            if titulo.is_visible(timeout=300):
                caja = titulo.locator(
                    "xpath=ancestor::*[@role='dialog' or contains(@class,'ms-nav-layout')][1]"
                )
                if caja.count() and caja.first.is_visible():
                    txt = ""
                    try:
                        txt = caja.first.inner_text(timeout=500) or ""
                    except Exception:
                        pass
                    if TITULO_DIALOGO_MAL.search(txt):
                        continue
                    return caja.first
        except Exception:
            continue
    return None


def _cerrar_dialogo_equivocado(pagina) -> bool:
    """Si se abrió «contrato de suscripción», Cancelar y seguir."""
    for marco in pagina.frames:
        try:
            dialogos = marco.get_by_role("dialog")
        except Exception:
            continue
        for el in _visible(dialogos, 4):
            try:
                texto = el.inner_text(timeout=600) or ""
            except Exception:
                continue
            if not TITULO_DIALOGO_MAL.search(texto):
                continue
            log("Se ha abierto el diálogo de contrato/suscripción (no es Traer albaranes). Lo cierro.")
            if pulsar(pagina, re.compile(r"^Cancelar$|^Close$|^Cerrar$"), ("button",), el):
                pagina.wait_for_timeout(300)
                return True
            try:
                pagina.keyboard.press("Escape")
            except Exception:
                pass
            pagina.wait_for_timeout(300)
            return True
    return False


def pagina_muestra_factura(pagina, numero_factura: str) -> bool:
    for marco in pagina.frames:
        try:
            if marco.get_by_text(numero_factura, exact=True).first.is_visible(timeout=400):
                return True
        except Exception:
            continue
        try:
            if marco.get_by_text(re.compile(rf"^{re.escape(numero_factura)}\b")).first.is_visible(timeout=300):
                return True
        except Exception:
            continue
    return False


def en_role_center(pagina) -> bool:
    """Inicio de BC (mosaicos), no la ficha de factura."""
    patron = re.compile(r"Informaci[oó]n sobre la [uú]ltima semana|^Actividades$", re.I)
    for marco in pagina.frames:
        try:
            if marco.get_by_text(patron).first.is_visible(timeout=300):
                return True
        except Exception:
            continue
    return False


def en_ficha(pagina, numero_factura: str) -> bool:
    """La ficha de ESA factura, no el Role Center ni un documento en blanco."""
    if en_role_center(pagina):
        return False
    if not pagina_muestra_factura(pagina, numero_factura):
        return False
    if buscar(pagina, re.compile(r"^Borrar l[ií]nea$|^Eliminar l[ií]nea$"), ("button", "menuitem")) is not None:
        return True
    if _buscar_boton_traer_ribbon(pagina) is not None:
        return True
    if buscar(pagina, re.compile(r"^Factura compra$|^Purchase Invoice$"), ("heading", "button", "tab")) is not None:
        return True
    return False


def salir_de_ficha_en_blanco(pagina, numero_factura: str) -> None:
    """La ficha (page 51) sin filtro abre un documento nuevo. No se rellena."""
    if pagina_muestra_factura(pagina, numero_factura):
        return
    if buscar(pagina, re.compile(r"^Borrar l[ií]nea$"), ("button", "menuitem")) is None:
        return
    try:
        pagina.keyboard.press("Escape")
    except Exception:
        pass
    pagina.wait_for_timeout(400)
    pulsar(pagina, re.compile(r"^No$|^Cancelar$|^Descartar$"), ("button",))


def cerrar_globos(pagina) -> None:
    """Cierra avisos (Novedades de PDF) y el menú de Compras si tapan la fila."""
    for _ in range(3):
        cerrado = False
        for marco in pagina.frames:
            try:
                botones = marco.locator(
                    "button[aria-label='Cerrar'], button[aria-label='Close'], button[title='Cerrar']"
                )
            except Exception:
                continue
            for el in _visible(botones, 4):
                try:
                    el.click(timeout=800)
                    cerrado = True
                except Exception:
                    continue
        if not cerrado:
            break
        pagina.wait_for_timeout(250)
    if buscar(pagina, re.compile(r"^Borrar l[ií]nea$"), ("button", "menuitem")) is not None:
        return
    menu_abierto = buscar(pagina, re.compile(r"Facturas compra|Pedidos compra"), ("menuitem",)) is not None
    aviso_pdf = False
    for marco in pagina.frames:
        try:
            if marco.get_by_text(re.compile(r"Novedades de PDF")).first.is_visible(timeout=200):
                aviso_pdf = True
                break
        except Exception:
            continue
    if menu_abierto or aviso_pdf:
        try:
            pagina.keyboard.press("Escape")
        except Exception:
            pass
        pagina.wait_for_timeout(200)


def elemento_numero(pagina, numero: str):
    patron = re.compile(rf"^{re.escape(numero)}$")
    for marco in pagina.frames:
        for role in ("link", "gridcell"):
            try:
                loc = marco.get_by_role(role, name=patron)
            except Exception:
                continue
            visibles = _visible(loc, 4)
            if visibles:
                return visibles[0]
        try:
            loc = marco.get_by_text(numero, exact=True)
        except Exception:
            continue
        visibles = _visible(loc, 4)
        if visibles:
            return visibles[0]
    return None


def abrir_documento_desde_lista(pagina, numero: str) -> bool:
    """La fila ya está en la lista. Un clic solo la selecciona; Enter abre la ficha."""
    cerrar_globos(pagina)
    el = elemento_numero(pagina, numero)
    if el is None:
        return False
    log(f"La lista muestra {numero}. Abro esa ficha.")
    try:
        el.click(timeout=3000)
    except Exception as e:
        log(f"No he podido seleccionar {numero} ({e}).")
        return False
    pagina.wait_for_timeout(300)
    try:
        pagina.keyboard.press("Enter")
    except Exception:
        pass
    esperar_ocupado(pagina, 15)
    if en_ficha(pagina, numero):
        return True
    el = elemento_numero(pagina, numero)
    if el is not None:
        try:
            el.dblclick(timeout=3000)
        except Exception as e:
            log(f"Doble clic en {numero} no ha abierto la ficha ({e}).")
        esperar_ocupado(pagina, 12)
        if en_ficha(pagina, numero):
            return True
    if pulsar(pagina, re.compile(r"^Administrar$"), ("button", "menuitem")):
        pagina.wait_for_timeout(300)
    if pulsar(pagina, re.compile(r"^Editar$|^Ver$"), ("button", "menuitem")):
        esperar_ocupado(pagina, 12)
    return en_ficha(pagina, numero)


COL_NUMERO_LISTA = re.compile(r"^(Nº|N\.º|No\.|N\.)$", re.I)


def columna_numero_lista(pagina):
    for marco in pagina.frames:
        try:
            headers = marco.get_by_role("columnheader")
            n = min(headers.count(), 30)
        except Exception:
            continue
        for i in range(n):
            h = headers.nth(i)
            try:
                if not h.is_visible():
                    continue
                texto = " ".join((h.inner_text(timeout=400) or "").split())
            except Exception:
                continue
            if COL_NUMERO_LISTA.match(texto):
                return h
    return None


def valor_foco(pagina) -> str:
    for marco in pagina.frames:
        try:
            valor = marco.evaluate(
                "() => { const el = document.activeElement; if (!el) return ''; "
                "return String(el.value != null ? el.value : (el.innerText || '')).trim(); }"
            )
        except Exception:
            continue
        if valor is not None and str(valor).strip() != "":
            return str(valor).strip()
    return ""


def _abrir_menu_filtro_numero(pagina) -> bool:
    header = columna_numero_lista(pagina)
    if header is None:
        log("No veo la columna Nº en la lista de facturas de compra.")
        return False
    try:
        botones = header.locator("button")
        if botones.count():
            botones.last.click(timeout=3000)
        else:
            header.click(timeout=3000)
    except Exception as e:
        log(f"No he podido abrir el menú de Nº ({e}).")
        return False
    pagina.wait_for_timeout(350)
    return True


def _limpiar_campo_filtro(pagina) -> None:
    """Vacía el input del filtro (Ctrl+A + Delete + Backspace). Sin teclear el nº todavía."""
    try:
        pagina.keyboard.press("Control+A")
        pagina.wait_for_timeout(60)
        pagina.keyboard.press("Delete")
        pagina.wait_for_timeout(60)
        pagina.keyboard.press("Backspace")
        pagina.wait_for_timeout(60)
    except Exception:
        pass
    # Si BC dejó restos, borrar carácter a carácter.
    for _ in range(40):
        actual = valor_foco(pagina)
        if not actual:
            break
        try:
            pagina.keyboard.press("Backspace")
        except Exception:
            break
        pagina.wait_for_timeout(20)


def _forzar_valor_activo(pagina, numero: str) -> None:
    script = """(t) => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        if ('value' in el) {
            el.value = t;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        el.textContent = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }"""
    ok = False
    for marco in pagina.frames:
        try:
            if marco.evaluate(script, numero):
                ok = True
                break
        except Exception:
            continue
    if not ok:
        try:
            pagina.evaluate(script, numero)
        except Exception as e:
            log(f"No he podido forzar el valor del filtro ({e}).")


def _escribir_numero_filtro(pagina, numero: str) -> bool:
    """Escribe el nº completo de una vez (sin autocomplete por tecla). Verifica el valor."""
    _limpiar_campo_filtro(pagina)
    if valor_foco(pagina):
        log(f"No he podido vaciar el filtro (sigue «{valor_foco(pagina)}»).")
        return False
    # insert_text evita el autocompletado tecla a tecla que sustituía PFC26-003650 → PFC26-000291.
    try:
        pagina.keyboard.insert_text(numero)
    except Exception:
        try:
            _forzar_valor_activo(pagina, numero)
        except Exception as e:
            log(f"No he podido escribir el nº {numero} ({e}).")
            return False
    pagina.wait_for_timeout(180)
    escrito = valor_foco(pagina)
    if escrito != numero:
        log(f"Primer intento dejó «{escrito}»; fuerzo el nº completo y descarto sugerencias.")
        _limpiar_campo_filtro(pagina)
        _forzar_valor_activo(pagina, numero)
        pagina.wait_for_timeout(120)
        # Cierra sugerencias sin vaciar: flecha arriba + no elegir fila sugerida.
        try:
            pagina.keyboard.press("ArrowUp")
            pagina.wait_for_timeout(40)
        except Exception:
            pass
        escrito = valor_foco(pagina)
        if escrito != numero:
            _limpiar_campo_filtro(pagina)
            try:
                pagina.keyboard.insert_text(numero)
            except Exception:
                _forzar_valor_activo(pagina, numero)
            pagina.wait_for_timeout(120)
            escrito = valor_foco(pagina)
    if escrito != numero:
        log(f"El filtro ha quedado en «{escrito}», no en {numero}. No lo aplico.")
        return False
    log(f"Filtro Nº verificado en el campo: {escrito}")
    return True


def filtrar_columna_numero(pagina, numero: str) -> bool:
    """Columna Nº, valor igual (=) al número completo. No usa Tell Me ni el buscador general."""
    numero = (numero or "").strip()
    if not numero:
        return False
    if buscar(pagina, re.compile(r"^Borrar l[ií]nea$"), ("button", "menuitem")) is not None:
        return False
    if not _abrir_menu_filtro_numero(pagina):
        return False
    # Quitar filtro previo de la columna si existe (evita restos / sugerencias viejas).
    if pulsar(
        pagina,
        re.compile(r"^Borrar filtro$|^Quitar filtro$|^Clear filter$|^Clear Filter$"),
        ("menuitem", "button"),
    ):
        esperar_ocupado(pagina, 8)
        pagina.wait_for_timeout(300)
        if not _abrir_menu_filtro_numero(pagina):
            return False
    if not pulsar(
        pagina,
        re.compile(r"^Filtro\.{0,3}$|^Filtrar\.{0,3}$|^Filter$"),
        ("menuitem", "button"),
    ):
        log("No he encontrado la opción Filtro en la columna Nº.")
        try:
            pagina.keyboard.press("Escape")
        except Exception:
            pass
        return False
    pagina.wait_for_timeout(350)
    # Preferir «es igual a» / equals si el menú de operador está visible.
    pulsar(
        pagina,
        re.compile(r"^es igual a$|^Igual a$|^Equals$|^=$"),
        ("menuitem", "option", "button"),
    )
    pagina.wait_for_timeout(200)
    if not _escribir_numero_filtro(pagina, numero):
        try:
            pagina.keyboard.press("Escape")
            pagina.wait_for_timeout(100)
            pagina.keyboard.press("Escape")
        except Exception:
            pass
        return False
    try:
        pagina.keyboard.press("Enter")
    except Exception as e:
        log(f"No he podido aplicar el filtro de Nº ({e}).")
        return False
    esperar_ocupado(pagina, 12)
    if not pagina_muestra_factura(pagina, numero):
        log(f"Tras filtrar Nº = {numero} no aparece la fila en la lista.")
        return False
    log(f"Filtro de la columna Nº = {numero}")
    return True


def actualizar_lista(pagina) -> None:
    if not pulsar(pagina, re.compile(r"^Actualizar$"), ("button",)):
        try:
            pagina.keyboard.press("F5")
        except Exception:
            pass
    esperar_ocupado(pagina, 12)


def _esperar_ficha(pagina, numero: str, segundos: float = 10) -> bool:
    fin = time.time() + segundos
    while time.time() < fin:
        if es_login(pagina):
            return False
        if en_role_center(pagina):
            pagina.wait_for_timeout(250)
            continue
        if en_ficha(pagina, numero):
            return True
        pagina.wait_for_timeout(250)
    return en_ficha(pagina, numero)


def abrir_factura(pagina, numero_factura: str) -> dict:
    """PRIMARY: deep link page=51 + Purchase Header No. IS. Sin teclear filtro de lista."""
    numero = (numero_factura or "").strip()
    if not TENANT_ID or not ENVIRONMENT or not COMPANY_NAME:
        return {"ok": False, "error": "Faltan BC_TENANT_ID, BC_ENVIRONMENT o BC_COMPANY_NAME en .env."}
    if not numero:
        return {"ok": False, "error": "Falta el nº de factura."}

    url = url_ficha_factura_compra(numero)
    log(f"Abriendo {numero} por enlace directo (page={PAGINA_FACTURA_COMPRA}).")
    try:
        pagina.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception as e:
        log(f"La navegación ha tardado ({e}). Sigo esperando la ficha.")
    try:
        pagina.bring_to_front()
    except Exception:
        pass
    maximizar(pagina)
    pagina.wait_for_timeout(200)
    cerrar_dialogo_pausa(pagina)
    cerrar_globos(pagina)

    if es_login(pagina):
        return {
            "ok": False,
            "error": (
                "La sesión de Business Central del perfil ha caducado. "
                "Ejecuta python bc_automation/login_setup.py e inicia sesión. "
                "El script no escribe la contraseña."
            ),
        }

    if _esperar_ficha(pagina, numero, 15):
        if not en_role_center(pagina):
            return {"ok": True, "via": "deep_link"}

    # Un solo reintento del mismo deep link (sin filtrar la lista a mano).
    log(f"La ficha de {numero} aún no está lista (¿Role Center?). Reabro el enlace directo.")
    try:
        pagina.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception:
        pass
    esperar_ocupado(pagina, 10)
    cerrar_dialogo_pausa(pagina)
    cerrar_globos(pagina)
    _cerrar_menus_ui(pagina)
    if es_login(pagina):
        return {
            "ok": False,
            "error": (
                "La sesión de Business Central del perfil ha caducado. "
                "Ejecuta python bc_automation/login_setup.py e inicia sesión."
            ),
        }
    if _esperar_ficha(pagina, numero, 15) and not en_role_center(pagina):
        return {"ok": True, "via": "deep_link_reintento"}

    if pagina_muestra_factura(pagina, numero) and not en_role_center(pagina):
        return {
            "ok": False,
            "error": f"BC muestra {numero} pero no la ficha editable (Líneas). Revisa la ventana de Edge.",
            "controles": nombres_visibles(pagina),
            "url": url,
        }
    return {
        "ok": False,
        "error": (
            f"No ha aparecido la ficha de {numero} con el enlace directo"
            + (" (BC se ha quedado en el inicio)." if en_role_center(pagina) else ".")
        ),
        "controles": nombres_visibles(pagina),
        "url": url,
    }


def abrir_facturas_en_curso(pagina) -> bool:
    """Mosaico del inicio: facturas de compra abiertas. No crea un documento."""
    patron = re.compile(r"Facturas de co[\s\S]{0,40}en curso", re.I)
    if pulsar(pagina, patron, ("link", "button", "tab", "menuitem")):
        esperar_ocupado(pagina, 10)
        return True
    for marco in pagina.frames:
        try:
            el = marco.get_by_text(re.compile(r"en curso", re.I)).first
            if not el.is_visible(timeout=400):
                continue
            texto = el.inner_text(timeout=400) or ""
            if "Facturas de co" not in texto and "factura" not in texto.lower():
                continue
            el.click()
            esperar_ocupado(pagina, 10)
            return True
        except Exception:
            continue
    return False


def abrir_lista_compras(pagina) -> bool:
    """Lista de facturas de compra. No usa la acción que abre un documento nuevo."""
    if not pulsar(pagina, re.compile(r"^Compras\b"), ("button", "link", "tab", "menuitem")):
        return False
    pagina.wait_for_timeout(500)
    return pulsar(pagina, re.compile(r"^Facturas de compra$"), ("menuitem", "link", "button"))


def asegurar_fasttab_lineas(pagina) -> None:
    for marco in pagina.frames:
        try:
            botones = marco.get_by_role("button", name=re.compile(r"^L[ií]neas$"))
        except Exception:
            continue
        for el in _visible(botones, 6):
            try:
                expandido = el.get_attribute("aria-expanded")
            except Exception:
                expandido = None
            if expandido == "false":
                try:
                    el.click()
                    pagina.wait_for_timeout(400)
                except Exception:
                    pass
            try:
                el.scroll_into_view_if_needed(timeout=2000)
            except Exception:
                pass
            return


def rejilla_lineas(pagina, raiz=None):
    ambitos = [raiz] if raiz is not None else list(pagina.frames)
    mejor = None
    for ambito in ambitos:
        if ambito is None:
            continue
        try:
            grids = ambito.get_by_role("grid")
        except Exception:
            try:
                grids = ambito.locator("[role='grid'], [role='treegrid']")
            except Exception:
                continue
        for grid in _visible(grids, 8):
            try:
                texto = grid.inner_text(timeout=800) or ""
            except Exception:
                continue
            if COL_DESCRIPCION.search(texto) or "Descripci" in texto:
                if COL_ALBARAN.search(texto) or "albar" in texto.lower():
                    return grid
                mejor = mejor or grid
    return mejor


def _cabeceras(grid) -> list[str]:
    try:
        loc = grid.get_by_role("columnheader")
        n = min(loc.count(), 40)
    except Exception:
        return []
    nombres = []
    for i in range(n):
        try:
            nombres.append((loc.nth(i).inner_text(timeout=500) or "").strip().replace("\n", " "))
        except Exception:
            nombres.append("")
    return nombres


def _indice(cabeceras: list[str], patron: re.Pattern) -> int | None:
    for i, nombre in enumerate(cabeceras):
        if patron.search(nombre or ""):
            return i
    return None


def _celdas(fila) -> list[str]:
    try:
        loc = fila.get_by_role("gridcell")
        n = min(loc.count(), 40)
    except Exception:
        return []
    textos = []
    for i in range(n):
        try:
            textos.append((loc.nth(i).inner_text(timeout=400) or "").strip().replace("\n", " "))
        except Exception:
            textos.append("")
    return textos


def filas_datos(grid):
    try:
        loc = grid.get_by_role("row")
        n = min(loc.count(), 40)
    except Exception:
        return []
    filas = []
    for i in range(n):
        fila = loc.nth(i)
        try:
            if not fila.is_visible():
                continue
            celdas = _celdas(fila)
        except Exception:
            continue
        if any(celdas):
            filas.append((fila, celdas))
    return filas


def fila_copiada_sin_albaran(pagina):
    """Línea con descripción y sin Nº albarán. La fila en blanco de BC se queda."""
    grid = rejilla_lineas(pagina)
    if grid is None:
        return None
    cabeceras = _cabeceras(grid)
    i_desc = _indice(cabeceras, COL_DESCRIPCION)
    i_alb = _indice(cabeceras, COL_ALBARAN)
    for fila, celdas in filas_datos(grid):
        texto = " ".join(celdas)
        if NUM_ALBARAN.search(texto):
            continue
        descripcion = celdas[i_desc] if i_desc is not None and i_desc < len(celdas) else ""
        if not descripcion:
            descripcion = next((c for c in celdas if len(c) > 3 and not re.fullmatch(r"[\d.,]+", c)), "")
        if not descripcion or re.fullmatch(r"(Art[ií]culo|Cuenta|Cargo|Recurso|Item|Account)", descripcion, re.I):
            continue
        if i_alb is not None and i_alb < len(celdas) and celdas[i_alb].strip():
            continue
        return fila
    return None


def confirmar_si_pregunta_borrar(pagina) -> None:
    pagina.wait_for_timeout(400)
    for marco in pagina.frames:
        try:
            dialogos = marco.get_by_role("dialog")
        except Exception:
            continue
        for el in _visible(dialogos, 4):
            try:
                texto = el.inner_text(timeout=600) or ""
            except Exception:
                continue
            if TITULO_DIALOGO.search(texto):
                continue
            if re.search(r"Registrar|Recibir y facturar|Contabilizar", texto, re.I):
                pulsar(pagina, re.compile(r"^Cancelar$"), raiz=el)
                continue
            if not re.search(r"eliminar|borrar", texto, re.I):
                continue
            boton = buscar(pagina, re.compile(r"^S[ií]$|^Eliminar$|^Aceptar$"), ("button",), el)
            if boton is not None:
                try:
                    boton.click()
                except Exception:
                    pass
                return


def borrar_lineas_copiadas(pagina, factura: str) -> int:
    borradas = 0
    for _ in range(30):
        asegurar_fasttab_lineas(pagina)
        fila = fila_copiada_sin_albaran(pagina)
        if fila is None:
            break
        try:
            fila.click(timeout=3000)
        except Exception as e:
            log(f"No he podido seleccionar la línea copiada ({e}).")
            break
        pagina.wait_for_timeout(250)
        borrada = pulsar(pagina, re.compile(r"^Eliminar l[ií]nea$|^Borrar l[ií]nea$"), ("menuitem", "button"))
        if not borrada:
            pulsar(pagina, re.compile(r"^L[ií]nea$"), ("button", "menuitem"))
            pagina.wait_for_timeout(300)
            borrada = pulsar(pagina, re.compile(r"Eliminar l[ií]nea|Borrar l[ií]nea"), ("menuitem", "button"))
        if not borrada:
            try:
                pagina.keyboard.press("Control+Delete")
                borrada = True
            except Exception:
                break
        confirmar_si_pregunta_borrar(pagina)
        esperar_ocupado(pagina, 10)
        borradas += 1
        log(f"Línea copiada quitada ({borradas}).")
    if borradas:
        captura(pagina, factura, "lineas_copiadas_quitadas")
    return borradas


def enfocar_lineas(pagina) -> None:
    asegurar_fasttab_lineas(pagina)
    grid = rejilla_lineas(pagina)
    if grid is None:
        return
    try:
        grid.click(timeout=2000)
    except Exception:
        pass
    fila = fila_copiada_sin_albaran(pagina)
    if fila is not None:
        try:
            fila.click(timeout=2000)
            return
        except Exception:
            pass
    for _, _celdas_fila in filas_datos(grid)[:1]:
        pass
    try:
        celdas = grid.get_by_role("gridcell")
        if celdas.count():
            celdas.first.click(timeout=2000)
    except Exception:
        pass


def _hay_overlay_bloqueante(pagina) -> bool:
    for marco in pagina.frames:
        try:
            if marco.locator(
                ".overlay-transparent, .ms-nav-ctxmenu-container, .popup-menu.ms-nav-ctxmenu-container"
            ).count():
                return True
        except Exception:
            continue
    return False


def _cerrar_menus_ui(pagina) -> None:
    """Quita overlay/ctxmenu SIN spamear Escape (Escape cierra la ficha y vuelve al inicio)."""
    # Primero intenta quitar overlays por DOM (no pierde la ficha).
    for marco in pagina.frames:
        try:
            marco.evaluate(
                """() => {
                    for (const sel of [
                        '.overlay-transparent',
                        '.ms-nav-ctxmenu-container',
                        '.popup-menu.ms-nav-ctxmenu-container',
                        '[class*="overlay-transparent"]',
                    ]) {
                        document.querySelectorAll(sel).forEach((n) => {
                            try { n.style.pointerEvents = 'none'; n.style.display = 'none'; n.remove(); } catch (e) {}
                        });
                    }
                }"""
            )
        except Exception:
            continue
    # Un solo Escape si aún hay menú de contexto (no 4: eso cierra page=51).
    if _hay_overlay_bloqueante(pagina):
        try:
            pagina.keyboard.press("Escape")
        except Exception:
            pass
        pagina.wait_for_timeout(150)
        for marco in pagina.frames:
            try:
                marco.evaluate(
                    """() => {
                        document.querySelectorAll('.overlay-transparent, .ms-nav-ctxmenu-container').forEach((n) => {
                            try { n.remove(); } catch (e) {}
                        });
                    }"""
                )
            except Exception:
                continue
    pagina.wait_for_timeout(80)


def _texto_control(el) -> str:
    try:
        return " ".join(
            [
                el.get_attribute("aria-label") or "",
                el.get_attribute("title") or "",
                el.inner_text(timeout=300) or "",
            ]
        )
    except Exception:
        return ""


def _es_accion_traer_recepcion(texto: str) -> bool:
    """Solo recepción/albaranes. Rechaza contrato/suscripción aunque el texto esté truncado."""
    t = " ".join((texto or "").split())
    if not t or ACCION_TRAER_EXCLUIDA.search(t):
        return False
    # Debe llevar recepción/albarán/Receipt — no basta «Traer líneas … proveedor».
    if not re.search(r"recepci[oó]n|albar[aá]n|Receipt Lines", t, re.I):
        return False
    return bool(ACCION_TRAER_RECEPCION.search(t) or ACCION_TRAER.search(t) or re.search(r"albaranes", t, re.I))


def _buscar_boton_traer_ribbon(pagina):
    """Ribbon «Traer líneas de recepción…» por aria-label completo. Nunca suscripción."""
    for marco in pagina.frames:
        for sel in (
            "[aria-label*='recepción' i]",
            "[aria-label*='recepcion' i]",
            "[aria-label*='Receipt Lines' i]",
            "[title*='recepción' i]",
            "[title*='recepcion' i]",
            "[aria-label*='albaranes' i]",
            "[title*='albaranes' i]",
        ):
            try:
                loc = marco.locator(sel)
                for el in _visible(loc, 8):
                    if _es_accion_traer_recepcion(_texto_control(el)):
                        return el
            except Exception:
                continue
    return None


def _abrir_traer_por_menu_linea(pagina) -> str | None:
    """Línea > Acciones > Traer albaranes de compra (lo que pide Maria)."""
    _cerrar_menus_ui(pagina)
    if not pulsar(pagina, re.compile(r"^L[ií]nea$"), ("button", "menuitem")):
        return None
    pagina.wait_for_timeout(250)
    _cerrar_menus_ui(pagina)
    pulsar(pagina, re.compile(r"^Acciones$"), ("menuitem", "button"))
    pagina.wait_for_timeout(250)
    # Primero albaranes de compra; luego recepción si aparece.
    for patron in (ACCION_TRAER, ACCION_TRAER_RECEPCION):
        el = buscar(pagina, patron, ("menuitem", "button"))
        if el is None:
            continue
        if not _es_accion_traer_recepcion(_texto_control(el)):
            continue
        if _click_el(el, "Traer albaranes (Línea>Acciones)"):
            return "menu_linea"
    return None


def abrir_traer_albaranes(pagina, numero_factura: str | None = None) -> str | None:
    """1) Ribbon recepción (aria-label). 2) Línea > Acciones > Traer albaranes de compra."""
    factura = (numero_factura or "").strip()

    def _seguir_en_ficha() -> bool:
        if not factura:
            return True
        if en_ficha(pagina, factura):
            return True
        log(f"Se ha salido de la ficha {factura}; reabro el enlace directo.")
        abierta = abrir_factura(pagina, factura)
        return bool(abierta.get("ok") and en_ficha(pagina, factura))

    _cerrar_dialogo_equivocado(pagina)
    _cerrar_menus_ui(pagina)
    if not _seguir_en_ficha():
        return None
    esperar_ocupado(pagina, 8)
    pulsar(pagina, re.compile(r"^Inicio$"), ("tab", "button"))
    pagina.wait_for_timeout(200)
    _cerrar_menus_ui(pagina)
    if not _seguir_en_ficha():
        return None

    el = _buscar_boton_traer_ribbon(pagina)
    if el is not None and _click_el(el, "Traer líneas recepción (ribbon)"):
        if _cerrar_dialogo_equivocado(pagina):
            log("Ribbon abrió suscripción; paso a Línea > Acciones > Traer albaranes.")
        else:
            return "ribbon_inicio"

    # Preferido por Maria: Traer albaranes de compra.
    via = _abrir_traer_por_menu_linea(pagina)
    if via:
        if _cerrar_dialogo_equivocado(pagina):
            log("El menú abrió suscripción; reintento una vez.")
            via = _abrir_traer_por_menu_linea(pagina)
        if via and not _cerrar_dialogo_equivocado(pagina):
            return via
    return None


def _cabeceras_dialogo(dialogo) -> list[str]:
    if dialogo is None:
        return []
    try:
        loc = dialogo.get_by_role("columnheader")
        n = min(loc.count(), 40)
    except Exception:
        return []
    out = []
    for i in range(n):
        try:
            out.append((loc.nth(i).inner_text(timeout=500) or "").strip().replace("\n", " "))
        except Exception:
            out.append("")
    return out


# Menú BC: «Filtrar…» / «Filtro…» ≠ «Filtrar a este valor».
MENU_FILTRAR = re.compile(
    r"^(Filtrar|Filtro|Filter)(\u2026|\.\.\.|\s*\.\.\.)?$",
    re.I,
)
MENU_FILTRAR_A_VALOR = re.compile(
    r"^Filtrar a este valor$|^Filter to this value$",
    re.I,
)
MENU_BORRAR_FILTRO = re.compile(
    r"^Borrar filtro$|^Quitar filtro$|^Clear filter$|^Clear Filter$",
    re.I,
)


def _textos_menu_visibles(pagina) -> list[str]:
    out = []
    selectores = (
        "[role='menuitem']",
        "[role='menuitemcheckbox']",
        "[role='option']",
        ".ms-ContextualMenu-item",
        ".ms-ContextualMenu-link",
        "[class*='ContextualMenu'] button",
        "[class*='ctxmenu'] button",
        "[class*='ctxmenu'] [role='button']",
        ".ms-nav-ctxmenu [role='button']",
        ".ms-nav-ctxmenu button",
    )
    for marco in pagina.frames:
        for sel in selectores:
            try:
                loc = marco.locator(sel)
                n = min(loc.count(), 40)
            except Exception:
                continue
            for i in range(n):
                try:
                    el = loc.nth(i)
                    if not el.is_visible():
                        continue
                    t = (el.inner_text(timeout=200) or "").strip().replace("\n", " ")
                    if t and t not in out:
                        out.append(t)
                except Exception:
                    continue
    return out


def _menu_filtrar_abierto(pagina) -> bool:
    textos = _textos_menu_visibles(pagina)
    if any(
        MENU_FILTRAR.match(t) or MENU_FILTRAR_A_VALOR.match(t) or t.lower().startswith("filtrar")
        for t in textos
    ):
        return True
    # Por si el texto «Filtrar…» está en un nodo sin role menuitem
    for marco in pagina.frames:
        try:
            loc = marco.get_by_text(MENU_FILTRAR)
            n = min(loc.count(), 6)
            for i in range(n):
                el = loc.nth(i)
                try:
                    if el.is_visible():
                        return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _clic_opcion_menu(pagina, patron: re.Pattern, etiqueta: str) -> bool:
    """Clic en una opción del menú contextual abierto (Filtrar… / Filtrar a este valor)."""
    roles = ("menuitem", "menuitemcheckbox", "option", "button")
    for marco in pagina.frames:
        for role in roles:
            try:
                loc = marco.get_by_role(role, name=patron)
                if loc.count() and loc.first.is_visible(timeout=400):
                    if _click_el(loc.first, etiqueta):
                        return True
            except Exception:
                pass
    # Texto exacto (incluye «Filtrar…» con puntos tipográficos)
    for marco in pagina.frames:
        try:
            loc = marco.get_by_text(patron)
            n = min(loc.count(), 12)
        except Exception:
            continue
        for i in range(n):
            el = loc.nth(i)
            try:
                if not el.is_visible():
                    continue
                t = (el.inner_text(timeout=200) or "").strip()
                if not patron.match(t):
                    continue
                if _click_el(el, etiqueta):
                    return True
            except Exception:
                continue
    # Nodos de menú Fluent / BC
    for marco in pagina.frames:
        try:
            loc = marco.locator(
                "[role='menuitem'], [role='menuitemcheckbox'], .ms-ContextualMenu-item, "
                ".ms-ContextualMenu-link, [class*='ctxmenu'] button, button, span, div"
            )
            n = min(loc.count(), 100)
        except Exception:
            continue
        for i in range(n):
            el = loc.nth(i)
            try:
                if not el.is_visible():
                    continue
                t = (el.inner_text(timeout=200) or "").strip()
                if not patron.match(t):
                    continue
                if _click_el(el, etiqueta):
                    return True
            except Exception:
                continue
    return False


def _abrir_menu_columna_documento(pagina, dialogo) -> bool:
    """Abre el menú de la cabecera Nº documento (paso previo a Filtrar…)."""
    header = None
    if dialogo is not None:
        try:
            loc = dialogo.locator("[role='columnheader']").filter(has_text=COL_DOCUMENTO)
            if loc.count() and loc.first.is_visible():
                header = loc.first
        except Exception:
            header = None
    if header is None:
        header = buscar(pagina, COL_DOCUMENTO, ("columnheader",), dialogo)
    if header is None:
        log(f"No veo Nº documento. Cabeceras: {_cabeceras_dialogo(dialogo)}")
        return False
    try:
        header.scroll_into_view_if_needed(timeout=1200)
    except Exception:
        pass

    def _clic_chevron():
        bots = header.locator("button, [role='button']")
        if bots.count() <= 0:
            raise RuntimeError("sin chevron")
        bots.last.click(timeout=2000)

    def _clic_menu_aria():
        # BC: botón «Menú de Nº documento» / «Document No. menu»
        raiz = dialogo if dialogo is not None else pagina
        loc = raiz.locator(
            "[aria-label*='documento' i][aria-label*='menú' i], "
            "[aria-label*='documento' i][aria-label*='menu' i], "
            "[aria-label*='Document' i][aria-label*='menu' i], "
            "[title*='Menú' i][title*='documento' i]"
        )
        if loc.count() <= 0 or not loc.first.is_visible():
            raise RuntimeError("sin botón menú aria")
        loc.first.click(timeout=2000)

    gestos = [
        ("menu-aria", _clic_menu_aria),
        ("chevron", _clic_chevron),
        ("clic", lambda: header.click(timeout=2000)),
        ("doble", lambda: header.dblclick(timeout=2000)),
        ("derecho", lambda: header.click(timeout=2000, button="right")),
        ("force", lambda: header.click(timeout=2000, force=True)),
        ("alt-down", lambda: (header.click(timeout=2000), pagina.keyboard.press("Alt+ArrowDown"))),
    ]
    for nombre, gesto in gestos:
        try:
            gesto()
        except Exception:
            continue
        pagina.wait_for_timeout(500)
        if _menu_filtrar_abierto(pagina):
            log(f"Menú columna abierto ({nombre}): {_textos_menu_visibles(pagina)[:8]}")
            return True
        try:
            pagina.keyboard.press("Escape")
            pagina.wait_for_timeout(150)
        except Exception:
            pass
    log(f"Menú de Nº documento no muestra Filtrar…. Vistos: {_textos_menu_visibles(pagina)[:12]}")
    captura(pagina, "filtro", "sin_menu_filtrar")
    return False


def _abrir_filtro_columna(pagina, dialogo, patron_columna: re.Pattern, nombre_col: str) -> bool:
    """Cabecera → menú → clic Filtrar… (como en la lista de facturas)."""
    if patron_columna != COL_DOCUMENTO and nombre_col != "Nº documento":
        header = buscar(pagina, patron_columna, ("columnheader",), dialogo)
        if header is None:
            return False
        try:
            bots = header.locator("button, [role='button']")
            if bots.count() > 0:
                bots.last.click(timeout=2000)
            else:
                header.click(timeout=2000)
            pagina.wait_for_timeout(350)
        except Exception:
            return False
    else:
        if not _abrir_menu_columna_documento(pagina, dialogo):
            return False

    # Quitar filtro previo de la columna si existe.
    if _clic_opcion_menu(pagina, MENU_BORRAR_FILTRO, "Borrar filtro") or pulsar(
        pagina, MENU_BORRAR_FILTRO, ("menuitem", "button")
    ):
        esperar_ocupado(pagina, 6)
        pagina.wait_for_timeout(250)
        if patron_columna == COL_DOCUMENTO or nombre_col == "Nº documento":
            if not _abrir_menu_columna_documento(pagina, dialogo):
                return False
        else:
            header = buscar(pagina, patron_columna, ("columnheader",), dialogo)
            if header is None:
                return False
            try:
                header.click(timeout=2000)
                pagina.wait_for_timeout(300)
            except Exception:
                return False

    if _clic_opcion_menu(pagina, MENU_FILTRAR, "Filtrar…"):
        log("Clic en «Filtrar…» OK.")
        pagina.wait_for_timeout(500)
        return True
    if pulsar(pagina, MENU_FILTRAR, ("menuitem", "button")):
        log("Clic en «Filtrar…» OK (pulsar).")
        pagina.wait_for_timeout(500)
        return True
    log("No he podido hacer clic en «Filtrar…».")
    captura(pagina, "filtro", "sin_clic_filtrar")
    return False


def _localizar_popup_filtro(pagina, espera_ms: int = 5000):
    """Popup «Mostrar solo líneas donde 'Nº documento' sea»."""
    fin = time.time() + (espera_ms / 1000)
    while time.time() < fin:
        for marco in pagina.frames:
            try:
                dialogos = marco.get_by_role("dialog")
                n = min(dialogos.count(), 10)
            except Exception:
                continue
            for i in range(n):
                el = dialogos.nth(i)
                try:
                    if not el.is_visible():
                        continue
                    texto = el.inner_text(timeout=600) or ""
                except Exception:
                    continue
                if POPUP_FILTRO.search(texto):
                    return el
                if (
                    re.search(r"Aceptar|OK", texto, re.I)
                    and re.search(r"Cancelar|Cancel", texto, re.I)
                    and not TITULO_DIALOGO.search(texto)
                    and "Traer" not in texto
                    and re.search(r"documento|Document|sea|is|líneas|lines", texto, re.I)
                ):
                    return el
        pagina.wait_for_timeout(200)
    return None


def _popup_filtro_sigue_abierto(pagina) -> bool:
    return _localizar_popup_filtro(pagina, 500) is not None


def _cerrar_sugerencias_autocomplete(pagina) -> None:
    """
    BC abre un desplegable al escribir el filtro (bloquea Aceptar).
    Un solo Escape cierra sugerencias; no dos (cerraría el popup).
    """
    try:
        pagina.keyboard.press("Escape")
    except Exception:
        pass
    pagina.wait_for_timeout(200)


def _aceptar_solo_popup_filtro(pagina, popup) -> bool:
    """Aceptar del popup de filtro (tras cerrar sugerencias)."""
    if popup is None:
        return False
    _cerrar_sugerencias_autocomplete(pagina)
    popup = _localizar_popup_filtro(pagina, 1500) or popup

    for force in (False, True, True):
        try:
            bot = popup.locator("button").filter(has_text=re.compile(r"^Aceptar$|^OK$", re.I))
            if bot.count() > 0 and bot.first.is_visible():
                bot.first.click(timeout=2500, force=force)
            else:
                bot = popup.get_by_role("button", name=re.compile(r"^Aceptar$|^OK$", re.I))
                if bot.count() > 0:
                    bot.first.click(timeout=2500, force=force)
                else:
                    popup.get_by_text(re.compile(r"^Aceptar$|^OK$", re.I)).first.click(
                        timeout=2500, force=force
                    )
        except Exception:
            try:
                pagina.keyboard.press("Enter")
            except Exception:
                pass
        for _ in range(12):
            pagina.wait_for_timeout(200)
            if not _popup_filtro_sigue_abierto(pagina):
                log("Aceptar del popup de filtro: OK.")
                esperar_ocupado(pagina, 8)
                return True
        _cerrar_sugerencias_autocomplete(pagina)
        popup = _localizar_popup_filtro(pagina, 800) or popup

    log("El popup de filtro no cierra tras Aceptar.")
    captura(pagina, "filtro", "popup_no_cierra")
    return False


def _rellenar_popup_filtro(pagina, popup, valor: str) -> bool:
    """Escribir valor → Escape (sugerencias) → Aceptar. Sin reescrituras largas."""
    if popup is None:
        return False
    try:
        caja = None
        for sel in ("textbox", "searchbox", "combobox"):
            try:
                loc = popup.get_by_role(sel)
                if loc.count():
                    caja = loc.first
                    break
            except Exception:
                continue
        if caja is None:
            try:
                inp = popup.locator("input:visible, [contenteditable='true']")
                if inp.count():
                    caja = inp.first
            except Exception:
                pass
        if caja is not None:
            try:
                caja.click(timeout=2000)
            except Exception:
                pass
        pagina.keyboard.press("Control+A")
        pagina.keyboard.press("Delete")
        pagina.keyboard.insert_text(valor)
        pagina.wait_for_timeout(250)
        log(f"Popup filtro: escrito «{valor}».")
        _cerrar_sugerencias_autocomplete(pagina)
        if not _aceptar_solo_popup_filtro(pagina, popup):
            return False
        pagina.wait_for_timeout(300)
        return True
    except Exception as e:
        log(f"No he podido rellenar el popup de filtro ({e}).")
        return False


def filtrar_columna_dialogo(pagina, dialogo, patron_columna: re.Pattern, valor: str, nombre_col: str) -> bool:
    """Cabecera → Filtrar… → valor → Escape → Aceptar popup."""
    if not _abrir_filtro_columna(pagina, dialogo, patron_columna, nombre_col):
        return False
    popup = _localizar_popup_filtro(pagina, 4000)
    if popup is None:
        log(f"Tras Filtrar… no aparece el popup de {nombre_col}.")
        captura(pagina, "filtro", "sin_popup_filtrar")
        return False
    return _rellenar_popup_filtro(pagina, popup, valor)


def filtrar_pedido(pagina, dialogo, pedido: str) -> bool:
    """Filtra Nº pedido con el popup de BC."""
    return filtrar_columna_dialogo(pagina, dialogo, COL_PEDIDO, pedido, "Nº pedido")


def _dialogo_solo_tiene_albaran(dialogo, alb: str) -> bool:
    """True si en el diálogo solo aparece ese ALBC (filtro aplicado)."""
    if dialogo is None or not alb:
        return False
    visibles = _albaranes_visibles_en_dialogo(dialogo)
    if not visibles:
        try:
            texto = (dialogo.inner_text(timeout=1500) or "").upper()
        except Exception:
            texto = ""
        return alb in texto and not any(
            a != alb for a in _albaranes_en_texto(texto)
        )
    return alb in visibles and all(a == alb for a in visibles)


def _buscar_celda_documento(dialogo, alb: str):
    """Celda (o texto) con el nº de documento ALBC… dentro del diálogo."""
    if dialogo is None or not alb:
        return None
    # 1) gridcell con el texto exacto
    try:
        loc = dialogo.get_by_role("gridcell", name=re.compile(rf"^{re.escape(alb)}$", re.I))
        if loc.count() and loc.first.is_visible():
            return loc.first
    except Exception:
        pass
    try:
        loc = dialogo.get_by_text(alb, exact=True)
        n = min(loc.count(), 10)
        for i in range(n):
            el = loc.nth(i)
            try:
                if el.is_visible():
                    return el
            except Exception:
                continue
    except Exception:
        pass
    return None


def _filtrar_por_busqueda_dialogo(pagina, dialogo, alb: str) -> bool:
    """Usa la lupa / campo Buscar del diálogo Traer líns. albarán."""
    if dialogo is None:
        return False
    caja = None
    for role in ("searchbox", "textbox"):
        try:
            loc = dialogo.get_by_role(role)
            n = min(loc.count(), 6)
        except Exception:
            continue
        for i in range(n):
            el = loc.nth(i)
            try:
                if not el.is_visible():
                    continue
                ph = (el.get_attribute("placeholder") or "").lower()
                aria = (el.get_attribute("aria-label") or "").lower()
                if any(x in ph or x in aria for x in ("buscar", "search", "filtro", "filter")) or role == "searchbox":
                    caja = el
                    break
            except Exception:
                continue
        if caja is not None:
            break
    if caja is None:
        try:
            # Icono lupa del diálogo
            lupa = dialogo.locator("[aria-label*='Buscar' i], [title*='Buscar' i], [aria-label*='Search' i]")
            if lupa.count() and lupa.first.is_visible():
                lupa.first.click(timeout=2000)
                pagina.wait_for_timeout(200)
                loc = dialogo.get_by_role("textbox")
                if loc.count():
                    caja = loc.first
        except Exception:
            pass
    if caja is None:
        return False
    try:
        caja.click(timeout=2000)
        pagina.keyboard.press("Control+A")
        pagina.keyboard.press("Delete")
        pagina.keyboard.insert_text(alb)
        pagina.keyboard.press("Enter")
    except Exception as e:
        log(f"No he podido usar la búsqueda del diálogo ({e}).")
        return False
    esperar_ocupado(pagina, 6)
    pagina.wait_for_timeout(300)
    dlg = localizar_dialogo(pagina) or dialogo
    ok = _dialogo_solo_tiene_albaran(dlg, alb)
    log(f"Búsqueda «{alb}» en diálogo: {'OK' if ok else 'no dejó solo ese ALBC'}.")
    return ok


def _filtrar_a_este_valor(pagina, dialogo, alb: str) -> bool:
    """Clic en la celda ALBC → menú → «Filtrar a este valor»."""
    celda = _buscar_celda_documento(dialogo, alb)
    if celda is None:
        log(f"No veo la celda {alb} para «Filtrar a este valor».")
        return False
    for gesto in (
        lambda: (celda.click(timeout=2000), celda.click(timeout=2000, button="right")),
        lambda: celda.click(timeout=2000, button="right"),
        lambda: celda.click(timeout=2000),
    ):
        try:
            gesto()
        except Exception:
            continue
        pagina.wait_for_timeout(400)
        if _clic_opcion_menu(pagina, MENU_FILTRAR_A_VALOR, "Filtrar a este valor"):
            break
        if pulsar(pagina, MENU_FILTRAR_A_VALOR, ("menuitem", "button")):
            break
        try:
            pagina.keyboard.press("Escape")
            pagina.wait_for_timeout(120)
        except Exception:
            pass
    else:
        log(f"No aparece «Filtrar a este valor» en la celda {alb}.")
        return False
    esperar_ocupado(pagina, 6)
    pagina.wait_for_timeout(300)
    dlg = localizar_dialogo(pagina) or dialogo
    ok = _dialogo_solo_tiene_albaran(dlg, alb)
    log(f"«Filtrar a este valor» {alb}: {'OK' if ok else 'falló'}.")
    return ok


def _filtrar_via_popup_editando_or(pagina, dialogo, albs: list[str]) -> bool:
    """
    Si ya hay un filtro de un ALBC (p. ej. Filtrar a este valor), abre Filtrar…
    y pone ALBC1|ALBC2 en el popup.
    """
    if len(albs) < 2:
        return False
    dlg = localizar_dialogo(pagina) or dialogo
    if not _abrir_filtro_columna(pagina, dlg, COL_DOCUMENTO, "Nº documento"):
        return False
    popup = _localizar_popup_filtro(pagina, 5000)
    if popup is None:
        return False
    valor = "|".join(albs)
    if not _rellenar_popup_filtro(pagina, popup, valor):
        return False
    dlg = localizar_dialogo(pagina) or dlg
    return _dialogo_tiene_exactamente_albaranes(dlg, albs)


def _dialogo_tiene_exactamente_albaranes(dialogo, albaranes: list[str]) -> bool:
    """True si los ALBC visibles son exactamente el conjunto pedido (ni más ni menos)."""
    ped = {str(a).strip().upper() for a in (albaranes or []) if str(a).strip()}
    if not ped or dialogo is None:
        return False
    visibles = set(_albaranes_visibles_en_dialogo(dialogo))
    if not visibles:
        try:
            visibles = set(_albaranes_en_texto(dialogo.inner_text(timeout=1500) or ""))
        except Exception:
            visibles = set()
    return visibles == ped


def filtrar_documento_albaran(pagina, dialogo, albaran: str) -> bool:
    """Un solo ALBC: delega en filtro múltiple."""
    return filtrar_documentos_albaranes(pagina, dialogo, [albaran])


def _filtro_documento_verificado(dialogo, albs: list[str]) -> bool:
    """True solo si el diálogo muestra exactamente los ALBC pedidos (filtro aplicado)."""
    if _dialogo_tiene_exactamente_albaranes(dialogo, albs):
        return True
    return len(albs) == 1 and _dialogo_solo_tiene_albaran(dialogo, albs[0])


def filtrar_documentos_albaranes(pagina, dialogo, albaranes: list[str]) -> bool:
    """
    Único camino: Nº documento → Filtrar… → valor (ALBC o ALBC1|ALBC2)
    → Escape (sugerencias) → Aceptar popup → comprobar.
    """
    albs = [str(a or "").strip().upper() for a in (albaranes or []) if str(a or "").strip()]
    albs = list(dict.fromkeys(albs))
    if not albs:
        return False
    valor = "|".join(albs)
    dlg = localizar_dialogo(pagina) or dialogo
    if not filtrar_columna_dialogo(pagina, dlg, COL_DOCUMENTO, valor, "Nº documento"):
        log(f"No he podido filtrar Nº documento a {valor}.")
        captura(pagina, "filtro", "no_filtra_documento")
        return False
    pagina.wait_for_timeout(400)
    dlg = localizar_dialogo(pagina) or dlg
    if _filtro_documento_verificado(dlg, albs):
        log(f"Filtro Nº documento verificado: {valor}.")
        return True
    visibles = _albaranes_visibles_en_dialogo(dlg)
    log(f"Tras filtrar visibles={visibles or '—'}; se pedía {albs}.")
    captura(pagina, "filtro", "no_filtra_documento")
    return False


def _albaranes_en_texto(texto: str) -> list[str]:
    vistos = []
    for n in NUM_ALBARAN.findall(texto or ""):
        n = n.upper()
        if n not in vistos:
            vistos.append(n)
    return vistos


def _checkbox_marcado(cb) -> bool:
    try:
        estado = (cb.get_attribute("aria-checked") or "").lower()
        if estado in ("true", "mixed"):
            return True
        if estado == "false":
            return False
    except Exception:
        pass
    try:
        return bool(cb.is_checked())
    except Exception:
        return False


def _desmarcar_todo_dialogo(pagina, dialogo) -> None:
    """Deja el diálogo sin ninguna fila marcada (cabecera + filas)."""
    if dialogo is None:
        return
    # 1) Casilla «seleccionar todo» de la cabecera
    try:
        cbs = dialogo.locator(
            "[role='columnheader'] [role='checkbox'], [role='columnheader'] input[type='checkbox']"
        )
        n = min(cbs.count(), 4)
    except Exception:
        n = 0
    for i in range(n):
        cb = cbs.nth(i)
        try:
            if not cb.is_visible():
                continue
            for _ in range(3):
                if not _checkbox_marcado(cb):
                    break
                cb.click(timeout=1500)
                pagina.wait_for_timeout(150)
        except Exception:
            continue
    # 2) Por si BC dejó filas sueltas marcadas, desmarcar cada una
    try:
        filas = dialogo.get_by_role("row")
        nfilas = min(filas.count(), 80)
    except Exception:
        return
    for i in range(nfilas):
        fila = filas.nth(i)
        try:
            if not fila.is_visible():
                continue
            cbs_fila = fila.locator("[role='checkbox'], input[type='checkbox']")
            if cbs_fila.count() <= 0:
                continue
            cb = cbs_fila.first
            if _checkbox_marcado(cb):
                cb.click(timeout=1200)
                pagina.wait_for_timeout(60)
        except Exception:
            continue


def _marcar_checkbox_fila(fila) -> bool:
    try:
        cbs = fila.locator("[role='checkbox'], input[type='checkbox']")
        if cbs.count() <= 0:
            return False
        cb = cbs.first
        if not cb.is_visible():
            return False
        if not _checkbox_marcado(cb):
            cb.click(timeout=1500)
        return True
    except Exception:
        return False


def filas_visibles_datos(dialogo, pedido: str = "", albaran: str | None = None):
    """Filas de datos del diálogo (con texto), opcionalmente del pedido/albarán."""
    if dialogo is None:
        return []
    try:
        loc = dialogo.get_by_role("row")
        n = min(loc.count(), 80)
    except Exception:
        return []
    pedido_u = (pedido or "").upper()
    alb_u = (albaran or "").strip().upper()
    encontradas = []
    for i in range(n):
        fila = loc.nth(i)
        try:
            if not fila.is_visible():
                continue
            # Sin checkbox no es fila de datos seleccionable
            cbs = fila.locator("[role='checkbox'], input[type='checkbox']")
            if cbs.count() <= 0:
                continue
            texto = (fila.inner_text(timeout=700) or "").upper()
        except Exception:
            continue
        if not texto.strip():
            continue
        if pedido_u and pedido_u not in texto:
            continue
        albs = _albaranes_en_texto(texto)
        if alb_u:
            if alb_u not in albs and alb_u not in texto:
                continue
        encontradas.append((fila, texto, albs))
    return encontradas


def _albaranes_visibles_en_dialogo(dialogo) -> list[str]:
    """Todos los ALBC que aparecen en el texto del diálogo (no solo en filas ya filtradas)."""
    if dialogo is None:
        return []
    try:
        texto = dialogo.inner_text(timeout=2000) or ""
    except Exception:
        texto = ""
    return _albaranes_en_texto(texto)


def _filas_con_checkbox(dialogo):
    if dialogo is None:
        return []
    try:
        loc = dialogo.get_by_role("row")
        n = min(loc.count(), 100)
    except Exception:
        return []
    out = []
    for i in range(n):
        fila = loc.nth(i)
        try:
            if not fila.is_visible():
                continue
            cbs = fila.locator("[role='checkbox'], input[type='checkbox']")
            if cbs.count() <= 0:
                continue
            texto = (fila.inner_text(timeout=700) or "").upper()
            if not texto.strip():
                continue
            out.append((fila, texto, _albaranes_en_texto(texto), cbs.first))
        except Exception:
            continue
    return out


def _asegurar_solo_marcadas(pagina, dialogo, alb: str) -> tuple[int, str | None]:
    """
    Deja marcadas SOLO las filas del albarán pedido.
    Desmarca cualquier otra. Si no puede desmarcar una ajena, error.
    """
    filas = _filas_con_checkbox(dialogo)
    if not filas:
        return 0, "No veo casillas en las filas del diálogo."
    marcadas_ok = 0
    for fila, texto, albs, cb in filas:
        es_del_alb = alb in texto or alb in albs
        try:
            marcado = _checkbox_marcado(cb)
            if es_del_alb:
                if not marcado:
                    cb.click(timeout=1500)
                    pagina.wait_for_timeout(80)
                marcadas_ok += 1
            else:
                if marcado:
                    cb.click(timeout=1500)
                    pagina.wait_for_timeout(80)
                    if _checkbox_marcado(cb):
                        return 0, f"No he podido desmarcar una línea que no es {alb}."
        except Exception as e:
            return 0, f"Error al marcar/desmarcar filas: {e}"
    # Comprobación final: ninguna casilla ajena marcada
    for fila, texto, albs, cb in _filas_con_checkbox(dialogo):
        es_del_alb = alb in texto or alb in albs
        if not es_del_alb and _checkbox_marcado(cb):
            return 0, f"Sigue marcada una línea que no es {alb}."
    if marcadas_ok <= 0:
        return 0, f"No hay líneas del albarán {alb} para marcar."
    return marcadas_ok, None


def _filas_del_albaran_en_dialogo(dialogo, alb: str):
    """Filas visibles del ALBC (con o sin checkbox)."""
    filas = [f for f, t, a, _ in _filas_con_checkbox(dialogo) if alb in t or alb in a]
    if filas:
        return filas
    filas = [f for f, t, _ in filas_visibles_datos(dialogo, pedido="", albaran=alb)]
    if filas:
        return filas
    out = []
    try:
        loc = dialogo.get_by_role("row")
        for i in range(min(loc.count(), 80)):
            fila = loc.nth(i)
            try:
                if not fila.is_visible():
                    continue
                texto = (fila.inner_text(timeout=600) or "").upper()
            except Exception:
                continue
            if alb in texto:
                out.append(fila)
    except Exception:
        pass
    return out


def seleccionar_solo_albaran(pagina, dialogo, pedido: str, albaran: str) -> int:
    """Un ALBC: delega en selección múltiple."""
    return seleccionar_albaranes(pagina, dialogo, [albaran])


def _pulsar_seleccionar_todo(pagina, dialogo) -> bool:
    """Acción BC «Seleccionar todo» dentro del diálogo Traer (tras filtrar)."""
    raiz = dialogo if dialogo is not None else None
    # A veces está en menú «Seleccionar más» / «Select More»
    if pulsar(
        pagina,
        re.compile(r"^Seleccionar m[aá]s$|^Select [Mm]ore$", re.I),
        ("button", "menuitem"),
        raiz,
    ):
        pagina.wait_for_timeout(250)
    if pulsar(
        pagina,
        re.compile(r"^Seleccionar todo$|^Select all$", re.I),
        ("menuitem", "button"),
        raiz,
    ):
        log("Clic en «Seleccionar todo».")
        pagina.wait_for_timeout(300)
        return True
    # Texto visible en el diálogo
    try:
        loc = (dialogo or pagina).get_by_text(re.compile(r"^Seleccionar todo$|^Select all$", re.I))
        if loc.count() and loc.first.is_visible():
            loc.first.click(timeout=2000)
            log("Clic en «Seleccionar todo» (texto).")
            pagina.wait_for_timeout(300)
            return True
    except Exception:
        pass
    return False


def _seleccionar_lineas_tras_filtro(pagina, dialogo, albs: list[str]) -> int:
    """Paso 2 (Maria): tras filtrar → Seleccionar todo (líneas visibles)."""
    dialogo = localizar_dialogo(pagina) or dialogo

    if _pulsar_seleccionar_todo(pagina, dialogo):
        filas_cb = _filas_con_checkbox(dialogo)
        marcadas = sum(1 for _, _, _, c in filas_cb if _checkbox_marcado(c))
        if marcadas > 0:
            log(f"Selección tras filtro: {marcadas} línea(s) (Seleccionar todo).")
            return marcadas
        # Sin checkboxes visibles: filas del filtro cuentan como seleccionadas
        total = 0
        for alb in albs:
            total += len(_filas_del_albaran_en_dialogo(dialogo, alb))
        if total <= 0:
            try:
                total = min((dialogo.get_by_role("row").count() if dialogo else 0), 80)
            except Exception:
                total = len(albs)
        if total > 0:
            log(f"Seleccionar todo pulsado; asumo {total} línea(s) del filtro.")
            return max(total, 1)

    # Casilla de cabecera
    try:
        cbs = dialogo.locator(
            "[role='columnheader'] [role='checkbox'], [role='columnheader'] input[type='checkbox']"
        )
        if cbs.count() > 0 and cbs.first.is_visible():
            cb = cbs.first
            if not _checkbox_marcado(cb):
                cb.click(timeout=1500)
                pagina.wait_for_timeout(200)
            filas_cb = _filas_con_checkbox(dialogo)
            marcadas = sum(1 for _, _, _, c in filas_cb if _checkbox_marcado(c))
            if marcadas > 0:
                log(f"Selección tras filtro: {marcadas} línea(s) (cabecera).")
                return marcadas
    except Exception:
        pass

    # Ctrl+A sobre la rejilla filtrada
    try:
        if dialogo is not None:
            dialogo.click(timeout=1000, position={"x": 80, "y": 120})
        pagina.keyboard.press("Control+A")
        pagina.wait_for_timeout(250)
        log("Selección tras filtro: Control+A.")
    except Exception:
        pass

    filas = []
    for alb in albs:
        filas.extend(_filas_del_albaran_en_dialogo(dialogo, alb))
    if not filas:
        filas = [f for f, _, _, _ in _filas_con_checkbox(dialogo)]
    if not filas:
        for alb in albs:
            celda = _buscar_celda_documento(dialogo, alb)
            if celda is None:
                continue
            try:
                celda.click(timeout=2000)
                filas.append(celda)
            except Exception:
                continue
    if not filas:
        log("Filtro OK pero no encuentro filas para seleccionar.")
        return 0

    vistas = []
    for fila in filas:
        if fila not in vistas:
            vistas.append(fila)

    marcadas = 0
    for i, fila in enumerate(vistas):
        try:
            try:
                fila.scroll_into_view_if_needed(timeout=1000)
            except Exception:
                pass
            if not _marcar_checkbox_fila(fila):
                if i == 0:
                    fila.click(timeout=2000)
                else:
                    fila.click(timeout=2000, modifiers=["Control"])
            marcadas += 1
        except Exception as e:
            log(f"No he podido seleccionar una línea ({e}).")
    log(f"Selección tras filtro {', '.join(albs)}: {marcadas} línea(s).")
    return marcadas if marcadas else 0


def seleccionar_albaranes(pagina, dialogo, albaranes: list[str]) -> int:
    """
    Orden fijo Maria:
    1) Filtrar Nº documento = ALBC1|ALBC2 (obligatorio; si no, aborta)
    2) Seleccionar las líneas visibles
    3) Listo para Aceptar
    """
    albs = [str(a or "").strip().upper() for a in (albaranes or []) if str(a or "").strip()]
    albs = list(dict.fromkeys(albs))
    if not albs:
        return 0

    if not filtrar_documentos_albaranes(pagina, dialogo, albs):
        log(f"No he podido filtrar Nº documento a {'|'.join(albs)}.")
        return -1
    pagina.wait_for_timeout(300)
    dialogo = localizar_dialogo(pagina) or dialogo

    if not _filtro_documento_verificado(dialogo, albs):
        visibles = _albaranes_visibles_en_dialogo(dialogo)
        log(f"Tras filtrar {'|'.join(albs)} visibles={visibles}. Aborto (sin seleccionar).")
        return -2
    log(f"Filtro OK: {', '.join(albs)}. Paso a seleccionar.")
    return _seleccionar_lineas_tras_filtro(pagina, dialogo, albs)


def seleccionar_filas(pagina, dialogo, pedido: str, albaranes: list[str] | None = None) -> int:
    """Sin filtro de albarán: marca las filas del pedido (solo si no se pidió ALBC concreto)."""
    elegidos = [str(a or "").strip().upper() for a in (albaranes or []) if str(a or "").strip()]
    if elegidos:
        return seleccionar_solo_albaran(pagina, dialogo, pedido, elegidos[0])
    # Sin ALBC concreto no usamos «seleccionar todo»: marcamos fila a fila del pedido.
    _desmarcar_todo_dialogo(pagina, dialogo)
    pagina.wait_for_timeout(100)
    dialogo = localizar_dialogo(pagina) or dialogo
    filas = _filas_con_checkbox(dialogo)
    marcadas = 0
    for fila, texto, _, cb in filas:
        if pedido and pedido.upper() not in texto:
            continue
        try:
            if not _checkbox_marcado(cb):
                cb.click(timeout=1500)
            marcadas += 1
        except Exception as e:
            log(f"No he podido seleccionar una fila del pedido ({e}).")
    return marcadas


def _albaran_cabecera_comentario(texto: str) -> str | None:
    """En BC el albarán va en comentario: «Nº albarán ALBC26-006144»."""
    t = texto or ""
    m = re.search(r"N\.?\s*[º°o]\.?\s*albar[aá]n\s*(ALBC\d{2}-\d+)", t, re.I)
    if m:
        return m.group(1).upper()
    albs = _albaranes_en_texto(t)
    return albs[0] if len(albs) == 1 else None


def _eliminar_fila_linea(pagina, fila) -> bool:
    """Borra una línea sin Escape (Escape cierra la ficha y vuelve al inicio)."""
    try:
        fila.click(timeout=3000)
    except Exception as e:
        log(f"No he podido seleccionar la línea ({e}).")
        return False
    pagina.wait_for_timeout(200)
    # Preferir Ctrl+Delete: no abre menús que puedan sacar de la ficha.
    try:
        pagina.keyboard.press("Control+Delete")
        confirmar_si_pregunta_borrar(pagina)
        esperar_ocupado(pagina, 10)
        return True
    except Exception as e:
        log(f"Ctrl+Delete no disponible ({e}); pruebo menú Línea.")
    borrada = pulsar(pagina, re.compile(r"^Eliminar l[ií]nea$|^Borrar l[ií]nea$"), ("menuitem", "button"))
    if not borrada:
        pulsar(pagina, re.compile(r"^L[ií]nea$"), ("button", "menuitem"))
        pagina.wait_for_timeout(250)
        borrada = pulsar(pagina, re.compile(r"Eliminar l[ií]nea|Borrar l[ií]nea"), ("menuitem", "button"))
    if not borrada:
        return False
    confirmar_si_pregunta_borrar(pagina)
    esperar_ocupado(pagina, 10)
    return True


def _asegurar_ficha_factura(pagina, factura: str) -> bool:
    """Si BC saltó al inicio, reabre la factura por enlace directo."""
    if en_ficha(pagina, factura):
        return True
    log(f"Fuera de la ficha {factura}; la reabro.")
    abierta = abrir_factura(pagina, factura)
    if not abierta.get("ok") or not en_ficha(pagina, factura):
        log(f"No he podido reabrir {factura}.")
        return False
    asegurar_fasttab_lineas(pagina)
    return True


def fila_a_borrar_fuera_de_albaranes(pagina, permitidos: set[str]):
    """
    Una línea que no pertenece a los ALBC pedidos.
    BC agrupa: comentario «Nº albarán ALBCxx» + artículos debajo (sin el nº).
    Hay que borrar el comentario ajeno Y sus artículos.
    """
    grid = rejilla_lineas(pagina)
    if grid is None:
        return None
    cabeceras = _cabeceras(grid)
    i_desc = _indice(cabeceras, COL_DESCRIPCION)
    i_alb = _indice(cabeceras, COL_ALBARAN)
    albaran_grupo = None
    for fila, celdas in filas_datos(grid):
        texto = " ".join(celdas)
        desc = celdas[i_desc] if i_desc is not None and i_desc < len(celdas) else texto
        alb_celda = ""
        if i_alb is not None and i_alb < len(celdas):
            alb_celda = celdas[i_alb] or ""
        cab = _albaran_cabecera_comentario(desc) or _albaran_cabecera_comentario(texto)
        if cab:
            albaran_grupo = cab
            if cab not in permitidos:
                return fila
            continue
        albs_fila = _albaranes_en_texto(texto) + _albaranes_en_texto(alb_celda)
        if albs_fila and any(a not in permitidos for a in albs_fila):
            return fila
        # Artículo bajo un grupo de albarán no pedido
        if albaran_grupo and albaran_grupo not in permitidos:
            if desc.strip() or any(celdas):
                return fila
    return None


def dejar_solo_albaranes_pedidos(pagina, factura: str, permitidos: list[str]) -> dict:
    """
    Tras Traer (aunque BC haya metido todo el proveedor), deja SOLO los ALBC pedidos.
    Borra comentarios y artículos de los demás. Si BC salta al inicio, reabre la ficha.
    """
    ok = {str(a or "").strip().upper() for a in (permitidos or []) if str(a or "").strip()}
    out = {"borradas": 0, "albaranes": [], "ok": False, "error": None}
    if not ok:
        out["error"] = "No hay albarán pedido."
        return out
    if not _asegurar_ficha_factura(pagina, factura):
        out["error"] = f"No estoy en la ficha {factura} para limpiar albaranes."
        out["albaranes"] = []
        captura(pagina, factura, "fuera_ficha_al_limpiar")
        return out
    for _ in range(60):
        if not _asegurar_ficha_factura(pagina, factura):
            out["error"] = f"He perdido la ficha {factura} al borrar líneas."
            out["albaranes"] = []
            captura(pagina, factura, "fuera_ficha_al_limpiar")
            return out
        asegurar_fasttab_lineas(pagina)
        fila = fila_a_borrar_fuera_de_albaranes(pagina, ok)
        if fila is None:
            break
        if not _eliminar_fila_linea(pagina, fila):
            out["error"] = "No he podido borrar una línea de albarán no pedido."
            if _asegurar_ficha_factura(pagina, factura):
                out["albaranes"] = albaranes_en_lineas(pagina)
            return out
        out["borradas"] += 1
        log(f"Quitada línea fuera de {', '.join(sorted(ok))} ({out['borradas']}).")
        # Tras borrar, comprobar que seguimos en la ficha (no en el inicio de BC).
        if not en_ficha(pagina, factura):
            log("Tras borrar una línea ya no estoy en la ficha; reabro.")
            if not _asegurar_ficha_factura(pagina, factura):
                out["error"] = f"Tras borrar, BC saltó al inicio y no he podido reabrir {factura}."
                captura(pagina, factura, "fuera_ficha_al_limpiar")
                return out
    if not _asegurar_ficha_factura(pagina, factura):
        out["error"] = f"Al acabar la limpieza no estoy en {factura}."
        captura(pagina, factura, "fuera_ficha_al_limpiar")
        return out
    if out["borradas"]:
        captura(pagina, factura, "albaranes_sobrantes_quitados")
    quedados = albaranes_en_lineas(pagina)
    out["albaranes"] = quedados
    de_mas = [a for a in quedados if a not in ok]
    faltan = [a for a in ok if a not in quedados]
    if de_mas:
        out["error"] = f"Tras limpiar siguen albaranes de más: {', '.join(de_mas)}."
        return out
    if faltan:
        out["error"] = f"No ha quedado el albarán pedido: {', '.join(faltan)}."
        return out
    out["ok"] = True
    return out


def quitar_lineas_albaranes_no_pedidos(pagina, factura: str, permitidos: list[str]) -> int:
    """Compat: delega en dejar_solo_albaranes_pedidos."""
    return dejar_solo_albaranes_pedidos(pagina, factura, permitidos).get("borradas") or 0


def aceptar_dialogo(pagina, dialogo) -> bool:
    """Aceptar del diálogo Traer líns. albarán (después de filtrar y seleccionar)."""
    # No confundir con un popup de filtro que aún estuviera abierto
    popup = _localizar_popup_filtro(pagina, 400)
    if popup is not None:
        log("Antes de Aceptar Traer, cierro el popup de filtro pendiente.")
        if not _aceptar_solo_popup_filtro(pagina, popup):
            return False
        dialogo = localizar_dialogo(pagina) or dialogo
    boton = buscar(pagina, re.compile(r"^Aceptar$|^OK$"), ("button",), dialogo)
    if boton is None and dialogo is not None:
        try:
            loc = dialogo.get_by_text(re.compile(r"^Aceptar$|^OK$", re.I))
            if loc.count() and loc.first.is_visible():
                boton = loc.first
        except Exception:
            boton = None
    if boton is None:
        return False
    try:
        boton.click(timeout=4000)
        log("Aceptar de «Traer líns. albarán»: OK.")
        return True
    except Exception as e:
        try:
            boton.click(timeout=4000, force=True)
            log("Aceptar de «Traer líns. albarán»: OK (force).")
            return True
        except Exception:
            log(f"No he podido pulsar Aceptar ({e}).")
            return False


def albaranes_en_lineas(pagina) -> list[str]:
    grid = rejilla_lineas(pagina)
    if grid is None:
        return []
    try:
        texto = grid.inner_text(timeout=2000) or ""
    except Exception:
        return []
    vistos = []
    for n in NUM_ALBARAN.findall(texto):
        n = n.upper()
        if n not in vistos:
            vistos.append(n)
    return vistos


def _parse_importe(texto: str) -> float | None:
    t = (texto or "").strip().replace(" ", "")
    if not t:
        return None
    if "," in t and "." in t:
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        t = t.replace(".", "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def total_factura_visible(pagina) -> float | None:
    """Lee el total visible en la ficha si BC lo muestra (no obligatorio)."""
    for marco in pagina.frames:
        try:
            texto = marco.inner_text("body", timeout=1200) or ""
        except Exception:
            continue
        hallados = TOTAL_FACTURA.findall(texto)
        for bruto in reversed(hallados):
            valor = _parse_importe(bruto)
            if valor is not None and valor > 0:
                return valor
    return None


def cancelar_dialogo(pagina, dialogo) -> None:
    if dialogo is None:
        return
    pulsar(pagina, re.compile(r"^Cancelar$"), ("button",), dialogo)


def traer_albaranes_en_pagina(
    pagina,
    numero_factura: str,
    numero_pedido: str,
    albaranes: list[str] | None = None,
) -> dict:
    factura = (numero_factura or "").strip()
    pedido = (numero_pedido or "").strip()
    albaranes_filtro = [str(a or "").strip().upper() for a in (albaranes or []) if str(a or "").strip()]
    t0 = time.time()
    resultado = {
        "ok": False,
        "factura": factura,
        "pedido": pedido,
        "lineasQuitadas": 0,
        "filasSeleccionadas": 0,
        "albaranes": [],
        "albaranesPedidos": albaranes_filtro,
        "total": None,
        "registrada": False,
        "error": None,
        "mensaje": None,
    }
    if not factura or not pedido:
        resultado["error"] = "Faltan el nº de factura y el nº de pedido."
        return resultado

    abierta = abrir_factura(pagina, factura)
    resultado["abrirVia"] = abierta.get("via")
    if not abierta.get("ok") or not en_ficha(pagina, factura):
        resultado["error"] = abierta.get("error") or f"No ha aparecido la factura {factura}."
        if abierta.get("controles"):
            resultado["controles"] = abierta["controles"]
        resultado["captura"] = captura(pagina, factura, "no_abre_factura")
        return resultado

    def _resultado_ya_ok(albs_ya: list[str]) -> dict:
        total = total_factura_visible(pagina)
        resultado["ok"] = True
        resultado["albaranes"] = albs_ya
        resultado["total"] = total
        resultado["via"] = "ya_tenía_albaranes"
        resultado["error"] = None
        total_txt = (
            f", total ≈ {total:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            if total is not None else ""
        )
        resultado["mensaje"] = (
            f"Borrador {factura} listo: {', '.join(albs_ya)} del pedido {pedido}{total_txt}. "
            "Queda Open (no registrado)."
        )
        log(resultado["mensaje"])
        return resultado

    def _factura_tiene_solo_pedidos() -> list[str] | None:
        """Si el borrador ya tiene exactamente los ALBC pedidos, los devuelve."""
        if not albaranes_filtro:
            return None
        asegurar_fasttab_lineas(pagina)
        pagina.wait_for_timeout(400)
        albs = albaranes_en_lineas(pagina)
        if not albs:
            return None
        if any(a not in albaranes_filtro for a in albs):
            return None
        if any(a not in albs for a in albaranes_filtro):
            return None
        return albs

    # Si ya hay exactamente los ALBC pedidos, no volver a Traer (evita duplicar).
    asegurar_fasttab_lineas(pagina)
    ya = albaranes_en_lineas(pagina)
    if not ya:
        # La rejilla a veces tarda un instante en pintar las líneas.
        pagina.wait_for_timeout(800)
        asegurar_fasttab_lineas(pagina)
        ya = albaranes_en_lineas(pagina)
    if ya:
        if albaranes_filtro:
            de_mas = [a for a in ya if a not in albaranes_filtro]
            faltan = [a for a in albaranes_filtro if a not in ya]
            # Solo borrar basura (ALBC que NO pedimos). Nunca borrar un ALBC
            # de otro pedido de la misma factura que sí está en la selección.
            if de_mas:
                log(f"El borrador tiene ALBC no pedidos ({', '.join(de_mas)}); limpio solo esos.")
                limpio = dejar_solo_albaranes_pedidos(pagina, factura, albaranes_filtro)
                resultado["lineasQuitadas"] = limpio.get("borradas") or 0
                if limpio.get("ok"):
                    ya = limpio.get("albaranes") or []
                    faltan = [a for a in albaranes_filtro if a not in ya]
                    de_mas = []
                else:
                    resultado["albaranes"] = limpio.get("albaranes") or ya
                    resultado["error"] = limpio.get("error") or (
                        f"El borrador tenía albaranes de más ({', '.join(de_mas)}) y no he podido limpiarlos."
                    )
                    resultado["captura"] = captura(pagina, factura, "albaranes_de_mas")
                    return resultado
            if not faltan and not de_mas:
                return _resultado_ya_ok(ya)
            # Ya hay parte de lo pedido (p. ej. 1.er pedido): solo faltan otros ALBC → Traer sin borrar.
            log(f"Faltan albaranes {', '.join(faltan)}; continúo a Traer (mantengo {', '.join(ya)}).")
        else:
            return _resultado_ya_ok(ya)

    try:
        resultado["lineasQuitadas"] = borrar_lineas_copiadas(pagina, factura)
    except Exception as e:
        resultado["error"] = f"No he podido quitar las líneas copiadas: {e}"
        resultado["captura"] = captura(pagina, factura, "error_quitar_lineas")
        return resultado

    # Con ALBC: UNA pasada Filtrar Nº documento = ALBC1|ALBC2 → marcar → Aceptar.
    # (Varias pasadas borraban el albarán del pedido anterior.)
    via = abrir_traer_albaranes(pagina, factura)
    if via and _cerrar_dialogo_equivocado(pagina):
        log("Reintento Traer tras cerrar el diálogo de contrato/suscripción.")
        via = abrir_traer_albaranes(pagina, factura)
    if not via:
        resultado["error"] = (
            "No encuentro «Traer líneas de recepción de proveedor» ni "
            "Línea > Acciones > Traer albaranes de compra."
        )
        resultado["controles"] = nombres_visibles(pagina)
        resultado["captura"] = captura(pagina, factura, "no_menu_traer_albaranes")
        return resultado
    resultado["via"] = via
    if not esperar_texto(pagina, TITULO_DIALOGO, 10):
        if _cerrar_dialogo_equivocado(pagina):
            resultado["error"] = (
                "Se abrió «Traer líneas de contrato de suscripción» en vez de "
                "«Traer líneas de recepción de proveedor». Revisa el ribbon."
            )
        else:
            resultado["error"] = "No se ha abierto el diálogo Traer líns. albarán."
        resultado["controles"] = nombres_visibles(pagina)
        resultado["captura"] = captura(pagina, factura, "no_dialogo_albaran")
        return resultado

    dialogo = localizar_dialogo(pagina)
    if dialogo is None:
        resultado["error"] = "No localizo el diálogo Traer líns. albarán (¿se abrió el de contrato?)."
        resultado["captura"] = captura(pagina, factura, "no_dialogo_albaran")
        _cerrar_dialogo_equivocado(pagina)
        return resultado

    if albaranes_filtro:
        # Solo traer los que aún faltan (si ya había alguno de la misma factura).
        ya_ahora = albaranes_en_lineas(pagina)
        faltan_ahora = [a for a in albaranes_filtro if a not in ya_ahora]
        a_traer = faltan_ahora or albaranes_filtro
        log(
            f"Traer albaranes: filtro Nº documento = {'|'.join(a_traer)} "
            f"→ seleccionar → Aceptar."
        )
        seleccionadas = seleccionar_albaranes(pagina, dialogo, a_traer)
        dialogo = localizar_dialogo(pagina) or dialogo
        resultado["filasSeleccionadas"] = max(seleccionadas, 0)

        if seleccionadas <= 0:
            cancelar_dialogo(pagina, dialogo)
            ya_ok = _factura_tiene_solo_pedidos()
            if ya_ok:
                log(
                    f"El filtro falló, pero el borrador ya tiene exactamente "
                    f"{', '.join(ya_ok)}. Lo doy por bueno."
                )
                return _resultado_ya_ok(ya_ok)
            if seleccionadas == -1:
                resultado["error"] = (
                    f"No he podido filtrar Nº documento = {'|'.join(a_traer)} en «Traer líns. albarán»."
                )
                resultado["captura"] = captura(pagina, factura, "no_filtra_albaran")
            elif seleccionadas == -2:
                resultado["error"] = (
                    f"Tras filtrar {'|'.join(a_traer)} el diálogo mostraba otros albaranes. "
                    "No acepto para no meter todo el proveedor."
                )
                resultado["captura"] = captura(pagina, factura, "filtro_albaran_incompleto")
            else:
                resultado["error"] = (
                    f"Tras filtrar Nº documento no aparecen las líneas de {'|'.join(a_traer)}."
                )
                resultado["captura"] = captura(pagina, factura, "sin_filas_pedido")
            return resultado
    else:
        if not filtrar_pedido(pagina, dialogo, pedido):
            cancelar_dialogo(pagina, dialogo)
            resultado["error"] = f"No he podido filtrar la columna Nº pedido a {pedido}."
            resultado["captura"] = captura(pagina, factura, "no_filtra_pedido")
            return resultado
        dialogo = localizar_dialogo(pagina) or dialogo
        seleccionadas = seleccionar_filas(pagina, dialogo, pedido, None)
        resultado["filasSeleccionadas"] = seleccionadas
        if seleccionadas <= 0:
            cancelar_dialogo(pagina, dialogo)
            ya2 = albaranes_en_lineas(pagina)
            if ya2:
                return _resultado_ya_ok(ya2)
            resultado["error"] = f"El diálogo no muestra albaranes del pedido {pedido}."
            resultado["captura"] = captura(pagina, factura, "sin_filas_pedido")
            return resultado

    dialogo = localizar_dialogo(pagina) or dialogo
    if not aceptar_dialogo(pagina, dialogo):
        cancelar_dialogo(pagina, dialogo)
        resultado["error"] = "No he podido pulsar Aceptar en Traer líns. albarán."
        resultado["captura"] = captura(pagina, factura, "no_aceptar")
        return resultado
    esperar_ocupado(pagina, 12)
    if localizar_dialogo(pagina):
        texto = ""
        try:
            texto = localizar_dialogo(pagina).inner_text(timeout=800) or ""
        except Exception:
            texto = ""
        if re.search(r"error|no se puede|already|ya se", texto, re.I):
            resultado["error"] = " ".join(texto.split())[:400]
            resultado["captura"] = captura(pagina, factura, "error_tras_aceptar")
            return resultado

    if not _asegurar_ficha_factura(pagina, factura):
        resultado["error"] = f"Tras Traer no estoy en la ficha {factura}."
        resultado["captura"] = captura(pagina, factura, "fuera_ficha_al_limpiar")
        return resultado

    albaranes = albaranes_en_lineas(pagina)
    # Seguridad: si aun así entró de más, limpiar; si el filtro fue bien, no hará falta.
    if albaranes_filtro:
        de_mas = [a for a in albaranes if a not in albaranes_filtro]
        if de_mas:
            log(f"Han entrado de más ({', '.join(de_mas)}); limpio dejando solo lo pedido.")
            limpio = dejar_solo_albaranes_pedidos(pagina, factura, albaranes_filtro)
            resultado["lineasQuitadas"] = (resultado.get("lineasQuitadas") or 0) + (limpio.get("borradas") or 0)
            albaranes = limpio.get("albaranes") or []
            if not limpio.get("ok"):
                resultado["albaranes"] = albaranes
                resultado["error"] = limpio.get("error") or (
                    f"Se pedía {', '.join(albaranes_filtro)} y siguen {', '.join(de_mas)}."
                )
                resultado["captura"] = captura(pagina, factura, "albaranes_de_mas")
                return resultado
        faltan = [a for a in albaranes_filtro if a not in albaranes]
        if faltan:
            resultado["albaranes"] = albaranes
            resultado["error"] = f"No ha quedado el albarán {', '.join(faltan)} en la factura."
            resultado["captura"] = captura(pagina, factura, "sin_albaran_pedido")
            return resultado

    total = total_factura_visible(pagina)
    resultado["albaranes"] = albaranes
    resultado["total"] = total
    resultado["captura"] = captura(pagina, factura, "factura_con_albaranes")
    if not albaranes:
        resultado["error"] = "Aceptar no ha dejado Nº albarán en las líneas de la factura."
        return resultado
    resultado["ok"] = True
    resultado["error"] = None
    total_txt = ""
    if total is not None:
        total_txt = f", total ≈ {total:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    resultado["mensaje"] = (
        f"Borrador {factura} listo: {', '.join(albaranes)} del pedido {pedido}{total_txt}. "
        f"Queda Open (no registrado). ({time.time() - t0:.0f}s)"
    )
    log(resultado["mensaje"])
    return resultado


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    albaranes_cli: list[str] = []
    pos: list[str] = []
    for a in args:
        if a.startswith("--albaranes="):
            albaranes_cli = [x.strip() for x in a.split("=", 1)[1].split(",") if x.strip()]
        else:
            pos.append(a)
    args = pos
    if len(args) < 2:
        log("Uso: python traer_albaranes_compra.py PFC26-003647 PC26-004163 [--albaranes=ALBC26-1,ALBC26-2]")
        print(json.dumps({"ok": False, "error": "Faltan el nº de factura y el nº de pedido."}, ensure_ascii=False))
        return 2
    factura, pedido = args[0].strip(), args[1].strip()
    if not CARPETA_PERFIL.exists():
        mensaje = "No está el perfil de Edge. Ejecuta primero: python bc_automation/login_setup.py"
        log(mensaje)
        print(json.dumps({"ok": False, "factura": factura, "pedido": pedido, "error": mensaje}, ensure_ascii=False))
        return 1

    resultado = {"ok": False, "factura": factura, "pedido": pedido, "error": "No se ha llegado a abrir Business Central."}
    try:
        liberar_perfil_edge()
        with sync_playwright() as p:
            contexto = p.chromium.launch_persistent_context(
                str(CARPETA_PERFIL),
                channel="msedge",
                headless=False,
                viewport=None,
                args=["--start-maximized"],
            )
            pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
            try:
                resultado = traer_albaranes_en_pagina(pagina, factura, pedido, albaranes_cli or None)
            finally:
                try:
                    contexto.close()
                except Exception:
                    pass
    except Exception as e:
        texto = str(e)
        if "existing browser session" in texto.lower() or "user data" in texto.lower() or "TargetClosed" in texto:
            texto = "El perfil de Edge está en uso. Cierra la ventana de bc_automation (servicio_registro.py) y vuelve a lanzar este script."
        resultado = {"ok": False, "factura": factura, "pedido": pedido, "registrada": False, "error": texto}
        log(texto)
    print(json.dumps(resultado, ensure_ascii=False))
    return 0 if resultado.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
