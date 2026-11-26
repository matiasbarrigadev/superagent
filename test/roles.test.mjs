// Etapa 6: roles editables y política.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBase } from '../src/db/index.mjs';
import { crearPolitica, decidir, ACCIONES } from '../src/roles/politica.mjs';
import { crearRoles } from '../src/roles/servicio.mjs';
import { normalizar, excesos, TODOS } from '../src/roles/permisos.mjs';
import { armar, entrarComoPropietario, persona, idRol, escribe } from './ayuda.mjs';

// La matriz de TEORIA §2.5, traducida a acciones del gateway: [Propietario, Colaborador, Tercero].
const MATRIZ = {
  conversar: ['permitir', 'permitir', 'permitir'],
  responder: ['permitir', 'permitir', 'permitir'],
  preguntar_al_propietario: ['permitir', 'permitir', 'permitir'],
  guardar_memoria_contacto: ['permitir', 'permitir', 'permitir'],
  guardar_memoria: ['permitir', 'con_aprobacion', 'negar'],
  cambiar_instrucciones: ['permitir', 'con_aprobacion', 'negar'],
  leer_codigo: ['permitir', 'permitir', 'negar'],
  editar_codigo: ['permitir', 'permitir', 'negar'],
  publicar: ['permitir', 'con_aprobacion', 'negar'],
  usar_web: ['permitir', 'permitir', 'negar'],
  programar_rutina: ['permitir', 'con_aprobacion', 'negar'],
  iniciar_conversacion: ['permitir', 'con_aprobacion', 'negar'],
  gestionar_personas: ['permitir', 'negar', 'negar'],
  gestionar_roles: ['permitir', 'negar', 'negar'],
  aprobar: ['permitir', 'negar', 'negar'],
  ver_consumo: ['permitir', 'negar', 'negar'],
  conectar_cuentas: ['permitir', 'negar', 'negar'],
  conectar_mis_cuentas: ['permitir', 'permitir', 'negar'],
  delegar: ['permitir', 'permitir', 'negar'],
  conector_leer: ['permitir', 'permitir', 'negar'],
  conector_escribir: ['permitir', 'permitir', 'negar'], // el Colaborador pasa a aprobación en la herramienta
  agregar_conector: ['permitir', 'negar', 'negar'],
};
const NOMBRES = ['Propietario', 'Colaborador', 'Tercero'];

test('cada rol predefinido × cada acción da lo de la matriz', () => {
  const db = abrirBase(':memory:');
  const pol = crearPolitica(db);
  const roles = NOMBRES.map((n) => normalizar(db.prepare('SELECT permisos FROM roles WHERE nombre = ?').get(n).permisos));
  assert.deepEqual(Object.keys(MATRIZ).sort(), Object.keys(ACCIONES).sort(), 'la matriz cubre todas las acciones');
  for (const [accion, esperado] of Object.entries(MATRIZ)) {
    roles.forEach((p, i) => assert.equal(decidir(p, accion).decision, esperado[i], `${NOMBRES[i]} × ${accion}`));
  }
  assert.equal(pol.rolDe(null).nombre, 'Tercero', 'sin persona: Tercero');
});

test('una acción desconocida se niega', () => {
  assert.equal(decidir(TODOS, 'borrar_todo').decision, 'negar');
});

test('borrar o bajar de rol al último Propietario falla', () => {
  const db = abrirBase(':memory:');
  const roles = crearRoles({ db, politica: crearPolitica(db) });
  const yo = persona(db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario' });
  const actor = { personaId: yo, permisos: TODOS };
  assert.throws(() => roles.bajaPersona(actor, yo), /último Propietario/);
  assert.throws(() => roles.cambiarRol(actor, yo, idRol(db, 'Colaborador')), /al menos un Propietario/);
  const otra = persona(db, { nombre: 'Socia', telefono: '5491111112222', rol: 'Propietario' });
  roles.cambiarRol(actor, otra, idRol(db, 'Colaborador'));
  assert.equal(roles.propietariosActivos(), 1);
});

test('crear un rol con más permisos que su creador falla', () => {
  const db = abrirBase(':memory:');
  const roles = crearRoles({ db, politica: crearPolitica(db) });
  const colab = normalizar(db.prepare("SELECT permisos FROM roles WHERE nombre = 'Colaborador'").get().permisos);
  const actor = { personaId: 2, permisos: colab };
  assert.throws(() => roles.crearRol(actor, { nombre: 'Jefe', permisos: { ...colab, publicar_sistemas: 'directo' } }), /No podés dar permisos que no tenés: publicar_sistemas/);
  const id = roles.crearRol(actor, { nombre: 'Productor', permisos: { conversar: true, usar_web: true } });
  assert.ok(id);
  assert.deepEqual(excesos(colab, db.prepare('SELECT permisos FROM roles WHERE id = ?').get(id).permisos), []);
});

test('el rol Propietario no se edita y los predefinidos no se borran', () => {
  const db = abrirBase(':memory:');
  const roles = crearRoles({ db, politica: crearPolitica(db) });
  const actor = { personaId: 1, permisos: TODOS };
  assert.throws(() => roles.editarRol(actor, idRol(db, 'Propietario'), { permisos: { conversar: true } }), /no se puede editar/);
  assert.throws(() => roles.borrarRol(actor, idRol(db, 'Tercero')), /predefinidos/);
  roles.editarRol(actor, idRol(db, 'Tercero'), { permisos: { conversar: true, usar_web: true } });
  assert.equal(normalizar(db.prepare("SELECT permisos FROM roles WHERE nombre = 'Tercero'").get().permisos).usar_web, true, 'Colaborador y Tercero sí se editan');
});

test('panel: alta por número, cambio de rol, roles y "responder a números sin alta"', async () => {
  const t = armar();
  const yo = await entrarComoPropietario(t);
  const colab = idRol(t.db, 'Colaborador');
  const alta = await t.pedir('POST', '/api/personas', { nombre: 'Juan', telefono: '+54 9 11 2222-3333', rolId: colab });
  assert.equal(alta.status, 200);
  const lista = (await t.pedir('GET', '/api/personas')).json;
  const juan = lista.personas.find((p) => p.nombre === 'Juan');
  assert.equal(juan.telefono, '5491122223333');
  assert.equal(juan.rol, 'Colaborador');

  const nuevo = await t.pedir('POST', '/api/roles', { nombre: 'Productor', descripcion: 'Produce eventos', permisos: { conversar: true, usar_web: true } });
  assert.equal(nuevo.status, 200);
  assert.equal((await t.pedir('PATCH', `/api/personas/${juan.id}`, { rolId: nuevo.json.id })).status, 200);
  assert.equal(t.db.prepare('SELECT rol_id FROM personas WHERE id = ?').get(juan.id).rol_id, nuevo.json.id);
  assert.equal((await t.pedir('DELETE', `/api/roles/${nuevo.json.id}`)).status, 409, 'rol en uso');
  assert.equal((await t.pedir('PATCH', `/api/roles/${idRol(t.db, 'Propietario')}`, { permisos: {} })).status, 403);
  assert.equal((await t.pedir('DELETE', `/api/personas/${yo}`)).status, 409);

  await t.pedir('POST', '/api/cuenta/responder-sin-alta', { valor: false });
  assert.equal(t.db.prepare('SELECT responder_sin_alta FROM cuentas').get().responder_sin_alta, 0);

  const roles = (await t.pedir('GET', '/api/roles')).json;
  assert.equal(roles.catalogo.length, 14);
  assert.equal(roles.roles.find((r) => r.nombre === 'Tercero').enPalabras.find((x) => x.permiso === 'conversar').texto, 'sí');
  t.limpiar();
});

test('verificación del número del Propietario por WhatsApp', async () => {
  const t = armar();
  const yo = await entrarComoPropietario(t);
  // Ese número ya había escrito sin alta: su historial pasa al Propietario.
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  assert.equal((await t.pedir('POST', '/api/personas/yo/telefono', { telefono: '5491111111111' })).status, 200);
  const codigo = t.waha.enviados.at(-1).texto.match(/(\d{6})/)[1];
  assert.equal((await t.pedir('POST', '/api/personas/yo/verificar', { codigo: codigo === '000000' ? '111111' : '000000' })).status, 401);
  assert.equal((await t.pedir('POST', '/api/personas/yo/verificar', { codigo })).status, 200);
  const p = t.db.prepare('SELECT telefono, verificada FROM personas WHERE id = ?').get(yo);
  assert.deepEqual({ ...p }, { telefono: '5491111111111', verificada: 1 });
  assert.equal(t.db.prepare('SELECT persona_id FROM mensajes').get().persona_id, yo);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM personas WHERE activa = 1').get().n, 1);
  t.limpiar();
});

test('las rutas de personas y roles piden sesión', async () => {
  const t = armar();
  assert.equal((await t.pedir('GET', '/api/personas')).status, 401);
  assert.equal((await t.pedir('POST', '/api/roles', { nombre: 'x' })).status, 401);
  t.limpiar();
});
