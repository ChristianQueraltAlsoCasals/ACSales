-- Esquema ACSales. Idempotente: se ejecuta entero en cada arranque.

CREATE TABLE IF NOT EXISTS app_state (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_state_clave_prefix
  ON app_state (clave text_pattern_ops);

COMMENT ON TABLE app_state IS
  'Documentos JSON. estado.bcData.<fuente> = caché BC partida (límite JSONB ~256MB); '
  'estado.fichas / resumen / otFiles; recepcion, avisos, atributos, registro_facturas_compra.';
