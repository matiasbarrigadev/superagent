// Paquetes: la puerta de entrada para traer el trabajo que alguien ya venía haciendo (con otro asistente, planillas,
// notas) y para respaldar o mudar una instalación. Un paquete es un JSON versionado (docs/IMPORTAR.md) que se
// ensaya (qué crea, actualiza u omite), se aplica recién con la confirmación del Propietario, es idempotente y
// resuelve referencias por nombre o teléfono, nunca por ids internos. Nunca lleva valores de secretos.
import crypto from 'node:crypto';
import { SECCIONES } from './memoria.mjs';
import { normalizar } from '../roles/permisos.mjs';
import { proxima, zonaValida } from '../rutinas/cron.mjs';
import { auditar } from '../db/index.mjs';
import { json, soloDigitos } from '../util.mjs';
import { validarProcedimiento } from '../codigo/procedimiento.mjs';
import { normalizarPolitica, POLITICA_MUDA } from '../wa/numeros.mjs';

export const VERSION_PAQUETE = 1;
const MAX_MEMORIA = 4000;
const AUTONOMIAS = ['via_libre', 'consultar_lo_importante', 'consultar_todo'];
const ALCANCES = ['cuenta', 'cliente', 'proyecto', 'contacto'];

export class ErrorPaquete extends Error {
  constructor(mensaje, errores = []) { super(mensaje); this.status = 400; this.errores = errores; }
}

// --- Secretos: el paquete los nombra, nunca los trae.
const CLAVE_SECRETA = /(token|secret|secreto|password|contrase(n|ñ)a|clave|api[_-]?key|private[_-]?key|credencial|cookie)/i;
const VALOR_SECRETO = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(sbp|vercel|cf)_[A-Za-z0-9]{20,}/,
];

/** Rutas del paquete donde hay algo que parece un secreto (para rechazarlo entero). */
export function buscarSecretos(valor, ruta = '') {
  const out = [];
  if (Array.isArray(valor)) valor.forEach((v, i) => out.push(...buscarSecretos(v, `${ruta}[${i}]`)));
  else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      const r = ruta ? `${ruta}.${k}` : k;
      // "secretos" y "conectores" solo llevan nombres: ahí la clave "nombre" es legítima.
      if (typeof v === 'string' && v.trim() && CLAVE_SECRETA.test(k) && !/^(nombre|para|descripcion)$/i.test(k)) out.push(r);
      else if (k === 'valor' && ruta.startsWith('secretos')) out.push(r);
      else out.push(...buscarSecretos(v, r));
    }
  } else if (typeof valor === 'string' && VALOR_SECRETO.some((re) => re.test(valor))) out.push(ruta);
  return out;
}

const lista = (v) => (Array.isArray(v) ? v : []);
const txt = (v, max = 4000) => String(v ?? '').trim().slice(0, max);
const clave = (s) => txt(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Parte un texto largo en trozos de hasta 4000 caracteres, por párrafos (y si hace falta, por oraciones). */
export function partirMemoria(texto, max = MAX_MEMORIA) {
  const t = txt(texto, 1_000_000);
  if (t.length <= max) return t ? [t] : [];
  const trozos = [];
  let actual = '';
  const piezas = t.split(/\n{2,}/).flatMap((p) => (p.length <= max ? [p] : p.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)|[\\s\\S]{1,${max}}`, 'g'))));
  for (const p of piezas) {
    if ((actual ? actual.length + 2 : 0) + p.length > max) { if (actual) trozos.push(actual); actual = p.trim(); }
    else actual = actual ? `${actual}\n\n${p.trim()}` : p.trim();
  }
  if (actual) trozos.push(actual);
  return trozos;
}

/** Valida forma y contenido. Devuelve la lista de errores (vacía si está bien). */
export function validarPaquete(p) {
  const e = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['El paquete tiene que ser un objeto JSON.'];
  if (p.superagent !== VERSION_PAQUETE) e.push(`Falta "superagent": ${VERSION_PAQUETE} (versión del formato).`);
  const secretos = buscarSecretos(p);
  if (secretos.length) e.push(`El paquete trae algo que parece un secreto (${secretos.slice(0, 5).join(', ')}). Los secretos no van en el paquete: se nombran en "secretos" y se cargan después, uno por uno.`);
  for (const [i, r] of lista(p.roles).entries()) if (!txt(r?.nombre)) e.push(`roles[${i}]: falta el nombre.`);
  for (const [i, c] of lista(p.clientes).entries()) {
    if (!txt(c?.nombre)) e.push(`clientes[${i}]: falta el nombre.`);
    if (c?.autonomia && !AUTONOMIAS.includes(c.autonomia)) e.push(`clientes[${i}]: autonomía inválida (${AUTONOMIAS.join(', ')}).`);
  }
  for (const [i, x] of lista(p.personas).entries()) {
    const tel = soloDigitos(x?.telefono ?? '');
    if (!tel && !x?.lid) e.push(`personas[${i}]: necesita teléfono (con código de país) o LID.`);
    if (tel && (tel.length < 8 || tel.length > 15)) e.push(`personas[${i}]: teléfono inválido.`);
  }
  for (const [i, x] of lista(p.proyectos).entries()) {
    if (!txt(x?.nombre)) e.push(`proyectos[${i}]: falta el nombre.`);
    if (x?.repo && !/^[\w.-]+\/[\w.-]+$/.test(x.repo)) e.push(`proyectos[${i}]: el repo va como dueño/nombre.`);
  }
  for (const [i, x] of lista(p.chats).entries()) if (!txt(x?.id) && !txt(x?.telefono)) e.push(`chats[${i}]: necesita id (JID del grupo o chat) o teléfono.`);
  for (const [i, m] of lista(p.memoria).entries()) {
    if (!ALCANCES.includes(m?.alcance)) e.push(`memoria[${i}]: alcance inválido (${ALCANCES.join(', ')}).`);
    if (!SECCIONES.includes(m?.seccion)) e.push(`memoria[${i}]: sección inválida (${SECCIONES.join(', ')}).`);
    if (!txt(m?.contenido)) e.push(`memoria[${i}]: está vacía.`);
    if (m?.alcance && m.alcance !== 'cuenta' && !txt(m?.de)) e.push(`memoria[${i}]: falta "de" (a qué ${m.alcance} pertenece).`);
  }
  for (const [i, l] of lista(p.lecciones).entries()) if (!txt(l?.regla)) e.push(`lecciones[${i}]: falta la regla.`);
  for (const [i, r] of lista(p.rutinas).entries()) {
    if (!txt(r?.instruccion)) e.push(`rutinas[${i}]: falta la instrucción.`);
    if (!txt(r?.cuando)) e.push(`rutinas[${i}]: falta "cuando" (cron de 5 campos).`);
    if (r?.zona_horaria && !zonaValida(r.zona_horaria)) e.push(`rutinas[${i}]: zona horaria inválida.`);
    else if (r?.cuando) { try { proxima(r.cuando, r.zona_horaria || 'UTC', Date.now()); } catch (x) { e.push(`rutinas[${i}]: ${x.message}`); } }
  }
  for (const [i, s] of lista(p.secretos).entries()) {
    const n = typeof s === 'string' ? s : s?.nombre;
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(n ?? ''))) e.push(`secretos[${i}]: el nombre va en mayúsculas (por ejemplo VERCEL_TOKEN).`);
  }
  for (const [i, s] of lista(p.numeros).entries()) {
    if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(String(s?.nombre ?? ''))) e.push(`numeros[${i}]: el nombre va en minúsculas, números y guiones.`);
    try { normalizarPolitica(s?.politica ?? {}, POLITICA_MUDA); } catch (x) { e.push(`numeros[${i}]: ${x.message}`); }
  }
  for (const [i, c] of lista(p.conectores).entries()) {
    if (!txt(c?.nombre)) e.push(`conectores[${i}]: falta el nombre.`);
    if (c?.url) { try { new URL(c.url); } catch { e.push(`conectores[${i}]: URL inválida.`); } }
  }
  return e;
}

export const huellaPaquete = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

export function crearPaquetes({ db, roles, memoria, numeros = null, entorno = null, procedimientos = null, ajustes = null, reloj = () => Date.now() }) {
  const idRol = (nombre) => db.prepare('SELECT id FROM roles WHERE nombre = ?').get(txt(nombre))?.id ?? null;
  const cliente = (nombre) => db.prepare('SELECT * FROM clientes WHERE lower(nombre) = lower(?)').get(txt(nombre));
  const proyecto = (nombre) => db.prepare('SELECT * FROM proyectos WHERE lower(nombre) = lower(?)').get(txt(nombre));
  const personaPor = ({ telefono, lid }) => {
    const tel = soloDigitos(telefono ?? '');
    return (tel && roles.buscarPorTelefono(tel)) || (lid && db.prepare('SELECT * FROM personas WHERE lid = ?').get(lid)) || null;
  };

  /**
   * Recorre el paquete. Con `aplicar: false` solo cuenta qué haría (ensayo); con `aplicar: true` lo hace, en una
   * transacción. `actor`: { personaId, permisos } del Propietario.
   */
  function procesar(p, { aplicar = false, actor }) {
    const errores = validarPaquete(p);
    if (errores.length) throw new ErrorPaquete(`El paquete no es válido:\n- ${errores.join('\n- ')}`, errores);
    const plan = { crear: [], actualizar: [], omitir: [], avisos: [] };
    const nuevos = { clientes: new Set(), proyectos: new Set(), personas: new Set(), roles: new Set() };
    const hacer = (fn) => (aplicar ? fn() : null);

    if (aplicar) db.exec('BEGIN');
    try {
      // Roles (antes que las personas que los usan).
      for (const r of lista(p.roles)) {
        const n = txt(r.nombre, 40), perm = normalizar(r.permisos);
        const ya = db.prepare('SELECT * FROM roles WHERE nombre = ?').get(n);
        if (!ya) { plan.crear.push(`rol "${n}"`); nuevos.roles.add(n); hacer(() => roles.crearRol(actor, { nombre: n, descripcion: r.descripcion, permisos: perm })); }
        else if (ya.predefinido) plan.omitir.push(`rol "${n}" (predefinido)`);
        else if (JSON.stringify(normalizar(ya.permisos)) !== JSON.stringify(perm) || (r.descripcion != null && r.descripcion !== ya.descripcion)) {
          plan.actualizar.push(`rol "${n}"`); hacer(() => roles.editarRol(actor, ya.id, { descripcion: r.descripcion, permisos: perm }));
        } else plan.omitir.push(`rol "${n}" (igual)`);
      }
      const rolExiste = (n) => idRol(n) || nuevos.roles.has(txt(n));

      // Clientes.
      for (const c of lista(p.clientes)) {
        const n = txt(c.nombre, 80), ya = cliente(n), aut = AUTONOMIAS.includes(c.autonomia) ? c.autonomia : 'consultar_lo_importante';
        if (!ya) {
          plan.crear.push(`cliente "${n}"`); nuevos.clientes.add(clave(n));
          hacer(() => db.prepare("INSERT INTO clientes (nombre, tipo, autonomia, estado, creado_por) VALUES (?, 'cliente', ?, 'activo', ?)").run(n, aut, actor.personaId ?? null));
        } else if (c.autonomia && ya.autonomia !== aut) { plan.actualizar.push(`cliente "${n}" (autonomía)`); hacer(() => db.prepare('UPDATE clientes SET autonomia = ? WHERE id = ?').run(aut, ya.id)); }
        else plan.omitir.push(`cliente "${n}" (igual)`);
      }
      const clienteId = (n, donde) => {
        if (!txt(n)) return 1;
        const c = cliente(n);
        if (c) return c.id;
        if (nuevos.clientes.has(clave(n))) return aplicar ? cliente(n).id : -1;
        plan.avisos.push(`${donde}: el cliente "${n}" no existe; queda en la cuenta propia.`);
        return 1;
      };

      // Personas.
      for (const x of lista(p.personas)) {
        const rol = txt(x.rol) || 'Tercero';
        const tel = soloDigitos(x.telefono ?? '');
        const etiqueta = `${x.nombre ?? 'persona'}${tel ? ` (+${tel})` : ''}`;
        if (!rolExiste(rol)) { plan.avisos.push(`persona ${etiqueta}: el rol "${rol}" no existe; se omite.`); continue; }
        const ya = personaPor(x);
        if (!ya) {
          if (!tel) { plan.avisos.push(`persona ${etiqueta}: sin teléfono no se puede dar de alta; se omite.`); continue; }
          plan.crear.push(`persona ${etiqueta} como ${rol}`); nuevos.personas.add(tel);
          hacer(() => roles.altaPersona(actor, { nombre: x.nombre, telefono: tel, rolId: idRol(rol) }));
        } else {
          const cambios = [];
          if (x.nombre && x.nombre !== ya.nombre) cambios.push('nombre');
          if (ya.rol_id !== idRol(rol) || !ya.alta_manual) cambios.push('rol');
          if (cambios.length) {
            plan.actualizar.push(`persona ${etiqueta} (${cambios.join(', ')})`);
            hacer(() => { if (cambios.includes('nombre')) roles.editarPersona(actor, ya.id, { nombre: x.nombre }); if (cambios.includes('rol')) roles.cambiarRol(actor, ya.id, idRol(rol)); });
          } else plan.omitir.push(`persona ${etiqueta} (igual)`);
        }
        if (x.lid) hacer(() => db.prepare('UPDATE personas SET lid = COALESCE(lid, ?) WHERE id = ?').run(x.lid, personaPor(x).id));
        for (const pc of lista(x.clientes)) {
          if (!rolExiste(pc.rol)) { plan.avisos.push(`persona ${etiqueta}: el rol "${pc.rol}" para el cliente "${pc.cliente}" no existe.`); continue; }
          const cid = clienteId(pc.cliente, `persona ${etiqueta}`);
          if (cid === 1) continue;
          if (ya && cid > 0 && db.prepare('SELECT 1 FROM persona_cliente WHERE persona_id = ? AND cliente_id = ? AND rol_id = ?').get(ya.id, cid, idRol(pc.rol))) { plan.omitir.push(`rol de ${etiqueta} en "${pc.cliente}" (igual)`); continue; }
          plan.crear.push(`rol de ${etiqueta} en el cliente "${pc.cliente}": ${pc.rol}`);
          hacer(() => roles.asignarEnCliente(actor, personaPor(x).id, cliente(pc.cliente).id, idRol(pc.rol)));
        }
      }

      // Proyectos.
      for (const x of lista(p.proyectos)) {
        const n = txt(x.nombre, 60), ya = proyecto(n);
        clienteId(x.cliente, `proyecto "${n}"`);
        const doms = lista(x.dominios).map((d) => txt(d).toLowerCase()).filter(Boolean);
        if (!ya) {
          plan.crear.push(`proyecto "${n}"${x.repo ? ` (${x.repo})` : ''}`); nuevos.proyectos.add(clave(n));
          hacer(() => db.prepare('INSERT INTO proyectos (cliente_id, nombre, repo, rama_principal, estado, creado, dominios) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(cliente(x.cliente)?.id ?? 1, n, x.repo || null, txt(x.rama_principal) || 'main', 'activo', reloj(), JSON.stringify(doms)));
        } else {
          const cambia = (x.repo && x.repo !== ya.repo) || (x.rama_principal && x.rama_principal !== ya.rama_principal) || (doms.length && JSON.stringify(doms) !== ya.dominios);
          if (cambia) {
            plan.actualizar.push(`proyecto "${n}"`);
            hacer(() => db.prepare('UPDATE proyectos SET repo = COALESCE(?, repo), rama_principal = COALESCE(?, rama_principal), dominios = ? WHERE id = ?')
              .run(x.repo || null, txt(x.rama_principal) || null, doms.length ? JSON.stringify(doms) : ya.dominios, ya.id));
          } else plan.omitir.push(`proyecto "${n}" (igual)`);
        }
        if (x.procedimiento) {
          const actual = ya?.procedimiento_publicacion ? json(ya.procedimiento_publicacion, null) : null;
          if (JSON.stringify(actual) === JSON.stringify(x.procedimiento)) plan.omitir.push(`procedimiento de "${n}" (igual)`);
          else if (!procedimientos) plan.avisos.push(`procedimiento de "${n}": no se puede cargar en esta instalación.`);
          else {
            try { validarProcedimiento(x.procedimiento, doms.length ? doms : json(ya?.dominios, [])); } catch (e) { plan.avisos.push(`procedimiento de "${n}": ${e.message} Se omite.`); continue; }
            plan.actualizar.push(`procedimiento de publicación de "${n}"`);
            hacer(() => procedimientos.guardar(proyecto(n).id, { procedimiento: x.procedimiento, dominios: doms.length ? doms : undefined }, actor.personaId));
          }
        }
      }
      const proyectoId = (n, donde) => {
        if (!txt(n)) return null;
        const x = proyecto(n);
        if (x) return x.id;
        if (nuevos.proyectos.has(clave(n))) return aplicar ? proyecto(n).id : -1;
        plan.avisos.push(`${donde}: el proyecto "${n}" no existe.`);
        return null;
      };

      // Números de WhatsApp y su política (sin credenciales: cada número se vincula de nuevo en el panel).
      const numerosNuevos = new Set();
      for (const s of lista(p.numeros)) {
        const pol = normalizarPolitica(s.politica ?? {}, POLITICA_MUDA);
        const ya = db.prepare('SELECT * FROM sesiones_wa WHERE nombre = ?').get(s.nombre);
        if (!ya) {
          plan.crear.push(`número "${s.etiqueta ?? s.nombre}" (queda para vincular en el panel)`); numerosNuevos.add(s.nombre);
          hacer(() => db.prepare('INSERT INTO sesiones_wa (nombre, etiqueta, principal, politica, creada) VALUES (?, ?, 0, ?, ?)').run(s.nombre, s.etiqueta ?? s.nombre, JSON.stringify(pol), reloj()));
        } else if (JSON.stringify(normalizarPolitica(json(ya.politica, {}), POLITICA_MUDA)) !== JSON.stringify(pol) || (s.etiqueta && s.etiqueta !== ya.etiqueta)) {
          plan.actualizar.push(`política del número "${s.etiqueta ?? s.nombre}"`);
          hacer(() => (numeros ? numeros.configurar(s.nombre, pol, { actor: actor.personaId, etiqueta: s.etiqueta ?? null }) : db.prepare('UPDATE sesiones_wa SET politica = ? WHERE nombre = ?').run(JSON.stringify(pol), s.nombre)));
        } else plan.omitir.push(`número "${s.etiqueta ?? s.nombre}" (igual)`);
      }
      const numeroExiste = (n) => !!db.prepare('SELECT 1 FROM sesiones_wa WHERE nombre = ?').get(n) || numerosNuevos.has(n);

      // Chats y grupos.
      for (const x of lista(p.chats)) {
        const id = txt(x.id) || `${soloDigitos(x.telefono)}@c.us`;
        const grupo = /@g\.us$/.test(id);
        const cid = clienteId(x.cliente, `chat ${x.nombre ?? id}`), pid = proyectoId(x.proyecto, `chat ${x.nombre ?? id}`);
        const ya = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
        const activo = x.activo === undefined ? (ya?.activo ?? 1) : (x.activo ? 1 : 0);
        const mencion = x.solo_si_mencionan ? 1 : 0;
        if (x.responde_por && !numeroExiste(x.responde_por)) plan.avisos.push(`chat ${x.nombre ?? id}: el número "${x.responde_por}" no existe; queda sin elegir.`);
        const respondePor = x.responde_por && numeroExiste(x.responde_por) ? x.responde_por : null;
        if (!ya) plan.crear.push(`${grupo ? 'grupo' : 'chat'} ${x.nombre ?? id}`);
        else if (ya.cliente_id !== cid || (pid && ya.proyecto_id !== pid) || ya.activo !== activo || ya.responder_solo_si_mencionan !== mencion || (x.nombre && ya.nombre !== x.nombre) || (respondePor && ya.sesion_responde !== respondePor)) plan.actualizar.push(`${grupo ? 'grupo' : 'chat'} ${x.nombre ?? id}`);
        else { plan.omitir.push(`${grupo ? 'grupo' : 'chat'} ${x.nombre ?? id} (igual)`); continue; }
        hacer(() => db.prepare(`INSERT INTO chats (id, tipo, cliente_id, proyecto_id, activo, responder_solo_si_mencionan, nombre, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET cliente_id = excluded.cliente_id, proyecto_id = COALESCE(excluded.proyecto_id, proyecto_id), activo = excluded.activo,
          responder_solo_si_mencionan = excluded.responder_solo_si_mencionan, nombre = COALESCE(excluded.nombre, nombre)`)
          .run(id, grupo ? 'grupo' : 'directo', cliente(x.cliente)?.id ?? 1, x.proyecto ? proyecto(x.proyecto)?.id ?? null : null, activo, mencion, x.nombre ?? null, reloj()));
        if (respondePor) hacer(() => db.prepare('UPDATE chats SET sesion_responde = ? WHERE id = ?').run(respondePor, id));
      }

      // Memoria (partida en trozos de 4000; lo idéntico no se repite).
      for (const m of lista(p.memoria)) {
        let alcanceId = null, de = '';
        if (m.alcance === 'cliente') { alcanceId = clienteId(m.de, 'memoria'); de = ` de ${m.de}`; if (alcanceId === 1 && !cliente(m.de)) continue; }
        if (m.alcance === 'proyecto') { alcanceId = proyectoId(m.de, 'memoria'); de = ` de ${m.de}`; if (!alcanceId) continue; }
        if (m.alcance === 'contacto') {
          const tel = soloDigitos(m.de);
          const per = personaPor({ telefono: tel });
          if (!per && !nuevos.personas.has(tel)) { plan.avisos.push(`memoria de contacto ${m.de}: esa persona no existe (va con su teléfono).`); continue; }
          alcanceId = per?.id ?? -1; de = ` de +${tel}`;
        }
        const trozos = partirMemoria(m.contenido);
        if (trozos.length > 1) plan.avisos.push(`memoria ${m.alcance}${de} / ${m.seccion}: tenía más de ${MAX_MEMORIA} caracteres, va partida en ${trozos.length}.`);
        trozos.forEach((t, i) => {
          const etiqueta = `memoria ${m.alcance}${de} / ${m.seccion}${trozos.length > 1 ? ` (${i + 1}/${trozos.length})` : ''}`;
          const idReal = aplicar && alcanceId === -1 ? personaPor({ telefono: soloDigitos(m.de) })?.id : alcanceId;
          const existe = alcanceId !== -1 && db.prepare(`SELECT 1 FROM memoria WHERE alcance = ? AND ${alcanceId == null ? 'alcance_id IS NULL' : 'alcance_id = ?'} AND seccion = ? AND contenido = ?`)
            .get(...[m.alcance, ...(alcanceId == null ? [] : [alcanceId]), m.seccion, t]);
          if (existe) { plan.omitir.push(`${etiqueta} (ya estaba)`); return; }
          plan.crear.push(etiqueta);
          hacer(() => memoria.guardar({ alcance: m.alcance, alcanceId: m.alcance === 'cliente' ? cliente(m.de).id : m.alcance === 'proyecto' ? proyecto(m.de).id : idReal, seccion: m.seccion, contenido: t, autor: actor.personaId, publica: !!m.publica }));
        });
      }

      // Lecciones.
      for (const l of lista(p.lecciones)) {
        const regla = txt(l.regla, 500);
        if (db.prepare('SELECT 1 FROM lecciones WHERE regla = ?').get(regla)) { plan.omitir.push(`lección "${regla.slice(0, 50)}" (ya estaba)`); continue; }
        plan.crear.push(`lección "${regla.slice(0, 60)}"`);
        hacer(() => db.prepare("INSERT INTO lecciones (regla, porque, como_aplicar, publica, autor, estado, creada) VALUES (?, ?, ?, ?, ?, 'activa', ?)")
          .run(regla, txt(l.porque, 500) || null, txt(l.como_aplicar, 500) || null, l.publica ? 1 : 0, actor.personaId ?? null, reloj()));
      }

      // Rutinas: quedan activas y aprobadas (las aplica el Propietario) y con su próxima ejecución calculada.
      const tzDefecto = ajustes?.get?.('zona_horaria', 'UTC') || 'UTC';
      const chatPropietario = () => { const t = db.prepare('SELECT telefono FROM personas WHERE id = ?').get(actor.personaId)?.telefono; return t ? `${t}@c.us` : `panel:${actor.personaId}`; };
      const destinoDe = (d) => {
        const s = txt(d);
        if (!s || s === 'propietario') return chatPropietario();
        if (/@g\.us$|@c\.us$|@lid$/.test(s)) return s;
        const dig = soloDigitos(s);
        return dig.length >= 8 ? `${dig}@c.us` : null;
      };
      for (const r of lista(p.rutinas)) {
        const destino = destinoDe(r.destino);
        if (!destino) { plan.avisos.push(`rutina "${txt(r.instruccion).slice(0, 40)}": destino inválido; se omite.`); continue; }
        const tz = r.zona_horaria || tzDefecto;
        const quien = r.pedida_por ? personaPor({ telefono: r.pedida_por }) : null;
        if (r.pedida_por && !quien && !nuevos.personas.has(soloDigitos(r.pedida_por))) plan.avisos.push(`rutina "${txt(r.instruccion).slice(0, 40)}": quien la pidió (+${soloDigitos(r.pedida_por)}) no existe; queda a nombre del Propietario.`);
        const ya = db.prepare('SELECT 1 FROM rutinas WHERE instruccion = ? AND cuando = ? AND chat_destino = ?').get(txt(r.instruccion), txt(r.cuando), destino);
        const etiqueta = `rutina "${txt(r.instruccion).slice(0, 50)}" (${r.cuando}, ${tz})`;
        if (ya) { plan.omitir.push(`${etiqueta} (ya estaba)`); continue; }
        plan.crear.push(etiqueta);
        hacer(() => {
          const creador = (r.pedida_por ? personaPor({ telefono: r.pedida_por })?.id : null) ?? actor.personaId;
          const destinos = [destino, ...lista(r.destinos).map(destinoDe).filter(Boolean)];
          db.prepare(`INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, modelo, activa, proxima, destinos, aprobada, creada)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`).run(txt(r.cuando), tz, txt(r.instruccion), creador, destino, r.modelo ?? null, proxima(txt(r.cuando), tz, reloj()), JSON.stringify([...new Set(destinos)]), reloj());
        });
      }

      // Secretos y conectores: solo se listan los que faltan, para pedirlos uno por uno después.
      const cargados = new Set((entorno?.listar?.() ?? []).map((v) => v.nombre));
      const faltanSecretos = lista(p.secretos).map((s) => (typeof s === 'string' ? { nombre: s } : { nombre: s.nombre, para: s.para })).filter((s) => !cargados.has(s.nombre));
      const activos = db.prepare("SELECT app, url_mcp FROM conexiones WHERE estado = 'activa'").all();
      const faltanConectores = lista(p.conectores).filter((c) => !activos.some((a) => clave(a.app) === clave(c.nombre) || (c.url && a.url_mcp === c.url)));
      plan.faltan = { secretos: faltanSecretos, conectores: faltanConectores };

      if (aplicar) {
        db.exec('COMMIT');
        auditar(db, 'paquete.importar', { actor: String(actor.personaId ?? ''), detalle: { creados: plan.crear.length, actualizados: plan.actualizar.length, huella: huellaPaquete(p) } });
      }
    } catch (e) {
      if (aplicar) { try { db.exec('ROLLBACK'); } catch {} }
      throw e;
    }
    return plan;
  }

  /** Resumen legible del plan (para que el agente se lo cuente al Propietario). */
  function resumen(plan, { aplicado = false } = {}) {
    const bloque = (t, xs) => (xs.length ? `${t} (${xs.length}):\n${xs.slice(0, 60).map((x) => `- ${x}`).join('\n')}${xs.length > 60 ? `\n- … y ${xs.length - 60} más` : ''}` : '');
    return [
      aplicado ? 'Importado.' : 'Ensayo (todavía no se aplicó nada):',
      bloque(aplicado ? 'Creado' : 'Se crea', plan.crear),
      bloque(aplicado ? 'Actualizado' : 'Se actualiza', plan.actualizar),
      bloque('Sin cambios', plan.omitir),
      bloque('Ojo', plan.avisos),
      plan.faltan.secretos.length ? `Secretos para cargar después (uno por uno, con pedir_variable): ${plan.faltan.secretos.map((s) => s.nombre).join(', ')}` : '',
      plan.faltan.conectores.length ? `Conectores para conectar después: ${plan.faltan.conectores.map((c) => `${c.nombre}${c.url ? ` (${c.url})` : ''}`).join(', ')}` : '',
    ].filter(Boolean).join('\n\n');
  }

  /** Exporta la configuración de la instalación como paquete. Sin secretos: solo sus nombres. */
  function exportar() {
    const nombreCliente = (id) => (id && id !== 1 ? db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(id)?.nombre ?? null : null);
    const nombreProyecto = (id) => (id ? db.prepare('SELECT nombre FROM proyectos WHERE id = ?').get(id)?.nombre ?? null : null);
    const telDe = (id) => db.prepare('SELECT telefono FROM personas WHERE id = ?').get(id)?.telefono ?? null;
    const rolNombre = (id) => db.prepare('SELECT nombre FROM roles WHERE id = ?').get(id)?.nombre ?? null;
    return {
      superagent: VERSION_PAQUETE,
      exportado: new Date(reloj()).toISOString(),
      roles: db.prepare('SELECT nombre, descripcion, permisos FROM roles WHERE predefinido = 0 ORDER BY id').all().map((r) => ({ nombre: r.nombre, descripcion: r.descripcion, permisos: normalizar(r.permisos) })),
      clientes: db.prepare("SELECT nombre, autonomia FROM clientes WHERE tipo = 'cliente' ORDER BY id").all(),
      personas: db.prepare('SELECT id, nombre, telefono, lid, rol_id FROM personas WHERE alta_manual = 1 AND activa = 1 AND telefono IS NOT NULL ORDER BY id').all().map((x) => ({
        nombre: x.nombre, telefono: x.telefono, ...(x.lid ? { lid: x.lid } : {}), rol: rolNombre(x.rol_id),
        clientes: db.prepare('SELECT cliente_id, rol_id FROM persona_cliente WHERE persona_id = ?').all(x.id).map((pc) => ({ cliente: nombreCliente(pc.cliente_id), rol: rolNombre(pc.rol_id) })).filter((pc) => pc.cliente),
      })),
      proyectos: db.prepare("SELECT * FROM proyectos WHERE estado = 'activo' ORDER BY id").all().map((x) => ({
        nombre: x.nombre, cliente: nombreCliente(x.cliente_id), repo: x.repo, rama_principal: x.rama_principal, dominios: json(x.dominios, []),
        ...(x.procedimiento_publicacion ? { procedimiento: json(x.procedimiento_publicacion, null) } : {}),
      })),
      chats: db.prepare("SELECT * FROM chats WHERE id NOT LIKE 'panel:%' AND (tipo = 'grupo' OR cliente_id != 1 OR proyecto_id IS NOT NULL OR responder_solo_si_mencionan = 1) ORDER BY id").all().map((c) => ({
        id: c.id, nombre: c.nombre, cliente: nombreCliente(c.cliente_id), proyecto: nombreProyecto(c.proyecto_id), activo: !!c.activo, solo_si_mencionan: !!c.responder_solo_si_mencionan,
        ...(c.sesion_responde ? { responde_por: c.sesion_responde } : {}),
      })),
      numeros: db.prepare('SELECT nombre, etiqueta, politica FROM sesiones_wa ORDER BY principal DESC, creada').all().map((s) => ({ nombre: s.nombre, etiqueta: s.etiqueta, politica: json(s.politica, {}) })),
      memoria: db.prepare('SELECT * FROM memoria ORDER BY id').all().map((m) => ({
        alcance: m.alcance, seccion: m.seccion, contenido: m.contenido, publica: !!m.publica,
        ...(m.alcance === 'cliente' ? { de: nombreCliente(m.alcance_id) } : m.alcance === 'proyecto' ? { de: nombreProyecto(m.alcance_id) } : m.alcance === 'contacto' ? { de: telDe(m.alcance_id) } : {}),
      })).filter((m) => m.alcance === 'cuenta' || m.de),
      lecciones: db.prepare("SELECT regla, porque, como_aplicar, publica FROM lecciones WHERE estado = 'activa' ORDER BY id").all().map((l) => ({ ...l, publica: !!l.publica })),
      rutinas: db.prepare('SELECT * FROM rutinas WHERE activa = 1 AND aprobada = 1 ORDER BY id').all().map((r) => ({
        cuando: r.cuando, zona_horaria: r.zona_horaria, instruccion: r.instruccion, destino: r.chat_destino, ...(telDe(r.creada_por) ? { pedida_por: telDe(r.creada_por) } : {}),
        destinos: json(r.destinos, []).filter((d) => d !== r.chat_destino), ...(r.modelo ? { modelo: r.modelo } : {}),
      })),
      secretos: (entorno?.listar?.() ?? []).map((v) => ({ nombre: v.nombre, ...(v.descripcion ? { para: v.descripcion } : {}) })),
      conectores: db.prepare("SELECT app, url_mcp FROM conexiones WHERE alcance = 'instalacion' AND url_mcp IS NOT NULL ORDER BY id").all().map((c) => ({ nombre: c.app, url: c.url_mcp })),
    };
  }

  return {
    ensayar: (p, actor) => procesar(p, { aplicar: false, actor }),
    importar: (p, actor) => procesar(p, { aplicar: true, actor }),
    exportar, resumen, validar: validarPaquete,
  };
}
