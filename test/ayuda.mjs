// Arma una app de prueba con base en memoria, reloj falso y dobles de WAHA y de Claude.
// El Claude falso recibe la especificación de la corrida y ejecuta un "guion": llamadas a las herramientas
// del MCP del gateway con el token de esa corrida, igual que el binario real.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { abrirBase } from '../src/db/index.mjs';
import { crearAuth } from '../src/auth/servicio.mjs';
import { crearNucleo } from '../src/nucleo.mjs';
import { crearApp } from '../src/app.mjs';
import { argumentos } from '../src/engine/claude.mjs';

export const silencio = { log() {}, warn() {}, error() {} };

export function wahaFalso(extra = {}) {
  const enviados = [];
  return {
    enviados,
    estado: async () => ({ status: 'SCAN_QR_CODE', me: null }),
    asegurar: async () => {},
    escribiendo: async () => {},
    telefonoDeLid: async () => null,
    lidDeTelefono: async () => null,
    descargar: async () => ({ datos: Buffer.from(''), tipo: 'application/octet-stream' }),
    pedirCodigo: async () => ({ codigo: 'ABCD-1234' }),
    qr: async () => ({ tipo: 'image/png', datos: Buffer.from('png') }),
    enviarArchivo: async (chatId, archivo) => { enviados.push({ chatId, archivo: archivo.filename }); return `id-${enviados.length}`; },
    enviarTexto: async (chatId, texto, o = {}) => { enviados.push({ chatId, texto, ...(o.responderA ? { responderA: o.responderA } : {}), ...(o.menciones ? { menciones: o.menciones } : {}) }); return `true_${chatId}_ENV${enviados.length}`; },
    enviarImagen: async (chatId, archivo, o = {}) => { enviados.push({ chatId, imagen: archivo.filename, epigrafe: o.epigrafe ?? null }); return `true_${chatId}_ENV${enviados.length}`; },
    enviarVideo: async (chatId, archivo) => { enviados.push({ chatId, video: archivo.filename }); return `true_${chatId}_ENV${enviados.length}`; },
    enviarSticker: async (chatId, archivo) => { enviados.push({ chatId, sticker: archivo.filename }); return `true_${chatId}_ENV${enviados.length}`; },
    reaccionar: async (mensajeId, emoji) => { enviados.push({ reaccion: emoji, mensajeId }); return null; },
    enviarUbicacion: async (chatId, d) => { enviados.push({ chatId, ubicacion: d }); return `true_${chatId}_ENV${enviados.length}`; },
    enviarContacto: async (chatId, d) => { enviados.push({ chatId, contacto: d }); return `true_${chatId}_ENV${enviados.length}`; },
    enviarEncuesta: async (chatId, d) => { enviados.push({ chatId, encuesta: d }); return `true_${chatId}_ENV${enviados.length}`; },
    editarMensaje: async (chatId, mensajeId, texto) => { enviados.push({ chatId, editar: mensajeId, texto }); return mensajeId; },
    borrarMensaje: async (chatId, mensajeId) => { enviados.push({ chatId, borrar: mensajeId }); return mensajeId; },
    borrar: async () => {},
    ...extra,
  };
}

/** guion(spec, ctx) → [{ herramienta, args }] o una función async que use `llamar`. */
export function claudeFalso(nucleoRef, guion = () => []) {
  const corridas = [];
  async function ejecutar(spec, { sesion, nueva }) {
    const ctx = nucleoRef.n.mcp.contexto(spec.mcp.token);
    const registro = { spec, ctx, args: argumentos(spec, { sesion, nueva }), sesion, nueva, resultados: [] };
    if (spec.preparar) await spec.preparar({ ...spec.rutas, usuario: ctx.usuario });
    corridas.push(registro);
    const llamar = async (herramienta, args = {}) => {
      const r = await nucleoRef.n.mcp.llamar(ctx, herramienta, args);
      registro.resultados.push({ herramienta, r });
      return r;
    };
    const plan = await guion(spec, ctx, llamar);
    if (plan && typeof plan === 'object' && 'falla' in plan) {
      return { ok: false, tipoError: plan.falla, error: plan.error ?? plan.falla, herramientas: [], sessionId: sesion };
    }
    for (const p of Array.isArray(plan) ? plan : []) await llamar(p.herramienta, p.args);
    return { ok: true, sessionId: sesion, resultado: registro.resultadoFinal ?? 'ok', herramientas: registro.resultados.map((x) => x.herramienta) };
  }
  return { ejecutar, corridas };
}

export function armar({ waha = {}, claude = {}, guion = undefined, ahora = 1_800_000_000_000, correrMedios = undefined, fetchConectores = undefined, fetchGithub = undefined, correrPasos = undefined, fetchVerificacion = undefined, correrEsperas = undefined, cuentaClaude = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-prueba-'));
  const config = {
    setupCode: 'PRUE-BA12-3456',
    sessionSecret: 'secreto-de-prueba-'.repeat(3),
    cookieSegura: false,
    webDist: '/no/existe',
    dataDir,
    publicUrl: 'http://localhost:8080',
    mcpUrl: 'http://127.0.0.1:0/mcp',
    waha: { hmacKey: 'clave-hmac-prueba' },
  };
  const db = abrirBase(':memory:');
  // Los tests simulan una instalación que ya le responde a números sin alta (una nueva arranca en 0).
  db.prepare('UPDATE cuentas SET responder_sin_alta = 1 WHERE id = 1').run();
  const auth = crearAuth({ db, config, log: silencio });
  const w = wahaFalso(waha);
  const tiempo = { t: ahora };
  const reloj = () => tiempo.t;
  const ref = { n: null };
  const falso = claudeFalso(ref, guion);
  // Otros números de WhatsApp: un WAHA falso por sesión, con sus envíos aparte.
  const otrosWa = new Map();
  const crearClienteWa = (session) => { const f = wahaFalso(waha); otrosWa.set(session, f); return f; };
  const nucleo = crearNucleo({ db, config, waha: w, crearClienteWa, ejecutar: falso.ejecutar, cuentaClaude, reloj, log: silencio, correrMedios, fetchConectores, fetchGithub, correrPasos, fetchVerificacion, correrEsperas, dormir: async () => {} });
  ref.n = nucleo;
  const app = crearApp({
    db, config, auth, nucleo, log: silencio,
    waha: w,
    claude: { estado: async () => ({ conectado: false }), cerrarTerminal() {}, ...claude },
  });

  let cookie = '';
  async function pedir(metodo, ruta, body) {
    const r = await app.request(ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Host: 'localhost', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const tipo = r.headers.get('content-type') ?? '';
    return { status: r.status, json: tipo.includes('json') ? await r.json() : null };
  }

  /** Avanza el reloj falso y corre el motor hasta que no quede nada en vuelo. */
  async function avanzar(ms = 0) {
    tiempo.t += ms;
    // Varias vueltas: una corrida puede dejar un trabajo en cola, y el trabajo despierta otra corrida.
    for (let i = 0; i < 8; i++) {
      await nucleo.medios.esperar();
      nucleo.motor.tick();
      await nucleo.motor.esperar();
      await nucleo.salida.procesar();
      await new Promise((r) => setImmediate(r));
    }
  }

  return {
    db, config, app, pedir, nucleo, waha: w, otrosWa, corridas: falso.corridas, tiempo, avanzar,
    // La respuesta tal cual (con encabezados), con la sesión del panel.
    pedirCrudo: (metodo, ruta) => app.request(ruta, { method: metodo, headers: { Host: 'localhost', ...(cookie ? { Cookie: cookie } : {}) } }),
    olvidarCookie: () => { cookie = ''; },
    limpiar: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

// --- Datos de prueba comunes.
export function idRol(db, nombre) {
  return db.prepare('SELECT id FROM roles WHERE nombre = ?').get(nombre).id;
}

export function persona(db, { nombre, telefono, rol = 'Colaborador', verificada = 0 }) {
  return Number(db.prepare('INSERT INTO personas (nombre, telefono, rol_id, alta_manual, verificada, activa, creada) VALUES (?, ?, ?, 1, ?, 1, 0)')
    .run(nombre, telefono, idRol(db, rol), verificada).lastInsertRowid);
}

let n = 0;
/** Simula un mensaje entrante de WhatsApp pasando por la ingesta real. */
export async function escribe(nucleo, { telefono, texto, nombre = 'Alguien', grupo = null, mencion = false, media = null }) {
  n++;
  const chat = grupo ?? `${telefono}@c.us`;
  return nucleo.ingesta({
    event: 'message.any', session: 'default', me: { id: '5491100000001@c.us', pushName: 'Agente' },
    payload: {
      id: `false_${chat}_PRUEBA${n}`, timestamp: Math.floor(Date.now() / 1000), from: chat, fromMe: false,
      participant: grupo ? `${telefono}@c.us` : null,
      body: mencion ? `@5491100000001 ${texto}` : texto, hasMedia: !!media,
      media: media ? { url: `http://localhost:3000/api/files/default/PRUEBA${n}`, mimetype: media.mime, filename: media.nombre ?? null } : null,
      _data: { Info: { PushName: nombre } },
    },
  });
}

/** Hace el setup del Propietario por la API y deja la cookie puesta. Devuelve su persona_id. */
export async function entrarComoPropietario(t, { nombre = 'Dueña' } = {}) {
  const { totp, pasoActual } = await import('../src/auth/cripto.mjs');
  await t.pedir('POST', '/api/setup/codigo', { codigo: 'PRUE-BA12-3456' });
  const ini = await t.pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'duena@ejemplo.com', contrasena: 'contraseña-bien-larga' });
  await t.pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()), nombre });
  return t.db.prepare('SELECT persona_id FROM usuarios_web').get().persona_id;
}
