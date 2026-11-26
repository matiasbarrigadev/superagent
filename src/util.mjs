// Utilidades chicas compartidas: ajustes clave/valor, teléfonos y JSON seguro.

export function crearAjustes(db) {
  const leer = db.prepare('SELECT valor FROM ajustes WHERE clave = ?');
  const escribir = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  return {
    get(clave, porDefecto = null) {
      const r = leer.get(clave);
      return r?.valor ?? porDefecto;
    },
    num(clave, porDefecto) {
      const v = Number(leer.get(clave)?.valor);
      return Number.isFinite(v) ? v : porDefecto;
    },
    bool(clave, porDefecto = false) {
      const v = leer.get(clave)?.valor;
      return v == null ? porDefecto : v === '1' || v === 'true';
    },
    set(clave, valor) {
      escribir.run(clave, valor == null ? null : String(valor));
    },
    todos() {
      return Object.fromEntries(db.prepare('SELECT clave, valor FROM ajustes').all().map((r) => [r.clave, r.valor]));
    },
  };
}

export const soloDigitos = (t) => String(t ?? '').replace(/\D/g, '');

/** Dos teléfonos son el mismo si coinciden en los últimos 10 dígitos (cubre el "9" de los móviles argentinos y similares). */
export function mismoTelefono(a, b) {
  const x = soloDigitos(a), y = soloDigitos(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}

/** Teléfono del JID "<num>@c.us" (no sirve para @lid ni grupos). */
export function telefonoDeJid(jid) {
  const m = /^(\d+)@c\.us$/.exec(String(jid ?? ''));
  return m ? m[1] : null;
}

export function json(texto, porDefecto = null) {
  if (texto == null) return porDefecto;
  try { return JSON.parse(texto); } catch { return porDefecto; }
}

export const esGrupo = (jid) => /@g\.us$/.test(String(jid ?? ''));
export const esPanel = (jid) => String(jid ?? '').startsWith('panel:');
