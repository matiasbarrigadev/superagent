// Arranque del gateway de Superagent.
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { cargarConfig } from './config.mjs';
import { abrirBase } from './db/index.mjs';
import { crearAuth } from './auth/servicio.mjs';
import { crearWaha } from './wa/waha.mjs';
import { crearVigiaWhatsApp } from './wa/vigia.mjs';
import { crearProxyApps } from './apps/proxy.mjs';
import { crearCuentaClaude, crearPruebaClaude } from './claude/cuenta.mjs';
import { crearAjustes } from './util.mjs';
import { crearNucleo } from './nucleo.mjs';
import { crearApp, VERSION } from './app.mjs';

const require = createRequire(import.meta.url);
let pty = null;
try { pty = require('node-pty'); } catch (e) { console.warn('[arranque] node-pty no disponible:', e.message); }

// Todo lo que crea el gateway (base, secretos) queda solo para root; "agente" no lo puede leer.
process.umask(0o077);
const config = cargarConfig();
for (const n of ['apiKey', 'hmacKey']) {
  if (!config.waha[n]) console.warn(`[arranque] Falta ${n === 'apiKey' ? 'WAHA_API_KEY' : 'WHATSAPP_HOOK_HMAC_KEY'}: WhatsApp no va a funcionar hasta configurarla.`);
}

const db = abrirBase(config.dbPath);
const auth = crearAuth({ db, config });
// Último recurso: con SUPERAGENT_RESET_OWNER el panel vuelve a modo setup (una vez por valor de la variable).
if (process.env.SUPERAGENT_RESET_OWNER) auth.resetPropietario(process.env.SUPERAGENT_RESET_OWNER);
const waha = crearWaha({ ...config.waha });
// Otros números (sesiones de WAHA): el mismo WAHA, otra sesión.
const crearClienteWa = (session) => crearWaha({ ...config.waha, session });
const claude = crearCuentaClaude({ config, pty, ajustes: crearAjustes(db) });
const nucleo = crearNucleo({
  db, config, waha, crearClienteWa, cuentaClaude: claude, version: VERSION,
  alCambiarEstado: (s, evt) => { const n = evt?.session ?? config.waha.session; console.log(`[whatsapp] estado (${n}): ${s}`); vigiaDe(n)?.aviso(s); },
});
// Mantiene viva cada sesión: si WAHA la deja parada o en falla, la vuelve a arrancar sola (sin tocar las credenciales).
const vigia = crearVigiaWhatsApp({ waha });
const vigias = new Map([[config.waha.session, vigia]]);
function vigiaDe(nombre) {
  if (!vigias.has(nombre)) {
    if (!nucleo.numeros.obtener(nombre)) return null;
    const v = crearVigiaWhatsApp({ waha: nucleo.numeros.cliente(nombre) });
    vigias.set(nombre, v);
    v.iniciar();
  }
  return vigias.get(nombre);
}

claude.probar = crearPruebaClaude({ cuenta: claude, aislamiento: nucleo.aislamiento });
// Cada token nuevo se prueba antes de guardarlo, y el guardado se verifica solo cada tanto.
claude.usarValidador((token) => claude.probar(token));
const usuarios = nucleo.aislamiento.recrearUsuarios();
if (!nucleo.aislamiento.activo) console.warn('[aislamiento] Sin root en Linux: las corridas no tienen usuario propio (solo aceptable en desarrollo).');
else console.log(`[aislamiento] un usuario por conversación (${usuarios} ya creados)`);

// node-ws necesita la app para el upgrade; la app necesita upgradeWebSocket para definir la ruta.
let appRef;
const proxy = { fetch: (...a) => appRef.fetch(...a), request: (...a) => appRef.request(...a) };
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: proxy });
appRef = crearApp({ db, config, auth, waha, claude, nucleo, upgradeWebSocket });

const server = serve({ fetch: appRef.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[superagent ${VERSION}] escuchando en ${config.host}:${info.port} · panel: ${config.publicUrl}`);
});
injectWebSocket(server);
// Apps del agente en /apps/<nombre>/: el proxy va delante de todo, y el vigía las mantiene vivas.
crearProxyApps({ apps: nucleo.apps }).montar(server);
nucleo.apps.iniciar();

// MCP del gateway: solo en loopback, para las corridas de Claude Code.
const servidorMcp = serve({ fetch: nucleo.mcp.app.fetch, port: config.mcpPort, hostname: '127.0.0.1' }, (info) => {
  console.log(`[mcp] escuchando en 127.0.0.1:${info.port}`);
});

// Motor: lo que quedó a medias vuelve a la cola y todo avanza con un tick por segundo.
const recuperados = nucleo.motor.recuperar();
if (recuperados) console.log(`[motor] ${recuperados} chat(s) con mensajes en cola`);
const reloj = setInterval(() => nucleo.motor.tick(), 1000);
// Cada hora: los números que guardan por un tiempo borran lo viejo; y los números nuevos tienen su vigía.
const limpieza = setInterval(() => {
  try { const n = nucleo.numeros.limpiar(); if (n) console.log(`[whatsapp] ${n} mensaje(s) vencidos borrados`); } catch (e) { console.warn('[whatsapp] limpieza', e.message); }
  for (const x of nucleo.numeros.listar()) vigiaDe(x.nombre);
}, 3_600_000);
limpieza.unref?.();

// Al arrancar, se deja lista la sesión de WhatsApp (si WAHA ya responde).
// WAHA puede tardar en arrancar: se reintenta cada 5 s durante 3 minutos.
(async () => {
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await waha.asegurar();
      const e = await waha.estado();
      console.log(`[whatsapp] sesión lista (${e.status})`);
      // Con el número ya andando no llega el evento de estado: se ordena lo mismo acá.
      if (e.status === 'WORKING') { nucleo.alConectar?.(e); nucleo.alVincularNumero?.(config.waha.session); }
      vigia.iniciar();
      // Los otros números: cada uno con su sesión y su vigía.
      for (const n of nucleo.numeros.listar().filter((x) => !x.principal)) {
        try { await nucleo.numeros.cliente(n.nombre).asegurar(); } catch (err) { console.warn('[whatsapp]', n.nombre, err.message); }
        vigiaDe(n.nombre);
      }
      return;
    } catch (e) {
      if (i === 0 || i % 6 === 5) console.warn('[whatsapp]', e.message);
    }
  }
  // WAHA no respondió en 3 minutos: el vigía sigue intentando.
  vigia.iniciar();
})();

const cerrar = () => {
  clearInterval(reloj);
  claude.cerrarTerminal();
  servidorMcp.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
