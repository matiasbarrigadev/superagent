// Bandeja: las conversaciones de WhatsApp del agente, como en WhatsApp. Lista a la izquierda y la conversación
// a la derecha (en el teléfono, una a la vez). Solo lectura: el agente es quien responde.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, patch } from '../api.js';
import { Aviso, Girando, Interruptor } from '../components/ui.jsx';
import { Avatar, Burbuja, conDias, cuando, Escribiendo, FondoChat, SeparadorDia } from '../components/Mensajes.jsx';
import { IconoAtras, IconoBandeja, IconoBuscar } from '../components/iconos.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');
const nombreDe = (c) => c.nombre || c.persona || (c.tipo !== 'grupo' && c.contacto) || (c.telefono ? `+${c.telefono}` : c.id.split('@')[0]);
const ADJUNTOS = { image: 'Foto', audio: 'Audio', ptt: 'Audio', voice: 'Audio', video: 'Video', document: 'Documento', sticker: 'Sticker' };
const adjuntoDe = (tipo, media) => ADJUNTOS[tipo] ?? (media?.startsWith('image') ? 'Foto' : media?.startsWith('audio') ? 'Audio' : media?.startsWith('video') ? 'Video' : 'Archivo');

function vistaPrevia(c) {
  if (c.pensando) return <span className="font-medium text-emerald-700 dark:text-emerald-400">escribiendo…</span>;
  if (!c.ultimo) return <span className="italic">Sin mensajes</span>;
  const quien = c.ultimo_mio ? 'Agente: ' : c.tipo === 'grupo' && c.ultimo_remitente ? `${c.ultimo_remitente.split(' ')[0]}: ` : '';
  const texto = c.ultimo_texto?.replace(/[*_~`]/g, '') || (c.ultimo_adjunto ? '📎 Adjunto' : '');
  return <>{quien && <span className="text-stone-500 dark:text-stone-400">{quien}</span>}{texto}</>;
}

function Lista({ chats, elegido, alElegir, filtro, setFiltro }) {
  const visibles = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return !f ? chats : chats.filter((c) => [nombreDe(c), c.telefono, c.contacto, c.cliente, c.ultimo_texto].some((v) => v && String(v).toLowerCase().includes(f)));
  }, [chats, filtro]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-stone-200 p-3 dark:border-stone-800">
        <label className="relative block">
          <span className="sr-only">Buscar conversación</span>
          <IconoBuscar className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
          <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar un chat o un mensaje"
            className="w-full rounded-xl border-0 bg-stone-100 py-2 pr-3 pl-9 text-sm outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-emerald-600/30 dark:bg-stone-800" />
        </label>
      </div>
      <ul className="scroll-fino min-h-0 flex-1 overflow-y-auto" aria-label="Conversaciones">
        {visibles.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => alElegir(c.id)} aria-current={elegido === c.id ? 'true' : undefined}
              className={cx('flex w-full items-center gap-3 px-3 py-2.5 text-left transition',
                elegido === c.id ? 'bg-stone-100 dark:bg-stone-800' : 'hover:bg-stone-50 dark:hover:bg-stone-800/50')}>
              <Avatar nombre={nombreDe(c)} grupo={c.tipo === 'grupo'} />
              <span className="min-w-0 flex-1 border-b border-stone-100 pb-2.5 dark:border-stone-800/70">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{nombreDe(c)}</span>
                  <span className={cx('shrink-0 text-xs', c.sin_leer ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-stone-500 dark:text-stone-400')}>{cuando(c.ultimo)}</span>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-stone-600 dark:text-stone-300">{vistaPrevia(c)}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {!c.activo && <span className="rounded bg-stone-200 px-1.5 text-[0.65rem] font-medium text-stone-600 dark:bg-stone-700 dark:text-stone-300">apagado</span>}
                    {c.sin_leer > 0 && <span className="min-w-5 rounded-full bg-emerald-600 px-1.5 text-center text-xs font-semibold text-white">{c.sin_leer}</span>}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {!visibles.length && (
          <li className="px-6 py-10 text-center text-sm text-stone-500 dark:text-stone-400">
            {chats.length ? 'Nada coincide con la búsqueda.' : 'Todavía no hay conversaciones. Cuando alguien le escriba al número del agente, aparecen acá.'}
          </li>
        )}
      </ul>
    </div>
  );
}

function Conversacion({ chatId, alVolver, alCambiar }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const fin = useRef(null);

  useEffect(() => {
    let vivo = true;
    setDatos(null);
    setError(null);
    const traer = async () => {
      try {
        const d = await api(`/api/inbox/mensajes?chat=${encodeURIComponent(chatId)}`);
        if (vivo) setDatos(d);
      } catch (e) { if (vivo) setError(e.message); }
    };
    traer();
    const t = setInterval(traer, 4000);
    return () => { vivo = false; clearInterval(t); };
  }, [chatId]);

  const cantidad = (datos?.mensajes.length ?? 0) + (datos?.pendientes.length ?? 0) + (datos?.pensando ? 1 : 0);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [cantidad, chatId]);

  const chat = datos?.chat;
  const grupo = chat?.tipo === 'grupo';
  const filas = useMemo(() => conDias(
    (datos?.mensajes ?? []).map((m) => ({ ...m, autorClave: m.from_me ? 'yo' : (m.persona || m.nombre_remitente || m.telefono || '') })),
    { ms: (m) => m.recibido, propia: (m) => m.from_me },
  ), [datos]);

  async function cambiarActivo(activo) {
    await patch(`/api/chats/${encodeURIComponent(chatId)}`, { activo });
    setDatos((d) => ({ ...d, chat: { ...d.chat, activo } }));
    alCambiar();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-3 py-2.5 dark:border-stone-800 dark:bg-stone-900">
        <button type="button" onClick={alVolver} className="rounded-lg p-1.5 text-stone-600 hover:bg-stone-100 lg:hidden dark:text-stone-300 dark:hover:bg-stone-800" aria-label="Volver a la lista">
          <IconoAtras />
        </button>
        {chat ? (
          <>
            <Avatar nombre={nombreDe(chat)} grupo={grupo} className="size-10 text-sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{nombreDe(chat)}</p>
              <p className="truncate text-xs text-stone-500 dark:text-stone-400">
                {datos.pensando ? <span className="text-emerald-700 dark:text-emerald-400">el agente está escribiendo…</span>
                  : [grupo ? 'Grupo' : chat.telefono && `+${chat.telefono}`, chat.rol ?? (!grupo && !chat.persona ? 'Sin alta' : null), chat.cliente && `Cliente: ${chat.cliente}`].filter(Boolean).join(' · ')}
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-stone-600 dark:text-stone-300">
              <span className="hidden sm:inline">{chat.activo ? 'Agente activo' : 'Agente apagado'}</span>
              <Interruptor prendido={chat.activo} alCambiar={cambiarActivo} etiqueta="El agente responde en este chat" />
            </label>
          </>
        ) : <div className="h-10" />}
      </header>
      <FondoChat className="scroll-fino">
        {!datos && !error && <div className="m-auto text-stone-400"><Girando className="size-6" /></div>}
        {error && <div className="m-auto"><Aviso>{error}</Aviso></div>}
        {datos && !datos.mensajes.length && <p className="m-auto rounded-lg bg-white/80 px-3 py-2 text-sm text-stone-500 dark:bg-stone-800/80">Todavía no hay mensajes.</p>}
        {filas.map((f, i) => (f.dia
          ? <SeparadorDia key={`d${i}`} ms={f.dia} />
          : <Burbuja key={f.m.seq} propia={f.m.from_me} texto={f.m.cuerpo} ms={f.m.recibido} seguida={f.seguida}
              autor={grupo && !f.seguida ? f.m.autorClave : null}
              adjunto={f.m.tiene_adjunto ? adjuntoDe(f.m.tipo, f.m.media_tipo) : null}
              archivo={f.m.adjunto} reacciones={f.m.reacciones} editado={f.m.editado} borrado={f.m.borrado} />))}
        {datos?.pendientes.map((p) => <Burbuja key={`p${p.id}`} propia texto={p.tipo === 'texto' ? p.contenido : null} adjunto={p.tipo !== 'texto' ? ({ imagen: 'Foto', video: 'Video', sticker: 'Sticker', voz: 'Nota de voz', ubicacion: 'Ubicación', contacto: 'Contacto', encuesta: 'Encuesta', reaccion: 'Reacción', editar: 'Edición', borrar: 'Borrado' }[p.tipo] ?? 'Archivo') : null} ms={p.creado} pendiente />)}
        {datos?.pensando && <Escribiendo />}
        <div ref={fin} />
      </FondoChat>
      <footer className="border-t border-stone-200 bg-stone-50 px-4 py-2.5 text-center text-xs text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
        {chat?.activo === false ? 'El agente no responde en este chat. Prendelo arriba a la derecha.' : 'El agente responde estos mensajes por WhatsApp. Desde acá ves la conversación.'}
      </footer>
    </div>
  );
}

export default function Bandeja() {
  const [chats, setChats] = useState(null);
  const [error, setError] = useState(null);
  const [elegido, setElegido] = useState(() => { try { return sessionStorage.getItem('bandeja:chat'); } catch { return null; } });
  const [filtro, setFiltro] = useState('');

  const cargar = async () => {
    try { setChats((await api('/api/inbox')).chats); setError(null); } catch (e) { setError(e.message); }
  };
  useEffect(() => { cargar(); const t = setInterval(cargar, 5000); return () => clearInterval(t); }, []);
  const elegir = (id) => {
    setElegido(id);
    try { if (id) sessionStorage.setItem('bandeja:chat', id); else sessionStorage.removeItem('bandeja:chat'); } catch {}
    setChats((cs) => cs?.map((c) => (c.id === id ? { ...c, sin_leer: 0 } : c)));
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white dark:bg-stone-900">
      <aside className={cx('h-full min-h-0 w-full border-r border-stone-200 lg:w-[22rem] lg:shrink-0 dark:border-stone-800', elegido ? 'hidden lg:block' : 'block')}>
        {chats ? <Lista chats={chats} elegido={elegido} alElegir={elegir} filtro={filtro} setFiltro={setFiltro} />
          : <div className="flex h-full items-center justify-center text-stone-400">{error ? <Aviso>{error}</Aviso> : <Girando className="size-6" />}</div>}
      </aside>
      <section className={cx('h-full min-h-0 min-w-0 flex-1', elegido ? 'block' : 'hidden lg:block')}>
        {elegido ? <Conversacion key={elegido} chatId={elegido} alVolver={() => elegir(null)} alCambiar={cargar} /> : (
          <div className="fondo-chat flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="rounded-full bg-white p-4 text-emerald-600 shadow-sm dark:bg-stone-800 dark:text-emerald-400"><IconoBandeja className="size-8" /></span>
            <p className="text-lg font-semibold">Bandeja de WhatsApp</p>
            <p className="max-w-sm text-sm text-stone-600 dark:text-stone-400">Elegí una conversación para ver qué le escribieron al agente y qué respondió.</p>
          </div>
        )}
      </section>
    </div>
  );
}
