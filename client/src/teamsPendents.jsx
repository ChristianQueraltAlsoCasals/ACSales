/**
 * teamsPendents.jsx — Campana + bandeja d'OK de tasques de Teams (català).
 * Només mostra tasques detectades; no conversa. OK / No a ACsales.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Bell, RefreshCw, Check, X, ExternalLink, Building2 } from "lucide-react";

export default function TeamsPendentsCampana() {
  const [obert, setObert] = useState(false);
  const [items, setItems] = useState([]);
  const [pendents, setPendents] = useState(0);
  const [carregant, setCarregant] = useState(false);
  const [syncant, setSyncant] = useState(false);
  const [error, setError] = useState(null);
  const [pista, setPista] = useState(null);
  const [msg, setMsg] = useState(null);

  const carregar = useCallback(async () => {
    setCarregant(true);
    setError(null);
    try {
      const r = await fetch("/api/teams-bot/pendents?estat=pendent");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Error llegint pendents");
      setItems(d.items || []);
      setPendents(d.pendents || 0);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setCarregant(false);
    }
  }, []);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 45000);
    return () => clearInterval(t);
  }, [carregar]);

  const sync = async () => {
    setSyncant(true);
    setError(null);
    setPista(null);
    setMsg(null);
    try {
      const r = await fetch("/api/teams-bot/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Sync fallit");
        if (d.pista) setPista(d.pista);
        return;
      }
      setMsg(
        (d.nous ? d.nous + " tasca(es) nova(es). " : "Cap tasca nova. ") +
          (d.pendents != null ? d.pendents + " pendent(s)." : "")
      );
      await carregar();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSyncant(false);
    }
  };

  const decidir = async (id, decisio) => {
    setMsg(null);
    setError(null);
    try {
      const r = await fetch("/api/teams-bot/decidir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decisio }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "No s'ha pogut desar la decisió");
      if (decisio === "ok") {
        if (d.enviatTeams) setMsg("OK · avís enviat a Teams com a chatbot de Maria.");
        else {
          setMsg(
            "OK desat. No s'ha pogut enviar a Teams" +
              (d.errorEnviament ? ": " + d.errorEnviament : ".") +
              (d.item?.respostaProposada
                ? " Resposta proposada a la consola / detall."
                : "")
          );
          if (d.item?.respostaProposada) {
            try {
              console.info("[teams-bot] Resposta proposada:\n", d.item.respostaProposada);
            } catch { /* ignore */ }
          }
        }
      } else {
        setMsg("Rebutjat. No s'ha enviat res a Teams.");
      }
      await carregar();
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setObert((v) => !v);
          carregar();
        }}
        className="bc-topbar-logout"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, position: "relative" }}
        title="Pendents d'OK · Teams"
        aria-label="Pendents d'OK de Teams"
      >
        <Bell size={16} strokeWidth={1.75} />
        <span className="hidden sm:inline">Teams</span>
        {pendents > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: "#dc2626",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "16px",
              textAlign: "center",
            }}
          >
            {pendents > 9 ? "9+" : pendents}
          </span>
        )}
      </button>

      {obert && (
        <div
          className="absolute right-0 mt-2 z-[80] w-[min(420px,92vw)] bg-white border border-slate-200 rounded-lg shadow-xl text-slate-800"
          style={{ maxHeight: "70vh", overflow: "auto" }}
        >
          <div className="sticky top-0 bg-white border-b border-slate-100 px-3 py-2 flex items-center gap-2">
            <div className="text-[13px] font-semibold flex-1">Pendents d&apos;OK · Teams</div>
            <button
              type="button"
              onClick={sync}
              disabled={syncant}
              className="text-[12px] px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-1"
              title="Actualitzar des de Teams"
            >
              <RefreshCw size={12} className={syncant ? "animate-spin" : ""} />
              Actualitzar
            </button>
            <button type="button" onClick={() => setObert(false)} className="p-1 text-slate-400 hover:text-slate-700">
              <X size={14} />
            </button>
          </div>

          <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-slate-50">
            Només tasques de feina. Equips Ferros → FerrosCA; resta → Also Casals. No respon converses ni temes personals.
          </div>

          {error && (
            <div className="mx-3 mt-2 text-[12px] text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {error}
              {pista && <div className="mt-1 text-red-700/80">{pista}</div>}
            </div>
          )}
          {msg && (
            <div className="mx-3 mt-2 text-[12px] text-green-800 bg-green-50 border border-green-200 rounded px-2 py-1.5">
              {msg}
            </div>
          )}

          <div className="p-3 space-y-2">
            {carregant && !items.length && (
              <div className="text-[13px] text-slate-400">Carregant…</div>
            )}
            {!carregant && !items.length && (
              <div className="text-[13px] text-slate-400">
                Cap tasca pendent. Prem «Actualitzar» per llegir Teams.
              </div>
            )}
            {items.map((it) => (
              <div key={it.id} className="border border-slate-200 rounded-md p-2.5 bg-slate-50/50">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold text-slate-800 truncate">
                      {it.topic || "Xat"}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {it.de}
                      {it.creat
                        ? " · " +
                          new Date(it.creat).toLocaleString("ca-ES", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
                    </div>
                  </div>
                  <span
                    className={
                      "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border " +
                      (it.empresa === "ferros"
                        ? "bg-amber-50 text-amber-900 border-amber-200"
                        : "bg-blue-50 text-blue-900 border-blue-200")
                    }
                    title="Empresa destinació"
                  >
                    <Building2 size={10} />
                    {it.empresa === "ferros" ? "FerrosCA" : "Also Casals"}
                  </span>
                </div>
                <div className="mt-2 text-[12px] text-slate-700 whitespace-pre-wrap break-words">
                  {it.resum || it.text}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => decidir(it.id, "ok")}
                    className="text-[12px] font-semibold px-2.5 py-1 rounded bg-green-600 text-white hover:bg-green-700 inline-flex items-center gap-1"
                  >
                    <Check size={13} /> OK
                  </button>
                  <button
                    type="button"
                    onClick={() => decidir(it.id, "no")}
                    className="text-[12px] font-semibold px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-white inline-flex items-center gap-1"
                  >
                    <X size={13} /> No
                  </button>
                  {it.webUrl && (
                    <a
                      href={it.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-[11px] text-blue-700 hover:underline inline-flex items-center gap-1"
                    >
                      Obrir a Teams <ExternalLink size={11} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
