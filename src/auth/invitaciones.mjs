// Crear una invitación al panel (la usan el panel y la herramienta del agente). Devuelve el token una sola vez:
// en la base queda solo su hash.
import { auditar } from '../db/index.mjs';
import { token, sha256 } from './cripto.mjs';
import { normalizarAccesos } from './accesos.mjs';

export const DURACION_INVITACION = 72 * 3600_000;

export function crearInvitacion(db, { nombre, accesos, creadaPor = null, ahora = Date.now() }) {
  const lista = normalizarAccesos(accesos);
  const valor = token();
  const id = Number(db.prepare('INSERT INTO invitaciones (hash, nombre, accesos, creada, vence, creada_por) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(valor), String(nombre ?? '').trim().slice(0, 100) || null, lista ? JSON.stringify(lista) : null, ahora, ahora + DURACION_INVITACION, creadaPor).lastInsertRowid);
  auditar(db, 'invitacion.crear', { actor: creadaPor ?? '', detalle: { id, nombre, accesos: lista ?? 'todo' } });
  return { id, token: valor };
}

export const linkInvitacion = (publicUrl, t) => `${publicUrl ?? ''}/#invitacion=${t}`;
