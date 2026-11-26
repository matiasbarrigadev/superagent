// Piezas de conversación al estilo WhatsApp: fondo, burbujas, separador de día, avatar y "escribiendo".
import Formato from './Formato.jsx';
import { IconoAdjunto, IconoReloj } from './iconos.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

/** Fondo de la conversación: un tono cálido con un patrón suave de puntos. */
export function FondoChat({ children, className }) {
  return (
    <div className={cx('fondo-chat relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-8', className)} aria-live="polite">
      {children}
    </div>
  );
}

const PALETA = ['bg-emerald-600', 'bg-sky-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600', 'bg-orange-600'];
const TEXTOS = ['text-emerald-700 dark:text-emerald-400', 'text-sky-700 dark:text-sky-400', 'text-violet-700 dark:text-violet-400', 'text-amber-700 dark:text-amber-400',
  'text-rose-700 dark:text-rose-400', 'text-teal-700 dark:text-teal-400', 'text-indigo-700 dark:text-indigo-400', 'text-orange-700 dark:text-orange-400'];
const indice = (s) => [...String(s ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETA.length;
export const colorNombre = (s) => TEXTOS[indice(s)];

export function Avatar({ nombre, grupo, className }) {
  const iniciales = String(nombre ?? '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '#';
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', PALETA[indice(nombre)], className ?? 'size-11 text-sm')} aria-hidden="true">
      {grupo ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-1/2"><path d="M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.5.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 12.5c-3.3 0-6 2-6 4.5V19h12v-2c0-2.5-2.7-4.5-6-4.5Zm8.5.5c-.8 0-1.6.2-2.3.5 1.1 1 1.8 2.2 1.8 3.5V19H22v-1.7c0-2.4-2.5-4.3-5.5-4.3Z" /></svg>
      ) : iniciales}
    </span>
  );
}

export const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');

export function etiquetaDia(ms) {
  const d = new Date(ms);
  const hoy = new Date();
  const ayer = new Date(); ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString()) return 'Hoy';
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  const dif = (hoy - d) / 86_400_000;
  if (dif < 7) return d.toLocaleDateString('es', { weekday: 'long' });
  return d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: d.getFullYear() === hoy.getFullYear() ? undefined : 'numeric' });
}

/** Hora corta para la lista: hoy la hora, esta semana el día, si no la fecha. */
export function cuando(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return hora(ms);
  const dif = (hoy - d) / 86_400_000;
  if (dif < 2 && etiquetaDia(ms) === 'Ayer') return 'Ayer';
  if (dif < 7) return d.toLocaleDateString('es', { weekday: 'short' });
  return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function SeparadorDia({ ms }) {
  return (
    <div className="sticky top-0 z-10 my-3 flex justify-center first:mt-0">
      <span className="rounded-lg bg-white/90 px-3 py-1 text-xs font-medium text-stone-600 capitalize shadow-sm backdrop-blur dark:bg-stone-800/90 dark:text-stone-300">{etiquetaDia(ms)}</span>
    </div>
  );
}

/**
 * Una burbuja. `propia` = la manda el agente (a la derecha, verde). `autor` se muestra en grupos.
 * `seguida` = el mensaje anterior es del mismo lado: sin "cola" y con menos espacio.
 */
export function Burbuja({ propia, texto, ms, autor, adjunto, pendiente, seguida }) {
  return (
    <div className={cx('flex', propia ? 'justify-end' : 'justify-start', seguida ? 'mt-0.5' : 'mt-2')}>
      <div className={cx(
        'relative max-w-[85%] rounded-2xl px-3 pt-1.5 pb-1 text-[0.9rem] leading-snug shadow-sm sm:max-w-[70%]',
        propia ? 'bg-emerald-100 text-stone-900 dark:bg-emerald-900/70 dark:text-emerald-50' : 'bg-white text-stone-900 dark:bg-stone-800 dark:text-stone-100',
        !seguida && (propia ? 'rounded-tr-md' : 'rounded-tl-md'),
      )}>
        {autor && !propia && <p className={cx('mb-0.5 text-xs font-semibold', colorNombre(autor))}>{autor}</p>}
        {adjunto && (
          <p className="mb-1 flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400"><IconoAdjunto className="size-3.5" /> {adjunto}</p>
        )}
        {texto ? <Formato texto={texto} /> : !adjunto && <span className="italic text-stone-500">(sin texto)</span>}
        <span className="float-right mt-1.5 ml-3 inline-flex translate-y-0.5 items-center gap-1 text-[0.68rem] text-stone-500 dark:text-stone-400">
          {pendiente && <IconoReloj className="size-3" />}
          {hora(ms)}
        </span>
      </div>
    </div>
  );
}

export function Escribiendo({ texto = 'escribiendo' }) {
  return (
    <div className="mt-2 flex justify-start">
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-white px-3 py-2.5 text-sm text-stone-500 shadow-sm dark:bg-stone-800 dark:text-stone-400">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: `${d}ms` }} />)}
        </span>
        {texto}…
      </div>
    </div>
  );
}

/** Agrupa mensajes con separadores de día y marca los seguidos del mismo lado. */
export function conDias(mensajes, { ms, propia }) {
  const out = [];
  let diaPrevio = null;
  let previo = null;
  for (const m of mensajes) {
    const t = ms(m);
    const dia = t ? new Date(t).toDateString() : null;
    if (dia && dia !== diaPrevio) { out.push({ dia: t }); diaPrevio = dia; previo = null; }
    out.push({ m, seguida: previo != null && propia(previo) === propia(m) && (previo.autorClave ?? '') === (m.autorClave ?? '') });
    previo = m;
  }
  return out;
}
