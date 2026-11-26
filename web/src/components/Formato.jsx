// Texto con el formato de WhatsApp: *negrita*, _cursiva_, ~tachado~, `código`, ```bloque```, listas y links.
// Arma nodos de React (nunca HTML crudo). [F-n] es un archivo que mandó el agente: se muestra como descarga.
import { Fragment } from 'react';

// Un marcador abre pegado a un caracter que no es espacio y cierra igual (como WhatsApp).
const INLINE = /(\[F-\d+\]|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|`[^`\n]+`|\*(?=\S)[^*\n]*?\S?\*(?![A-Za-z0-9])|_(?=\S)[^_\n]*?\S?_(?![A-Za-z0-9])|~(?=\S)[^~\n]*?\S?~(?![A-Za-z0-9]))/;

function enLinea(texto, clave) {
  const partes = texto.split(INLINE);
  return partes.map((p, i) => {
    const k = `${clave}-${i}`;
    if (i % 2 === 0) return p ? <Fragment key={k}>{p}</Fragment> : null;
    const archivo = /^\[F-(\d+)\]$/.exec(p);
    if (archivo) {
      return (
        <a key={k} href={`/api/archivos/${archivo[1]}`} className="inline-flex items-center gap-1 rounded-md bg-black/5 px-1.5 py-0.5 font-medium underline-offset-2 hover:underline dark:bg-white/10">
          <svg viewBox="0 0 20 20" fill="currentColor" className="size-3.5" aria-hidden="true"><path d="M10 3a1 1 0 0 1 1 1v7.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L9 11.6V4a1 1 0 0 1 1-1ZM4 15a1 1 0 0 1 1 1h10a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2 1 1 0 0 1 1-1Z" /></svg>
          Archivo
        </a>
      );
    }
    if (/^https?:\/\//.test(p)) {
      return <a key={k} href={p} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">{p}</a>;
    }
    const interior = p.slice(1, -1);
    if (p[0] === '`') return <code key={k} className="rounded bg-black/5 px-1 font-mono text-[0.85em] dark:bg-white/10">{interior}</code>;
    if (p[0] === '*') return <strong key={k} className="font-semibold">{enLinea(interior, k)}</strong>;
    if (p[0] === '_') return <em key={k}>{enLinea(interior, k)}</em>;
    if (p[0] === '~') return <s key={k}>{enLinea(interior, k)}</s>;
    return <Fragment key={k}>{p}</Fragment>;
  });
}

function bloque(texto, clave) {
  const lineas = texto.split('\n');
  const out = [];
  let lista = null;
  const cerrarLista = () => {
    if (!lista) return;
    const L = lista.ordenada ? 'ol' : 'ul';
    out.push(
      <L key={`${clave}-l${out.length}`} className={`my-1 space-y-0.5 pl-5 ${lista.ordenada ? 'list-decimal' : 'list-disc'}`}>
        {lista.items.map((it, j) => <li key={j}>{enLinea(it, `${clave}-li${out.length}-${j}`)}</li>)}
      </L>,
    );
    lista = null;
  };
  lineas.forEach((linea, i) => {
    const vineta = /^\s*[-•*]\s+(.*)$/.exec(linea);
    const numero = /^\s*\d+[.)]\s+(.*)$/.exec(linea);
    if (vineta || numero) {
      const ordenada = !!numero;
      if (lista && lista.ordenada !== ordenada) cerrarLista();
      lista ??= { ordenada, items: [] };
      lista.items.push((vineta ?? numero)[1]);
      return;
    }
    cerrarLista();
    const cita = /^>\s?(.*)$/.exec(linea);
    if (cita) {
      out.push(<span key={`${clave}-q${i}`} className="my-0.5 block border-l-2 border-current/40 pl-2 opacity-80">{enLinea(cita[1], `${clave}-q${i}`)}</span>);
      return;
    }
    out.push(<Fragment key={`${clave}-t${i}`}>{enLinea(linea, `${clave}-t${i}`)}{i < lineas.length - 1 ? '\n' : ''}</Fragment>);
  });
  cerrarLista();
  return out;
}

export default function Formato({ texto }) {
  const partes = String(texto ?? '').split(/```([\s\S]*?)```/);
  return (
    <span className="whitespace-pre-wrap break-words">
      {partes.map((p, i) => (i % 2 === 1
        ? <code key={i} className="my-1 block overflow-x-auto whitespace-pre rounded-lg bg-black/5 p-2 font-mono text-[0.8em] dark:bg-white/10">{p.replace(/^\n|\n$/g, '')}</code>
        : <Fragment key={i}>{bloque(p, `b${i}`)}</Fragment>))}
    </span>
  );
}
