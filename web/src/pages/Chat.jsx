// Chat del panel con el agente: el mismo motor que WhatsApp. Al principio es la conversación de configuración.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { Aviso, Girando } from '../components/ui.jsx';
import { Burbuja, conDias, Escribiendo, FondoChat, SeparadorDia } from '../components/Mensajes.jsx';
import { IconoChat, IconoEnviar } from '../components/iconos.jsx';

const SUGERENCIAS = ['Hola', '¿Qué podés hacer?', '¿Quiénes tienen acceso?'];

export default function Chat() {
  const [mensajes, setMensajes] = useState([]);
  const [cargado, setCargado] = useState(false);
  const [pensando, setPensando] = useState(false);
  const [enPausa, setEnPausa] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const ultimo = useRef(0);
  const fin = useRef(null);
  const vivo = useRef(true);
  const caja = useRef(null);

  async function traer() {
    try {
      const r = await api(`/api/chat?desde=${ultimo.current}`);
      if (!vivo.current) return;
      if (r.mensajes.length) {
        ultimo.current = r.mensajes.at(-1).seq;
        setMensajes((m) => [...m, ...r.mensajes]);
      }
      setPensando(r.pensando);
      setEnPausa(r.claudeEnPausa);
      setOnboarding(!r.onboardingHecho);
      setCargado(true);
    } catch (e) {
      if (vivo.current) setError(e.message);
    }
  }

  useEffect(() => {
    vivo.current = true;
    traer();
    return () => { vivo.current = false; };
  }, []);
  useEffect(() => {
    const t = setTimeout(traer, pensando ? 1500 : 5000);
    return () => clearTimeout(t);
  });
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [mensajes.length, pensando]);
  // La caja de texto crece con lo que se escribe, hasta un tope.
  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [texto]);

  async function enviar(e, valor = texto) {
    e?.preventDefault();
    const t = valor.trim();
    if (!t || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await post('/api/chat', { texto: t });
      setTexto('');
      setPensando(true);
      await traer();
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
      caja.current?.focus();
    }
  }

  // En el panel, quien escribe sos vos (derecha, verde) y el agente responde a la izquierda.
  const filas = useMemo(() => conDias(mensajes.map((m) => ({ ...m, autorClave: m.from_me ? 'agente' : 'yo' })),
    { ms: (m) => m.recibido, propia: (m) => !m.from_me }), [mensajes]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-stone-900">
      <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <span className="flex size-10 items-center justify-center rounded-full bg-emerald-600 text-white"><IconoChat className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{onboarding ? 'Configuración con el agente' : 'Tu agente'}</p>
          <p className="truncate text-xs text-stone-500 dark:text-stone-400">
            {pensando && !enPausa ? <span className="text-emerald-700 dark:text-emerald-400">escribiendo…</span>
              : onboarding ? 'Contale para qué lo vas a usar. Lo que proponga aparece como tarjetas en Inicio.' : 'El mismo agente que atiende el WhatsApp, con tus permisos.'}
          </p>
        </div>
      </header>

      <FondoChat className="scroll-fino">
        {!cargado && !error && <div className="m-auto text-stone-400"><Girando className="size-6" /></div>}
        {cargado && !mensajes.length && !pensando && (
          <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="rounded-xl bg-white/90 px-4 py-3 text-sm text-stone-600 shadow-sm dark:bg-stone-800/90 dark:text-stone-300">
              {onboarding ? 'Escribile "hola" para empezar la configuración. Te va a hacer unas preguntas cortas, de a una.' : 'Escribile algo al agente.'}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGERENCIAS.map((s) => (
                <button key={s} type="button" onClick={() => enviar(null, s)} className="rounded-full border border-emerald-600/30 bg-white px-3 py-1.5 text-sm text-emerald-800 shadow-sm hover:bg-emerald-50 dark:bg-stone-800 dark:text-emerald-300 dark:hover:bg-stone-700">{s}</button>
              ))}
            </div>
          </div>
        )}
        {filas.map((f, i) => (f.dia
          ? <SeparadorDia key={`d${i}`} ms={f.dia} />
          : <Burbuja key={f.m.seq} propia={!f.m.from_me} texto={f.m.cuerpo} ms={f.m.recibido} seguida={f.seguida} />))}
        {pensando && enPausa && (
          <div className="mt-3"><Aviso tipo="info">
            {enPausa === 'limite'
              ? 'Claude alcanzó el límite del plan. Tu mensaje queda en cola y se responde cuando vuelva.'
              : 'La cuenta de Claude no está conectada. Conectala en Inicio → Claude; tu mensaje queda en cola.'}
          </Aviso></div>
        )}
        {pensando && !enPausa && <Escribiendo />}
        <div ref={fin} />
      </FondoChat>

      <form onSubmit={enviar} className="flex items-end gap-2 border-t border-stone-200 bg-stone-50 px-3 py-3 sm:px-4 dark:border-stone-800 dark:bg-stone-900">
        <label htmlFor="chat-texto" className="sr-only">Mensaje</label>
        <textarea
          ref={caja} id="chat-texto" rows={1} value={texto} onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) enviar(e); }}
          placeholder="Escribí un mensaje"
          className="scroll-fino block max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-stone-200 bg-white px-4 py-2.5 text-base outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-stone-700 dark:bg-stone-800"
        />
        <button type="submit" disabled={!texto.trim() || enviando} aria-label="Enviar"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40">
          {enviando ? <Girando /> : <IconoEnviar className="size-5" />}
        </button>
      </form>
      {error && <div className="px-4 pb-3"><Aviso>{error}</Aviso></div>}
    </div>
  );
}
