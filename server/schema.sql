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

-- Usuarios locales (mirror ERP / SSO), igual que el resto de apps AC.
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  username TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  rol TEXT NOT NULL DEFAULT 'usuari',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  empresa TEXT,
  erp_id INT,
  auth_origen TEXT NOT NULL DEFAULT 'local',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'usuari';
ALTER TABLE usuarios ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS erp_id INT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auth_origen TEXT NOT NULL DEFAULT 'local';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codi_treballador TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_treballador TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nom_treballador TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_empresa TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_erp
  ON usuarios (erp_id, empresa) WHERE erp_id IS NOT NULL;
