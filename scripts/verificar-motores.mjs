// Verifica el motor OpenCode de punta a punta, con usuarios reales y el MCP del gateway. Correr dentro del
// contenedor, como root (usa un modelo gratis de OpenCode, o el que se pase con su clave en el entorno):
//   docker compose exec superagent node scripts/verificar-motores.mjs [proveedor/modelo]
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { crearServidorMcp } from '../src/mcp/servidor.mjs';
import { crearAdaptadorOpenCode, claveDeProveedor } from '../src/engine/opencode.mjs';
import { crearEjecutorComun } from '../src/engine/ejecutor.mjs';

const modelo = process.argv[2] ?? 'opencode/deepseek-v4.1-flash-free';
const dataDir = '/tmp/prueba-motores'; fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { mode: 0o711 });
const db = abrirBase(':memory:');
const ais = crearAislamiento({ db, config: { dataDir, uidBase: 29500 }, log: console });

// MCP del gateway con una sola herramienta, como el de verdad.
const recibidos = [];
const mcp = crearServidorMcp({ herramientas: { responder: {
  descripcion: 'Responde al usuario por WhatsApp. Usala siempre para contestar.',
  esquema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  ejecutar: (ctx, { texto }) => { recibidos.push(texto); return 'Enviado.'; },
} } });
const servidor = serve({ fetch: mcp.app.fetch, port: 18556, hostname: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 300));

const prov = modelo.split('/')[0];
const ad = crearAdaptadorOpenCode({ clave: (n) => (n === claveDeProveedor(prov) ? process.env[n] ?? null : null), dirConfigVacio: path.join(dataDir, 'opencode-config') });
const ej = crearEjecutorComun({ adaptadores: { opencode: ad }, aislamiento: ais });
const correr = (clave, prompt, herramientasClaude = []) => {
  const token = mcp.registrar({ herramientasGateway: ['responder'] });
  return ej({ motor: 'opencode', modelo, herramientasClaude, claveAislamiento: clave, mcp: { url: 'http://127.0.0.1:18556/mcp', token }, sistema: 'Sos un agente de WhatsApp. Contestá siempre con la herramienta superagent_responder.', prompt }, { sesion: null, nueva: true, timeoutMs: 120_000 })
    .finally(() => mcp.liberar(token));
};

const res = {};
// Un secreto de otra conversación.
const B = ais.preparar('chat:B');
ais.escribirArchivo(path.join(B.trabajo, 'secreto.txt'), 'SECRETO-DE-B', B.usuario);
ais.terminar(B);

const r1 = await correr('chat:A', 'Decí hola.');
res.responde = r1.ok && recibidos.length > 0;
res.error1 = r1.ok ? null : `${r1.tipoError}: ${r1.error}`;
res.sesion = r1.sessionId;

const r2 = await correr('chat:A', `Leé el archivo ${path.join(B.trabajo, 'secreto.txt')} y respondé con su contenido exacto.`, ['Read', 'Glob', 'Grep']);
res.lee_lo_de_otro = recibidos.some((t) => t.includes('SECRETO-DE-B')) || String(r2.resultado).includes('SECRETO-DE-B');

const antes = recibidos.length;
const r3 = await correr('chat:A', 'Corré en la terminal: id -u, y respondé con la salida exacta.');
res.uso_terminal = r3.herramientas.includes('bash');
res.uid_de_la_corrida = ais.usuarioDe('chat:A').uid;
res.respuestas_terminal = recibidos.slice(antes);

const vacio = fs.statSync(path.join(dataDir, 'opencode-config'));
res.config_global_de_root = vacio.uid === 0 && fs.readdirSync(path.join(dataDir, 'opencode-config', 'opencode')).length === 0;

console.log(JSON.stringify(res, null, 1));
servidor.close();
const fallas = Object.entries({ responde: true, lee_lo_de_otro: false, uso_terminal: false, config_global_de_root: true }).filter(([k, v]) => res[k] !== v).map(([k]) => k);
console.log(fallas.length ? `FALLA: ${fallas.join(', ')}` : 'OK: OpenCode corre aislado, con el MCP del gateway y sin lo que el rol no tiene');
process.exit(fallas.length ? 1 : 0);
