// Verificación del número personal del Propietario: el gateway le manda un código por WhatsApp
// y el Propietario lo escribe en el panel. Solo con el número verificado valen sus órdenes por WhatsApp.
import crypto from 'node:crypto';
import { soloDigitos } from '../util.mjs';
import { auditar } from '../db/index.mjs';

export class ErrorVerificacion extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function crearVerificacion({ db, waha, numeroVinculado = () => false, alVerificarPorVinculo = () => {}, reloj = () => Date.now() }) {
  /**
   * El número del Propietario es el mismo que tiene vinculado el agente: quien escaneó el QR ya tiene ese teléfono,
   * así que queda verificado sin mandarse un código a sí mismo.
   */
  function verificarPorVinculo(personaId, tel) {
    aplicar({ id: null, telefono: tel }, personaId);
    auditar(db, 'persona.verificar_por_vinculo', { actor: String(personaId) });
    try { alVerificarPorVinculo(personaId, tel); } catch {}
    return { telefono: tel, verificado: true, personal: true };
  }

  async function pedir(personaId, telefono) {
    const tel = soloDigitos(telefono);
    if (tel.length < 8 || tel.length > 15) throw new ErrorVerificacion('Número inválido: escribilo con código de país, solo dígitos.');
    const otra = db.prepare('SELECT id FROM personas WHERE id != ? AND alta_manual = 1 AND activa = 1 AND (telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)))').get(personaId, tel, tel);
    if (otra) throw new ErrorVerificacion('Ese número ya es de otra persona dada de alta.', 409);
    if (numeroVinculado(tel)) return verificarPorVinculo(personaId, tel);
    const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare('DELETE FROM verificaciones WHERE persona_id = ?').run(personaId);
    db.prepare('INSERT INTO verificaciones (persona_id, telefono, hash, vence) VALUES (?, ?, ?, ?)').run(personaId, tel, sha(codigo), reloj() + 10 * 60_000);
    await waha.enviarTexto(`${tel}@c.us`, `Tu código de Superagent es ${codigo}. Escribilo en el panel para verificar este número. Vence en 10 minutos.`);
    return { enviado: true };
  }

  function confirmar(personaId, codigo) {
    const v = db.prepare('SELECT * FROM verificaciones WHERE persona_id = ?').get(personaId);
    if (!v || v.vence < reloj()) throw new ErrorVerificacion('No hay un código vigente. Pedí uno nuevo.', 410);
    // El código de modo "respuesta" se ve en el panel: solo vale si llega desde el teléfono, por WhatsApp.
    if (v.modo === 'respuesta') throw new ErrorVerificacion('Respóndele al agente por WhatsApp con este código.', 409);
    if (v.intentos >= 5) throw new ErrorVerificacion('Demasiados intentos. Pedí un código nuevo.', 429);
    const dado = Buffer.from(sha(soloDigitos(codigo)));
    if (!crypto.timingSafeEqual(dado, Buffer.from(v.hash))) {
      db.prepare('UPDATE verificaciones SET intentos = intentos + 1 WHERE id = ?').run(v.id);
      throw new ErrorVerificacion('El código no coincide.', 401);
    }
    return aplicar(v, personaId);
  }

  function aplicar(v, personaId) {
    db.exec('BEGIN');
    try {
      // Si ese número ya había escrito sin alta, su historial pasa a esta persona.
      const auto = db.prepare('SELECT id FROM personas WHERE id != ? AND alta_manual = 0 AND (telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)))').all(personaId, v.telefono, v.telefono);
      for (const a of auto) {
        db.prepare('UPDATE mensajes SET persona_id = ? WHERE persona_id = ?').run(personaId, a.id);
        db.prepare('UPDATE chats SET persona_id = ? WHERE persona_id = ?').run(personaId, a.id);
        db.prepare("UPDATE memoria SET alcance_id = ? WHERE alcance = 'contacto' AND alcance_id = ?").run(personaId, a.id);
        db.prepare('UPDATE personas SET lid = COALESCE((SELECT lid FROM personas WHERE id = ?), lid) WHERE id = ?').run(a.id, personaId);
        db.prepare('DELETE FROM persona_cliente WHERE persona_id = ?').run(a.id);
        db.prepare('UPDATE personas SET activa = 0, telefono = NULL, lid = NULL WHERE id = ?').run(a.id);
      }
      db.prepare('UPDATE personas SET telefono = ?, verificada = 1, alta_manual = 1 WHERE id = ?').run(v.telefono, personaId);
      if (v.id) db.prepare('DELETE FROM verificaciones WHERE id = ?').run(v.id);
      else db.prepare('DELETE FROM verificaciones WHERE persona_id = ?').run(personaId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    auditar(db, 'persona.verificar_numero', { actor: String(personaId) });
    return { telefono: v.telefono };
  }

  // --- Onboarding por WhatsApp: el número se carga antes de vincular. Al vincular, el agente le escribe y el
  // Propietario confirma respondiendo con el código que ve en el panel. Así queda probado que tiene el teléfono
  // y el acceso al panel (alguien que reciba el saludo por error no puede volverse Propietario).
  const SALUDO = '¡Hola! Soy tu nuevo agente de WhatsApp. Para confirmar que este número es tuyo, respóndeme con el código de 6 dígitos que ves en el panel.';

  function validarTelefono(personaId, telefono) {
    const tel = soloDigitos(telefono);
    if (tel.length < 8 || tel.length > 15) throw new ErrorVerificacion('Número inválido: escríbelo con código de país, solo dígitos.');
    const otra = db.prepare('SELECT id FROM personas WHERE id != ? AND alta_manual = 1 AND activa = 1 AND (telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)))').get(personaId, tel, tel);
    if (otra) throw new ErrorVerificacion('Ese número ya es de otra persona dada de alta.', 409);
    return tel;
  }

  /** Guarda el número y devuelve el código para mostrar en el panel. Si WhatsApp ya está vinculado, saluda. */
  async function pedirPorRespuesta(personaId, telefono, { conectado = false } = {}) {
    const tel = validarTelefono(personaId, telefono);
    if (numeroVinculado(tel)) return verificarPorVinculo(personaId, tel);
    const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare('DELETE FROM verificaciones WHERE persona_id = ?').run(personaId);
    const id = Number(db.prepare("INSERT INTO verificaciones (persona_id, telefono, hash, vence, modo) VALUES (?, ?, ?, ?, 'respuesta')")
      .run(personaId, tel, sha(codigo), reloj() + 24 * 3_600_000).lastInsertRowid);
    let enviado = false;
    if (conectado) enviado = await saludar({ id, telefono: tel });
    return { telefono: tel, codigo, enviado };
  }

  async function saludar(v) {
    try {
      await waha.enviarTexto(`${v.telefono}@c.us`, SALUDO);
      db.prepare('UPDATE verificaciones SET saludado = 1 WHERE id = ?').run(v.id);
      return true;
    } catch { return false; }
  }

  /** Al vincular WhatsApp: saluda a los números cargados que todavía esperan. */
  async function saludarPendientes() {
    const filas = db.prepare("SELECT id, persona_id, telefono FROM verificaciones WHERE modo = 'respuesta' AND saludado = 0 AND vence > ?").all(reloj());
    let n = 0;
    for (const v of filas) {
      // El número cargado es el mismo que se acaba de vincular: no se saluda a sí mismo, queda verificado.
      if (numeroVinculado(v.telefono)) { verificarPorVinculo(v.persona_id, v.telefono); n++; continue; }
      if (await saludar(v)) n++;
    }
    return n;
  }

  /** Número esperando confirmación (para el panel). */
  function pendiente(personaId) {
    const v = db.prepare("SELECT telefono, vence, saludado FROM verificaciones WHERE persona_id = ? AND modo = 'respuesta' AND vence > ?").get(personaId, reloj());
    return v ? { telefono: v.telefono, saludado: !!v.saludado } : null;
  }

  /**
   * Un mensaje directo que llega: si es la respuesta con el código de un número que espera confirmación,
   * lo confirma y devuelve el id del Propietario. Si no, null (y el mensaje sigue su camino normal).
   */
  function porRespuesta({ telefono, cuerpo }) {
    const tel = soloDigitos(telefono);
    if (!tel) return null;
    const v = db.prepare(`SELECT * FROM verificaciones WHERE modo = 'respuesta' AND vence > ?
      AND (telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)))`).get(reloj(), tel, tel);
    if (!v || v.intentos >= 5) return null;
    const m = /(?:^|\D)(\d{3})[\s-]?(\d{3})(?:\D|$)/.exec(String(cuerpo ?? ''));
    if (!m) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sha(m[1] + m[2])), Buffer.from(v.hash))) {
      db.prepare('UPDATE verificaciones SET intentos = intentos + 1 WHERE id = ?').run(v.id);
      return null;
    }
    aplicar(v, v.persona_id);
    return v.persona_id;
  }

  return { pedir, confirmar, pedirPorRespuesta, saludarPendientes, pendiente, porRespuesta, verificarPorVinculo };
}
