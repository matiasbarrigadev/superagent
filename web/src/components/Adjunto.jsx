// Adjuntos de la bandeja, como en WhatsApp: fotos y stickers a la vista (con visor), audio y video con su
// reproductor, PDF con vista previa, y cualquier otro archivo como tarjeta para descargar. El servidor solo deja
// ver en la página lo que el navegador no puede ejecutar; lo demás siempre se descarga.
import { useEffect, useState } from 'react';
import { IconoAdjunto, IconoCerrar } from './iconos.jsx';
import { Girando } from './ui.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

export function pesoLegible(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

const tipoDe = (a) => {
  const m = String(a.mime ?? '').split(';')[0].trim().toLowerCase();
  if (a.tipo === 'sticker' || (m === 'image/webp' && /sticker/.test(a.nombre ?? ''))) return 'sticker';
  if (/^image\/(jpeg|png|gif|webp)$/.test(m)) return 'imagen';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  return 'otro';
};

const extension = (a) => (a.nombre?.includes('.') ? a.nombre.split('.').pop() : String(a.mime ?? '').split('/').pop()?.split(';')[0] ?? '').slice(0, 6).toUpperCase();

/** Visor a pantalla completa (foto o PDF). Se cierra con Escape o tocando afuera. */
function Visor({ titulo, descargar, onCerrar, children }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCerrar]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={titulo} onClick={onCerrar}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
        <span className="truncate">{titulo}</span>
        <div className="flex shrink-0 items-center gap-2">
          <a href={descargar} className="rounded-lg bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20">Descargar</a>
          <button type="button" onClick={onCerrar} className="rounded-lg p-1.5 hover:bg-white/10" aria-label="Cerrar"><IconoCerrar className="size-5" /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">{children}</div>
    </div>
  );
}

/** Tarjeta de archivo (icono con la extensión, nombre, peso y descargar). */
function Tarjeta({ a, descargar, accion }) {
  return (
    <div className="flex min-w-56 max-w-xs items-center gap-3 rounded-xl bg-stone-100/80 p-2.5 dark:bg-stone-900/50">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-emerald-600 text-[0.62rem] font-bold text-white">{extension(a) || <IconoAdjunto className="size-4" />}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{a.nombre ?? 'Archivo'}</p>
        <p className="text-xs text-stone-500 dark:text-stone-400">{[pesoLegible(a.tamano), a.mime?.split(';')[0]].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {accion}
        <a href={descargar} className="rounded-md px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950" download>Descargar</a>
      </div>
    </div>
  );
}

export default function Adjunto({ a }) {
  const [abierto, setAbierto] = useState(false);
  if (!a) return null;
  if (a.estado === 'pendiente') return <p className="mb-1 flex items-center gap-2 text-xs text-stone-500"><Girando className="size-3.5" /> Descargando adjunto…</p>;
  if (a.estado !== 'listo') return <p className="mb-1 flex items-center gap-1.5 text-xs text-stone-500"><IconoAdjunto className="size-3.5" /> {a.nombre ?? 'Adjunto'} (no se pudo descargar)</p>;
  const url = `/api/inbox/adjunto/${a.id}`;
  const descargar = `${url}?descargar=1`;
  const tipo = tipoDe(a);
  const nombre = a.nombre ?? 'archivo';
  const texto = a.texto && (
    <details className="mt-1 text-xs text-stone-600 dark:text-stone-400">
      <summary className="cursor-pointer select-none">{tipo === 'audio' || tipo === 'video' ? 'Transcripción' : 'Texto extraído'}</summary>
      <p className="mt-1 whitespace-pre-wrap">{a.texto}</p>
    </details>
  );

  if (tipo === 'imagen' || tipo === 'sticker') {
    return (
      <div className="mb-1">
        <button type="button" onClick={() => setAbierto(true)} className="block cursor-zoom-in overflow-hidden rounded-lg" aria-label={`Ver ${nombre}`}>
          <img src={url} alt={nombre} loading="lazy" className={cx('block object-cover', tipo === 'sticker' ? 'size-32 object-contain' : 'max-h-80 w-auto max-w-full')} />
        </button>
        {texto}
        {abierto && <Visor titulo={nombre} descargar={descargar} onCerrar={() => setAbierto(false)}><img src={url} alt={nombre} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} /></Visor>}
      </div>
    );
  }
  if (tipo === 'audio') {
    return (
      <div className="mb-1 min-w-60">
        <audio controls preload="none" src={url} className="h-10 w-full max-w-xs"><a href={descargar}>Descargar audio</a></audio>
        {texto}
      </div>
    );
  }
  if (tipo === 'video') {
    return (
      <div className="mb-1">
        <video controls preload="metadata" src={url} className="max-h-80 max-w-full rounded-lg bg-black"><a href={descargar}>Descargar video</a></video>
        {texto}
      </div>
    );
  }
  if (tipo === 'pdf') {
    return (
      <div className="mb-1">
        <Tarjeta a={a} descargar={descargar} accion={<button type="button" onClick={() => setAbierto(true)} className="rounded-md px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950">Ver</button>} />
        {texto}
        {abierto && <Visor titulo={nombre} descargar={descargar} onCerrar={() => setAbierto(false)}><iframe src={url} title={nombre} className="h-full w-full max-w-5xl rounded-lg bg-white" onClick={(e) => e.stopPropagation()} /></Visor>}
      </div>
    );
  }
  return <div className="mb-1"><Tarjeta a={a} descargar={descargar} />{texto}</div>;
}
