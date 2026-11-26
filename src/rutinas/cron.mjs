// Cron de 5 campos (minuto hora día-del-mes mes día-de-semana) con zona horaria, sin dependencias.
// Soporta *, listas (1,2), rangos (1-5), pasos (*/15, 1-10/2) y 7 = domingo.

const CAMPOS = [
  { nombre: 'minuto', min: 0, max: 59 },
  { nombre: 'hora', min: 0, max: 23 },
  { nombre: 'día', min: 1, max: 31 },
  { nombre: 'mes', min: 1, max: 12 },
  { nombre: 'día de semana', min: 0, max: 7 },
];

function parsearCampo(txt, { nombre, min, max }) {
  const set = new Set();
  for (const parte of txt.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(parte.trim());
    if (!m) throw new Error(`Campo ${nombre} inválido: "${parte}".`);
    let [desde, hasta] = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
    if (hasta === undefined) hasta = m[2] ? max : desde;
    const paso = m[2] ? Number(m[2]) : 1;
    if (desde < min || hasta > max || desde > hasta || paso < 1) throw new Error(`Campo ${nombre} fuera de rango: "${parte}".`);
    for (let v = desde; v <= hasta; v += paso) set.add(v);
  }
  return set;
}

export function parsearCron(expr) {
  const partes = String(expr ?? '').trim().split(/\s+/);
  if (partes.length !== 5) throw new Error('La expresión cron tiene que tener 5 campos: minuto hora día mes día-de-semana.');
  const [mi, ho, di, me, ds] = partes.map((p, i) => parsearCampo(p, CAMPOS[i]));
  if (ds.has(7)) ds.add(0);
  return { mi, ho, di, me, ds, diaLibre: partes[2] === '*', semanaLibre: partes[4] === '*' };
}

export function zonaValida(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const formateadores = new Map();
function partesLocales(ms, tz) {
  let f = formateadores.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formateadores.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { mes: Number(o.month), dia: Number(o.day), hora: Number(o.hour), minuto: Number(o.minute), semana: dias[o.weekday] };
}

function coincideDia(c, l) {
  // Regla de cron: si se restringen día del mes y día de semana, alcanza con que coincida uno.
  const dm = c.di.has(l.dia), ds = c.ds.has(l.semana);
  if (c.diaLibre && c.semanaLibre) return true;
  if (c.diaLibre) return ds;
  if (c.semanaLibre) return dm;
  return dm || ds;
}

/** Próxima ejecución (ms) estrictamente después de `desde`, en la zona horaria dada. */
export function proxima(expr, tz = 'UTC', desde = Date.now()) {
  const c = typeof expr === 'string' ? parsearCron(expr) : expr;
  let t = Math.floor(desde / 60_000) * 60_000 + 60_000;
  const limite = desde + 400 * 86_400_000;
  while (t < limite) {
    const l = partesLocales(t, tz);
    if (!c.me.has(l.mes) || !coincideDia(c, l)) { t += (60 - l.minuto) * 60_000 + (23 - l.hora) * 3_600_000; continue; }
    if (!c.ho.has(l.hora)) { t += (60 - l.minuto) * 60_000; continue; }
    if (!c.mi.has(l.minuto)) { t += 60_000; continue; }
    return t;
  }
  return null;
}
