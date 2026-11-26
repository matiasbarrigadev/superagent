// Verifica el procesamiento real de adjuntos (whisper.cpp, poppler, tesseract, ffmpeg, python) con archivos
// generados en el momento. Correr dentro del contenedor, como root:
//   docker compose exec superagent node scripts/verificar-medios.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { crearProcesadorMedios } from '../src/medios/procesador.mjs';

const dir = '/tmp/verificar-medios';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { mode: 0o711 });

// --- Archivos de prueba: una imagen con texto, un PDF "escaneado" (solo imagen), un audio con voz y un video.
const py = `
from PIL import Image, ImageDraw, ImageFont
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 48)
img = Image.new("RGB", (1400, 500), "white")
d = ImageDraw.Draw(img)
d.text((60, 80), "PRESUPUESTO NUMERO 4521", fill="black", font=f)
d.text((60, 220), "Total a pagar: 98500 pesos", fill="black", font=f)
img.save("${dir}/imagen.png")
img.save("${dir}/escaneado.pdf", "PDF", resolution=150)
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Precios"
ws.append(["Producto", "Precio"]); ws.append(["Silla plegable", 1200])
wb.save("${dir}/precios.xlsx")
`;
execFileSync('python3', ['-c', py]);
fs.copyFileSync('/opt/whisper/muestras/jfk.wav', path.join(dir, 'audio.wav'));
execFileSync('ffmpeg', ['-nostdin', '-y', '-i', path.join(dir, 'audio.wav'), '-c:a', 'libopus', path.join(dir, 'audio.ogg')], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-nostdin', '-y', '-loop', '1', '-i', path.join(dir, 'imagen.png'), '-i', path.join(dir, 'audio.wav'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-vf', 'scale=1400:500', '-c:a', 'aac', '-shortest', path.join(dir, 'video.mp4')], { stdio: 'ignore' });

const db = abrirBase(':memory:');
const aislamiento = crearAislamiento({ db, config: { dataDir, uidBase: 29100 }, log: console });
const medios = crearProcesadorMedios({ db, config: { dataDir }, aislamiento, log: console });
db.prepare("INSERT INTO mensajes (session, id, chat_id, from_me, ts, recibido) VALUES ('t', 'x', 'c', 0, 0, 0)").run();
const casos = [
  ['audio', 'audio.ogg', /ask not what your country/i],
  ['pdf', 'escaneado.pdf', /PRESUPUESTO NUMERO 4521/i],
  ['imagen', 'imagen.png', /98500/],
  ['video', 'video.mp4', /Audio:.*country[\s\S]*Texto en pantalla:.*4521/i],
  ['documento', 'precios.xlsx', /Silla plegable \| 1200/],
];
let fallas = 0;
for (const [tipo, archivo, esperado] of casos) {
  const id = Number(db.prepare("INSERT INTO adjuntos (mensaje_seq, tipo, ruta, estado) VALUES (1, ?, ?, 'listo')").run(tipo, path.join(dir, archivo)).lastInsertRowid);
  const t0 = Date.now();
  await medios.procesar(id);
  const a = db.prepare('SELECT texto, procesado FROM adjuntos WHERE id = ?').get(id);
  const ok = a.procesado === 1 && esperado.test(a.texto ?? '');
  if (!ok) fallas++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${tipo.padEnd(9)} ${((Date.now() - t0) / 1000).toFixed(1)} s  ${JSON.stringify((a.texto ?? '').slice(0, 110))}`);
}
const u = aislamiento.usuarioDe('medios');
spawnSync('userdel', [u.nombre]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(fallas ? `FALLA: ${fallas} caso(s)` : 'OK: los medios pasan a texto');
process.exit(fallas ? 1 : 0);
