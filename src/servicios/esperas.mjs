// Esperas de autorización: el agente le pasa a alguien un link o un código (gh auth login, vercel login, un OAuth…)
// y, en vez de quedarse esperando, deja dicho cómo comprobar que ya quedó. El gateway lo comprueba cada tanto en su
// entorno y lo despierta en la charla donde se pidió con el resultado: él decide qué decir y cómo seguir.
import { correrPaso } from '../codigo/procedimiento.mjs';

const CADA_MS = 10_000;
const MAX_MIN = 30;
// Lo que tenga forma de token no vuelve en el evento (el comando de comprobación puede mostrarlo).
const TOKENS = /\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:sbp|vercel)_[A-Za-z0-9]{16,})\b|(Bearer\s+)\S{12,}|((?:token|secret|password|clave)\s*[:=]\s*)\S{8,}/gi;
export const tacharTokens = (t) => String(t ?? '').replace(TOKENS, (m, _a, bearer, campo) => (bearer ? `${bearer}[secreto]` : campo ? `${campo}[secreto]` : '[secreto]'));

export function crearEsperas({ db, aislamiento = null, despertar, correr = correrPaso, reloj = () => Date.now(), log = console }) {
  const enCurso = new Set();

  function crear({ chatId, personaId = null, servicio, comprobar, venceMin = 15 }) {
    const s = String(servicio ?? '').trim().slice(0, 60);
    const c = String(comprobar ?? '').trim().slice(0, 500);
    if (!chatId) throw new Error('Falta la charla donde avisar.');
    if (s.length < 2) throw new Error('Decí qué se está conectando (servicio).');
    if (!c) throw new Error('Falta el comando que comprueba si ya quedó conectado.');
    const min = Math.min(MAX_MIN, Math.max(1, Math.round(Number(venceMin) || 15)));
    const ahora = reloj();
    db.prepare(`INSERT INTO esperas (chat_id, persona_id, servicio, comprobar, creada, vence, proxima) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, servicio) DO UPDATE SET persona_id = excluded.persona_id, comprobar = excluded.comprobar,
        creada = excluded.creada, vence = excluded.vence, proxima = excluded.proxima, ultima_salida = NULL`)
      .run(chatId, personaId, s, c, ahora, ahora + min * 60_000, ahora + CADA_MS);
    return { servicio: s, minutos: min };
  }

  function listar(chatId = null) {
    return chatId ? db.prepare('SELECT * FROM esperas WHERE chat_id = ? ORDER BY id').all(chatId) : db.prepare('SELECT * FROM esperas ORDER BY id').all();
  }

  function cancelar(chatId, servicio) {
    return db.prepare('DELETE FROM esperas WHERE chat_id = ? AND servicio = ?').run(chatId, String(servicio ?? '').trim()).changes > 0;
  }

  /** Corre la comprobación como el usuario del entorno del Propietario (como su terminal). */
  function comprobar(e) {
    const lugar = aislamiento?.rutas ? aislamiento.rutas('propietario') : null;
    const usuario = aislamiento?.activo ? aislamiento.usuarioDe('propietario') : null;
    const env = { PATH: process.env.PATH, HOME: lugar?.base ?? process.env.HOME, TMPDIR: lugar?.tmp ?? process.env.TMPDIR, LANG: 'C.UTF-8', NO_COLOR: '1', CI: '1' };
    return correr(e.comprobar, { cwd: lugar?.trabajo ?? lugar?.base ?? process.cwd(), env, usuario, timeoutMs: 20_000 });
  }

  const resumen = (salida) => tacharTokens(String(salida ?? '').trim()).slice(-600) || '(sin salida)';

  async function revisarUna(e) {
    enCurso.add(e.id);
    try {
      const r = await comprobar(e).catch((err) => ({ codigo: -1, salida: err.message }));
      const sigue = db.prepare('SELECT * FROM esperas WHERE id = ?').get(e.id);
      if (!sigue || sigue.creada !== e.creada) return; // la cancelaron o la reemplazaron mientras tanto
      const ahora = reloj();
      if (r.codigo === 0) {
        db.prepare('DELETE FROM esperas WHERE id = ?').run(e.id);
        despertar({ chatId: e.chat_id, personaId: e.persona_id, origen: 'autorizacion',
          texto: `[autorización ${e.servicio} lista] Se comprobó con \`${e.comprobar}\`: ${resumen(r.salida)}\nContáselo en una línea y seguí con lo que estaban haciendo (si ya lo diste por conectado, no lo repitas).` });
      } else if (ahora >= e.vence) {
        db.prepare('DELETE FROM esperas WHERE id = ?').run(e.id);
        const min = Math.round((e.vence - e.creada) / 60_000);
        despertar({ chatId: e.chat_id, personaId: e.persona_id, origen: 'autorizacion',
          texto: `[autorización ${e.servicio} sin completar] Pasaron ${min} min y \`${e.comprobar}\` sigue sin dar conectado. Última respuesta: ${resumen(r.salida)}\nContáselo simple y ofrecé volver a intentarlo (o revisá si el login se cortó).` });
      } else {
        db.prepare('UPDATE esperas SET proxima = ?, ultima_salida = ? WHERE id = ?').run(ahora + CADA_MS, resumen(r.salida).slice(-300), e.id);
      }
    } catch (err) {
      log.warn?.('[esperas]', err.message);
    } finally {
      enCurso.delete(e.id);
    }
  }

  /** Se llama en cada tick del motor: comprueba las que tocan, sin pisarse. */
  function revisar(ahora = reloj()) {
    for (const e of db.prepare('SELECT * FROM esperas WHERE proxima <= ? ORDER BY proxima LIMIT 5').all(ahora)) {
      if (enCurso.has(e.id)) continue;
      revisarUna(e);
    }
  }

  return { crear, listar, cancelar, revisar };
}
