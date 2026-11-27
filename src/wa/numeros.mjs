// Números de WhatsApp de la instalación (sesiones de WAHA) y la política de cada uno.
//
// La política la define el Propietario conversando con el agente: se guarda su texto (lo que pidió, con sus
// palabras) y un resumen mínimo estructurado. Del resumen, el gateway hace cumplir solo lo que es autoridad o
// privacidad: si ese número puede enviar (responder / solo leer / solo avisos / nada), si puede escribir primero,
// qué chats entran y se guardan (y cuánto tiempo) y qué conectores se usan ahí. Todo lo demás —detectar conflictos
// entre números, interpretar lo que quiere el Propietario, decidir si responder en un chat compartido— es del
// modelo: acá solo se le dan los datos (qué números ven cada chat, quién quedó elegido para responder).
//
// El número principal arranca con la política de siempre; uno nuevo arranca mudo hasta que lo configuren.
import { auditar } from '../db/index.mjs';
import { json, esGrupo, esPanel } from '../util.mjs';

export const MODOS = {
  responder: 'responde como siempre (según el rol de cada persona)',
  leer: 'solo lee: el gateway bloquea cualquier envío por este número',
  avisos: 'no responde; solo puede mandarles avisos a los Propietarios',
  nada: 'no hace nada: no responde ni envía',
};
export const ALCANCES_CHATS = {
  todos: 'todos los chats',
  grupos: 'solo grupos',
  directos: 'solo chats directos',
  clientes: 'solo chats ligados a un cliente',
  lista: 'solo los chats de la lista',
  ninguno: 'ningún chat',
};
export const POLITICA_PRINCIPAL = { texto: 'El número principal: responde como siempre, según el rol de cada persona.', modo: 'responder', chats: 'todos', lista: [], excluir: [], guardar: true, dias: null, escribir_primero: 'segun_rol', conectores: null, notas: '' };
// El WhatsApp personal del Propietario usado como número del agente: cerrado por defecto. Solo "Mensaje a ti mismo"
// es para hablar con el agente; en el resto no responde ni guarda nada hasta que el Propietario habilite chats.
export const POLITICA_PERSONAL = { texto: 'Es el WhatsApp personal del Propietario. Me habla desde "Mensaje a ti mismo"; en sus otros chats no respondo ni guardo nada hasta que me diga cuáles habilitar, y lo que él escribe a mano nunca es una orden.', modo: 'responder', chats: 'lista', lista: [], excluir: [], guardar: true, dias: null, escribir_primero: 'no', conectores: null, notas: '' };
export const POLITICA_MUDA = { texto: '', modo: 'nada', chats: 'ninguno', lista: [], excluir: [], guardar: false, dias: null, escribir_primero: 'no', conectores: null, notas: '' };

const NOMBRE = /^[a-z0-9][a-z0-9-]{1,29}$/;

/** Completa y valida una política (lo que falte, del default seguro). Tira un error legible si algo no vale. */
export function normalizarPolitica(p, base = POLITICA_MUDA) {
  const x = { ...base, ...(p ?? {}) };
  if (!MODOS[x.modo]) throw Object.assign(new Error(`Modo inválido: ${x.modo}. Opciones: ${Object.keys(MODOS).join(', ')}.`), { status: 400 });
  if (!ALCANCES_CHATS[x.chats]) throw Object.assign(new Error(`Chats inválido: ${x.chats}. Opciones: ${Object.keys(ALCANCES_CHATS).join(', ')}.`), { status: 400 });
  x.lista = [...new Set((Array.isArray(x.lista) ? x.lista : []).map(String).filter(Boolean))];
  x.excluir = [...new Set((Array.isArray(x.excluir) ? x.excluir : []).map(String).filter(Boolean))];
  // Para responder hay que guardar: el agente necesita la charla.
  x.guardar = x.modo === 'responder' ? true : !!x.guardar;
  x.dias = x.dias == null || x.dias === '' ? null : Math.max(1, Math.min(3650, Math.round(Number(x.dias)) || 1));
  x.escribir_primero = x.modo === 'responder' && x.escribir_primero !== 'no' ? 'segun_rol' : 'no';
  x.conectores = Array.isArray(x.conectores) ? x.conectores.map(String) : null;
  x.notas = String(x.notas ?? '').slice(0, 1000);
  x.texto = String(x.texto ?? '').slice(0, 2000);
  x.personal_de = x.personal_de ? Number(x.personal_de) || null : null;
  return x;
}

export function crearNumeros({ db, principal, nombrePrincipal = 'default', crearCliente = null, bitacora = null, reloj = () => Date.now(), log = console }) {
  const clientes = new Map([[nombrePrincipal, principal]]);
  const fila = (nombre) => db.prepare('SELECT * FROM sesiones_wa WHERE nombre = ?').get(nombre);
  const conPolitica = (f) => (f ? { ...f, principal: !!f.principal, politica: normalizarPolitica(json(f.politica, {}), f.principal ? POLITICA_PRINCIPAL : POLITICA_MUDA) } : null);

  /** El principal siempre existe, con la política de siempre la primera vez. */
  function asegurarPrincipal() {
    db.prepare(`INSERT INTO sesiones_wa (nombre, etiqueta, principal, politica, creada) VALUES (?, 'principal', 1, ?, ?)
      ON CONFLICT(nombre) DO UPDATE SET principal = 1`).run(nombrePrincipal, JSON.stringify(POLITICA_PRINCIPAL), reloj());
  }
  asegurarPrincipal();

  const obtener = (nombre) => conPolitica(fila(nombre ?? nombrePrincipal));
  const listar = () => db.prepare('SELECT * FROM sesiones_wa ORDER BY principal DESC, creada').all().map(conPolitica);
  const varios = () => db.prepare('SELECT COUNT(*) AS n FROM sesiones_wa').get().n > 1;
  /** Política de un número; uno que no está registrado (llegó de WAHA sin alta) es mudo. */
  const politicaDe = (nombre) => obtener(nombre)?.politica ?? POLITICA_MUDA;

  function cliente(nombre) {
    const n = nombre ?? nombrePrincipal;
    if (!clientes.has(n)) {
      if (!crearCliente) throw Object.assign(new Error('Esta instalación maneja un solo número.'), { status: 409 });
      clientes.set(n, crearCliente(n));
    }
    return clientes.get(n);
  }

  /** Alta de un número nuevo: queda mudo hasta que un Propietario lo configure. */
  async function crear({ nombre, etiqueta }) {
    const n = String(nombre ?? '').trim().toLowerCase();
    if (!NOMBRE.test(n)) throw Object.assign(new Error('El nombre va en minúsculas, números y guiones (por ejemplo "personal" o "ventas-2").'), { status: 400 });
    if (fila(n)) throw Object.assign(new Error('Ya hay un número con ese nombre.'), { status: 409 });
    db.prepare('INSERT INTO sesiones_wa (nombre, etiqueta, principal, politica, creada) VALUES (?, ?, 0, ?, ?)')
      .run(n, String(etiqueta ?? n).slice(0, 60), JSON.stringify(POLITICA_MUDA), reloj());
    auditar(db, 'whatsapp.numero.crear', { detalle: { nombre: n } });
    try { await cliente(n).asegurar(); } catch (e) { log.warn('[whatsapp]', n, e.message); }
    return n;
  }

  async function borrar(nombre) {
    const f = fila(nombre);
    if (!f) throw Object.assign(new Error('Ese número no existe.'), { status: 404 });
    if (f.principal) throw Object.assign(new Error('El número principal no se borra (se puede desvincular).'), { status: 409 });
    try { await cliente(nombre).borrar?.(); } catch (e) { log.warn('[whatsapp]', nombre, e.message); }
    clientes.delete(nombre);
    db.prepare('DELETE FROM sesiones_wa WHERE nombre = ?').run(nombre);
    db.prepare('DELETE FROM chat_sesiones WHERE sesion = ?').run(nombre);
    db.prepare('UPDATE chats SET sesion_responde = NULL WHERE sesion_responde = ?').run(nombre);
    auditar(db, 'whatsapp.numero.borrar', { detalle: { nombre } });
  }

  /** El chat "Mensaje a ti mismo" de un número (su propio teléfono), o null si todavía no se sabe. */
  function chatPropio(nombre) {
    const n = fila(nombre ?? nombrePrincipal)?.numero;
    return n ? `${n}@c.us` : null;
  }

  /**
   * El número vinculado es el WhatsApp personal de un Propietario: queda en modo personal cerrado (sobre lo que
   * ya hubiera configurado, solo se cierra lo que estaba abierto a todos). Devuelve true si recién se marcó.
   */
  function marcarPersonal(nombre, personaId) {
    const f = obtener(nombre);
    if (!f || f.politica.personal_de === personaId) return false;
    const abierta = f.politica.chats === 'todos' || f.politica.modo === 'nada';
    const p = normalizarPolitica(abierta ? { ...POLITICA_PERSONAL, personal_de: personaId } : { ...f.politica, personal_de: personaId, escribir_primero: 'no' }, POLITICA_MUDA);
    db.prepare('UPDATE sesiones_wa SET politica = ?, actualizada = ? WHERE nombre = ?').run(JSON.stringify(p), reloj(), nombre);
    auditar(db, 'whatsapp.numero.personal', { detalle: { nombre, persona: personaId } });
    bitacora?.anotar?.({ personaId, donde: 'sistema', resultado: 'hecho', que: `el número "${f.etiqueta ?? nombre}" es el WhatsApp personal del Propietario: queda en modo personal cerrado` });
    return true;
  }

  /** Sesión cuyo número es este teléfono (para saber si un Propietario es "el mismo WhatsApp" que el agente). */
  function sesionDeTelefono(tel) {
    const t = String(tel ?? '').replace(/\D/g, '');
    if (t.length < 8) return null;
    return db.prepare("SELECT nombre FROM sesiones_wa WHERE numero IS NOT NULL AND (numero = ? OR (length(numero) >= 10 AND substr(numero, -10) = substr(?, -10)))").get(t, t)?.nombre ?? null;
  }

  /** Guarda el número de teléfono vinculado. Devuelve true si es la primera vez (para avisar a los Propietarios). */
  function anotarNumero(nombre, me) {
    const tel = String(me?.id ?? '').replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, '');
    const f = fila(nombre);
    if (!tel || !f || f.numero === tel) return false;
    db.prepare('UPDATE sesiones_wa SET numero = ? WHERE nombre = ?').run(tel, nombre);
    return !f.numero;
  }

  /** Teléfonos propios de la instalación (los mensajes de un número propio no despiertan al agente en el otro). */
  const numerosPropios = () => new Set(db.prepare('SELECT numero FROM sesiones_wa WHERE numero IS NOT NULL').all().map((r) => r.numero));

  /** ¿Este chat entra por este número? Lo que no entra no se guarda ni despierta a nadie. */
  function enAlcance(nombre, chatId) {
    const p = politicaDe(nombre);
    // En el número personal del Propietario, "Mensaje a ti mismo" es su canal con el agente: siempre entra.
    if (p.personal_de && chatId === chatPropio(nombre)) return true;
    if (p.excluir.includes(chatId)) return false;
    switch (p.chats) {
      case 'todos': return true;
      case 'grupos': return esGrupo(chatId);
      case 'directos': return !esGrupo(chatId);
      case 'clientes': { const c = db.prepare('SELECT cliente_id FROM chats WHERE id = ?').get(chatId); return !!c && c.cliente_id != null && c.cliente_id !== 1; }
      case 'lista': return p.lista.includes(chatId);
      default: return false;
    }
  }

  function contarFuera(nombre) { db.prepare('UPDATE sesiones_wa SET fuera_de_alcance = fuera_de_alcance + 1 WHERE nombre = ?').run(nombre); }

  function verChat(chatId, nombre) {
    db.prepare(`INSERT INTO chat_sesiones (chat_id, sesion, visto) VALUES (?, ?, ?)
      ON CONFLICT(chat_id, sesion) DO UPDATE SET visto = excluded.visto`).run(chatId, nombre, reloj());
  }

  const respondenEn = (chatId) => db.prepare('SELECT sesion FROM chat_sesiones WHERE chat_id = ? ORDER BY visto DESC').all(chatId)
    .map((r) => r.sesion).filter((s) => politicaDe(s).modo === 'responder' && enAlcance(s, chatId));

  /**
   * Por qué número sale algo para este chat: el que eligió el Propietario, o el último que lo vio y puede
   * responder. Para un chat que todavía no vio nadie (escribir primero), el principal; con `soloVistos`, null.
   */
  function sesionPara(chatId, { soloVistos = false } = {}) {
    const elegido = db.prepare('SELECT sesion_responde FROM chats WHERE id = ?').get(chatId)?.sesion_responde;
    if (elegido) return elegido;
    const r = respondenEn(chatId);
    if (r.length) return r[0];
    return soloVistos ? null : nombrePrincipal;
  }

  /**
   * ¿Algún número que ve este chat puede responder ahí? Si no, el mensaje es solo contexto (no despierta al
   * agente). Es autoridad: un chat que solo ve un número de solo lectura nunca se contesta por otro número.
   */
  function puedeResponder(chatId) {
    const s = sesionPara(chatId, { soloVistos: true });
    return !!s && politicaDe(s).modo === 'responder' && enAlcance(s, chatId);
  }

  const esChatDePropietario = (chatId) => !!db.prepare(`SELECT 1 FROM personas p JOIN roles r ON r.id = p.rol_id
    WHERE r.nombre = 'Propietario' AND r.predefinido = 1 AND p.activa = 1 AND p.telefono IS NOT NULL AND ? = p.telefono || '@c.us'`).get(chatId);

  /** El control real de la salida: lo que la política no permite no sale, aunque el agente lo pida. */
  function puedeEnviar(nombre, chatId, { contactoNuevo = false } = {}) {
    if (esPanel(chatId)) return { ok: true };
    const f = obtener(nombre);
    if (!f) return { ok: false, motivo: `El número "${nombre}" no existe.` };
    const p = f.politica;
    if (p.modo === 'leer' || p.modo === 'nada') return { ok: false, motivo: `El número "${f.etiqueta ?? nombre}" está en modo ${p.modo === 'leer' ? 'solo lectura' : 'sin actividad'}: no envía nada.` };
    if (p.modo === 'avisos') return esChatDePropietario(chatId) ? { ok: true } : { ok: false, motivo: `El número "${f.etiqueta ?? nombre}" solo manda avisos a los Propietarios.` };
    if (contactoNuevo && p.escribir_primero === 'no') return { ok: false, motivo: `El número "${f.etiqueta ?? nombre}" no escribe primero.` };
    if (!enAlcance(nombre, chatId) && !esChatDePropietario(chatId)) return { ok: false, motivo: `Ese chat no entra en lo que maneja el número "${f.etiqueta ?? nombre}".` };
    return { ok: true };
  }

  /** Borra los mensajes viejos de los números que guardan por un tiempo. */
  function limpiar() {
    let n = 0;
    for (const f of listar()) {
      if (!f.politica.dias) continue;
      n += db.prepare("DELETE FROM mensajes WHERE session = ? AND canal = 'whatsapp' AND recibido < ?").run(f.nombre, reloj() - f.politica.dias * 86_400_000).changes;
    }
    return n;
  }

  /** Datos (sin veredicto): chats que ven varios números, quién puede responder en cada uno y quién quedó elegido. */
  function compartidos(limite = 30) {
    return db.prepare('SELECT chat_id FROM chat_sesiones GROUP BY chat_id HAVING COUNT(*) > 1 ORDER BY MAX(visto) DESC LIMIT ?').all(limite).map(({ chat_id: c }) => {
      const chat = db.prepare('SELECT nombre, sesion_responde FROM chats WHERE id = ?').get(c);
      const ven = db.prepare('SELECT sesion FROM chat_sesiones WHERE chat_id = ?').all(c).map((r) => r.sesion);
      return { chat: c, nombre: chat?.nombre ?? null, ven, pueden_responder: ven.filter((s) => politicaDe(s).modo === 'responder' && enAlcance(s, c)), elegido: chat?.sesion_responde ?? null };
    });
  }

  /** Chats que ve un número (para la herramienta de consulta). */
  const chatsDe = (nombre, limite = 50) => db.prepare(`SELECT cs.chat_id AS chat, c.nombre, c.tipo, c.cliente_id, cs.visto FROM chat_sesiones cs LEFT JOIN chats c ON c.id = cs.chat_id
    WHERE cs.sesion = ? ORDER BY cs.visto DESC LIMIT ?`).all(nombre, limite);

  /** Ficha de un número con su política: lo que hace cumplir el gateway y lo que queda como instrucción. */
  function ficha(nombre, politica) {
    const f = obtener(nombre);
    const p = normalizarPolitica(politica, f?.politica ?? POLITICA_MUDA);
    const lineas = [`Número "${f?.etiqueta ?? nombre}"${f?.numero ? ` (+${f.numero})` : ' (sin vincular todavía)'}:`];
    if (p.texto) lineas.push(`- Lo que pediste: "${p.texto}"`);
    lineas.push(`- Qué hace: ${MODOS[p.modo]}.`);
    lineas.push(`- Qué chats entran: ${ALCANCES_CHATS[p.chats]}${p.chats === 'lista' ? ` (${p.lista.join(', ') || 'vacía'})` : ''}${p.excluir.length ? `, salvo ${p.excluir.join(', ')}` : ''}. Lo que no entra no se guarda ni lo leo.`);
    lineas.push(`- Guardar mensajes: ${p.guardar ? (p.dias ? `sí, ${p.dias} días` : 'sí') : 'no (solo pasa por el agente si responde; si solo lee, no queda nada)'}.`);
    if (p.modo === 'responder') lineas.push(`- Escribir primero: ${p.escribir_primero === 'no' ? 'no (el gateway lo bloquea)' : 'según el rol de quien lo pida'}.`);
    if (p.conectores) lineas.push(`- Conectores en este número: ${p.conectores.join(', ') || 'ninguno'} (los demás no se cargan acá).`);
    lineas.push('- Límites reales (los hace cumplir el gateway): si este número puede enviar, si escribe primero, qué chats entran y se guardan, los conectores. Quiénes pueden pedir qué sigue siendo por rol.');
    lineas.push('- Lo demás (cuándo conviene responder, cómo manejar un grupo que se ve desde otro número) lo decido yo con lo que me dijiste, y te consulto lo que no esté claro.');
    if (p.notas) lineas.push(`- Instrucción (la cumplo yo, no es un bloqueo): ${p.notas}`);
    return lineas.join('\n');
  }

  function configurar(nombre, cambios, { actor = null, etiqueta = null } = {}) {
    const f = obtener(nombre);
    if (!f) throw Object.assign(new Error('Ese número no existe.'), { status: 404 });
    const p = normalizarPolitica(cambios, f.politica);
    db.prepare('UPDATE sesiones_wa SET politica = ?, etiqueta = COALESCE(?, etiqueta), actualizada = ? WHERE nombre = ?').run(JSON.stringify(p), etiqueta, reloj(), nombre);
    auditar(db, 'whatsapp.numero.politica', { actor: String(actor ?? ''), detalle: { nombre, politica: p } });
    bitacora?.anotar?.({ personaId: actor, donde: 'charla', resultado: 'decision', que: `Política del número "${f.etiqueta ?? nombre}": ${MODOS[p.modo]}; ${ALCANCES_CHATS[p.chats]}${p.guardar ? '' : '; sin guardar'}${p.dias ? `; guarda ${p.dias} días` : ''}.` });
    return p;
  }

  /** Qué número responde en un chat compartido (null = sin elegir). */
  function elegirEnChat(chatId, nombre, actor = null) {
    if (nombre && !fila(nombre)) throw Object.assign(new Error(`No existe el número "${nombre}".`), { status: 404 });
    db.prepare(`INSERT INTO chats (id, tipo, cliente_id, activo, creado) VALUES (?, ?, 1, 1, ?) ON CONFLICT(id) DO NOTHING`).run(chatId, esGrupo(chatId) ? 'grupo' : 'directo', reloj());
    db.prepare('UPDATE chats SET sesion_responde = ? WHERE id = ?').run(nombre ?? null, chatId);
    auditar(db, 'whatsapp.numero.chat', { actor: String(actor ?? ''), detalle: { chatId, nombre } });
  }

  /** Línea para el contexto del Propietario: qué números hay y qué hace cada uno. */
  function resumenParaPropietario() {
    if (!varios()) return null;
    return listar().map((f) => `${f.etiqueta ?? f.nombre} [${f.nombre}]${f.numero ? ` +${f.numero}` : ' (sin vincular)'}: ${MODOS[f.politica.modo]}; ${ALCANCES_CHATS[f.politica.chats]}${f.politica.texto ? `; pedido: "${f.politica.texto.slice(0, 200)}"` : ''}${f.fuera_de_alcance ? `; ${f.fuera_de_alcance} mensajes quedaron afuera` : ''}`).join(' | ');
  }

  return {
    nombrePrincipal, asegurarPrincipal, obtener, listar, varios, politicaDe, cliente, crear, borrar, anotarNumero, numerosPropios, chatPropio, marcarPersonal, sesionDeTelefono,
    enAlcance, contarFuera, verChat, puedeResponder, sesionPara, puedeEnviar, limpiar, compartidos, chatsDe, ficha, configurar,
    elegirEnChat, resumenParaPropietario,
  };
}
