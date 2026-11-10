"""Una sola pasada: cierra diálogo equivocado si hace falta y trae albaranes.

No mata Edge en bucle. Si CDP 9222 ya responde, se conecta; si no, arranca Edge una vez.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

CARPETA = Path(__file__).parent
load_dotenv(CARPETA.parent / ".env")
PERFIL = CARPETA / "perfil_navegador"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CDP = 9222


def cdp_vivo() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP}/json/version", timeout=1.2) as r:
            return r.status == 200
    except Exception:
        return False


def esperar_cdp(segundos: float = 30) -> bool:
    fin = time.time() + segundos
    while time.time() < fin:
        if cdp_vivo():
            return True
        time.sleep(0.4)
    return False


def matar_solo_perfil_una_vez() -> None:
    """Una sola limpieza al inicio si no hay CDP (evita el lock). No se repite."""
    try:
        out = subprocess.check_output(
            ["wmic", "process", "where", "name='msedge.exe'", "get", "ProcessId,CommandLine", "/FORMAT:LIST"],
            text=True,
            errors="ignore",
        )
    except Exception:
        out = ""
    pid = None
    cmd = ""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("CommandLine="):
            cmd = line[len("CommandLine=") :]
        elif line.startswith("ProcessId="):
            pid = line[len("ProcessId=") :].strip()
            if pid and cmd and "perfil_navegador" in cmd.replace("/", "\\"):
                subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
            pid, cmd = None, ""
    for nombre in ("lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"):
        try:
            (PERFIL / nombre).unlink(missing_ok=True)
        except Exception:
            pass
    time.sleep(1.0)


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Uso: _run_traer_once.py PFC… PC…"}, ensure_ascii=False))
        return 2
    factura, pedido = sys.argv[1].strip(), sys.argv[2].strip()

    proc = None
    if not cdp_vivo():
        matar_solo_perfil_una_vez()
        proc = subprocess.Popen(
            [
                EDGE,
                f"--user-data-dir={PERFIL}",
                f"--remote-debugging-port={CDP}",
                "--no-first-run",
                "--no-default-browser-check",
                "--start-maximized",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not esperar_cdp():
            print(json.dumps({"ok": False, "error": "Edge no abrió CDP 9222."}, ensure_ascii=False))
            return 1
    else:
        print("Reutilizo Edge ya abierto en CDP 9222.", flush=True)

    from traer_albaranes_compra import (
        _cerrar_dialogo_equivocado,
        maximizar,
        traer_albaranes_en_pagina,
    )

    resultado = {"ok": False, "factura": factura, "pedido": pedido, "error": "sin resultado"}
    try:
        with sync_playwright() as p:
            navegador = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP}")
            contexto = navegador.contexts[0] if navegador.contexts else navegador.new_context()
            pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
            try:
                maximizar(pagina)
            except Exception:
                pass
            # Cierra «contrato de suscripción» si quedó abierto de un intento anterior.
            _cerrar_dialogo_equivocado(pagina)
            resultado = traer_albaranes_en_pagina(pagina, factura, pedido)
    except Exception as e:
        resultado = {"ok": False, "factura": factura, "pedido": pedido, "error": str(e)}
    print(json.dumps(resultado, ensure_ascii=False))
    return 0 if resultado.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
