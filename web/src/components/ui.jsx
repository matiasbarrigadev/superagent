// Piezas de interfaz compartidas.
import { useId } from 'react';

const cx = (...c) => c.filter(Boolean).join(' ');

export function Tarjeta({ titulo, accion, children, className }) {
  return (
    <section className={cx('rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:p-6 dark:border-stone-800 dark:bg-stone-900', className)}>
      {(titulo || accion) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {titulo && <h2 className="text-base font-semibold tracking-tight">{titulo}</h2>}
          {accion}
        </div>
      )}
      {children}
    </section>
  );
}

const VARIANTES = {
  primario: 'bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500',
  secundario: 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800',
  peligro: 'border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-stone-900 dark:text-red-400 dark:hover:bg-red-950',
  fantasma: 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800',
};

export function Boton({ variante = 'primario', cargando, className, children, ...props }) {
  return (
    <button
      {...props}
      disabled={props.disabled || cargando}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTES[variante], className,
      )}
    >
      {cargando && <Girando />}
      {children}
    </button>
  );
}

export function Campo({ etiqueta, ayuda, className, ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{etiqueta}</label>
      <input
        id={id}
        {...props}
        className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-stone-700 dark:bg-stone-950"
      />
      {ayuda && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{ayuda}</p>}
    </div>
  );
}

export function Aviso({ tipo = 'error', children }) {
  if (!children) return null;
  const estilos = {
    error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
    info: 'border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300',
  };
  return <div role={tipo === 'error' ? 'alert' : 'status'} className={cx('rounded-lg border px-3 py-2 text-sm', estilos[tipo])}>{children}</div>;
}

const COLORES_ESTADO = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  espera: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  neutro: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
};

export function Estado({ tono = 'neutro', children }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', COLORES_ESTADO[tono])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Girando({ className }) {
  return (
    <svg className={cx('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Marca() {
  return (
    <div className="flex items-center gap-2">
      <img src="/icono.svg" alt="" className="size-7" />
      <span className="text-lg font-semibold tracking-tight">Superagent</span>
    </div>
  );
}

export function Pantalla({ children }) {
  return (
    <div className="fondo-chat min-h-dvh">
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
        <Marca />
        {children}
      </main>
    </div>
  );
}

export function Selector({ etiqueta, opciones, className, ...props }) {
  const id = useId();
  return (
    <div className={className}>
      {etiqueta && <label htmlFor={id} className="mb-1 block text-sm font-medium">{etiqueta}</label>}
      <select
        id={id}
        {...props}
        className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-stone-700 dark:bg-stone-950"
      >
        {opciones.map((o) => <option key={String(o.valor)} value={String(o.valor)}>{o.texto}</option>)}
      </select>
    </div>
  );
}

export function AreaTexto({ etiqueta, ayuda, className, ...props }) {
  const id = useId();
  return (
    <div className={className}>
      {etiqueta && <label htmlFor={id} className="mb-1 block text-sm font-medium">{etiqueta}</label>}
      <textarea
        id={id}
        {...props}
        className="block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-stone-700 dark:bg-stone-950"
      />
      {ayuda && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{ayuda}</p>}
    </div>
  );
}

export function Interruptor({ prendido, alCambiar, etiqueta, disabled }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!prendido} aria-label={etiqueta} disabled={disabled}
      onClick={() => alCambiar(!prendido)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-50',
        prendido ? 'bg-emerald-600' : 'bg-stone-300 dark:bg-stone-700')}
    >
      <span className={cx('inline-block size-5 rounded-full bg-white shadow transition', prendido ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Vacio({ children }) {
  return <p className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">{children}</p>;
}

export const fechaCorta = (ms) => (ms ? new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—');
