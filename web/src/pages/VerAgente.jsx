// "Ver al agente": qué está haciendo y qué hizo, como una conversación y no como una terminal. Cada turno se resume en
// una línea ("Recibió un mensaje de Ana, ejecutó 2 comandos y respondió") que se despliega en sus pasos. También los
// mensajes que el agente no recibió y por qué, y el estado del entorno. "Hablar con el agente" queda como pestaña.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useDatos } from '../hooks.js';
import { Aviso, Chip, Girando, fechaCorta } from '../components/ui.jsx';
import Chat from './Chat.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');
const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
const dia = (ms) => { const t = new Date(ms).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const duracion = (ms) => (ms == null ? '' : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

function Flecha({ abierta }) {
  return (
    <svg viewBox="0 0 20 20" className={cx('size-4 shrink-0 transition-transform', abierta && 'rotate-180')} fill="currentColor" aria-hidden="true">
      <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

/** Una llamada a una herramienta, con su resultado: el título siempre; el detalle, al tocarla. */
function Paso({ paso, resultado }) {
  const [abierto, setAbierto] = useState(false);
  const hayDetalle = paso.detalle || resultado?.detalle;
  return (
    <li className="border-b border-stone-100 last:border-0 dark:border-stone-800">
      <button type="button" onClick={() => hayDetalle && setAbierto(!abierto)} disabled={!hayDetalle}
        className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-sm', hayDetalle && 'hover:bg-stone-50 dark:hover:bg-stone-800/60')}>
        <span className="min-w-0 flex-1 truncate text-stone-700 dark:text-stone-300">{paso.titulo}</span>
        {resultado?.error ? <Chip tono="rojo">error</Chip> : null}
        {!resultado && paso.tipo === 'herramienta' && <span className="text-stone-400"><Girando className="size-3.5" /></span>}
        {hayDetalle && <span className="text-stone-400"><Flecha abierta={abierto} /></span>}
      </button>
      {abierto && (
        <div className="space-y-2 px-3 pb-3">
          {paso.detalle && <pre className="scroll-fino max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-stone-50 p-2.5 font-mono text-xs text-stone-700 dark:bg-stone-950 dark:text-stone-300">{paso.detalle}</pre>}
          {resultado?.detalle && (
            <pre className={cx('scroll-fino max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2.5 font-mono text-xs',
              resultado.error ? 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300' : 'bg-stone-50 text-stone-600 dark:bg-stone-950 dark:text-stone-400')}>
              {resultado.detalle}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/** El detalle de un turno: qué lo despertó y cada paso en orden (lo que dijo y las herramientas en grupo). */
function DetalleTurno({ id, enCurso }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let vivo = true;
    const traer = () => api(`/api/actividad/turnos/${id}`).then((x) => vivo && setD(x)).catch((e) => vivo && setError(e.message));
    traer();
    const t = enCurso ? setInterval(traer, 2000) : null;
    return () => { vivo = false; if (t) clearInterval(t); };
  }, [id, enCurso]);
  if (error) return <p className="px-1 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>;
  if (!d) return <div className="py-3 text-stone-400"><Girando /></div>;
  const resultados = new Map(d.pasos.filter((p) => p.tipo === 'resultado' && p.ref).map((p) => [p.ref, p]));
  // Bloques: texto suelto, o un grupo de herramientas seguidas.
  const bloques = [];
  for (const p of d.pasos) {
    if (p.tipo === 'texto') bloques.push({ texto: p });
    else if (p.tipo === 'herramienta') {
      const ult = bloques.at(-1);
      if (ult?.herramientas) ult.herramientas.push(p); else bloques.push({ herramientas: [p] });
    }
  }
  return (
    <div className="mt-3 space-y-3">
      {d.mensajes.length > 0 && (
        <div className="space-y-1.5">
          {d.mensajes.map((m, i) => (
            <div key={i} className={cx('rounded-lg border-l-2 px-3 py-1.5 text-sm', m.tipo === 'evento' ? 'border-sky-400 bg-sky-50/60 text-sky-900 dark:bg-sky-950/30 dark:text-sky-200' : 'border-emerald-500 bg-emerald-50/60 text-stone-800 dark:bg-emerald-950/30 dark:text-stone-200')}>
              <span className="mr-1.5 text-xs font-medium text-stone-500 dark:text-stone-400">{m.tipo === 'evento' ? 'Aviso del sistema' : m.de} · {hora(m.ts)}</span>
              <span className="whitespace-pre-wrap break-words">{m.texto}</span>
            </div>
          ))}
        </div>
      )}
      {bloques.map((b, i) => (b.texto
        ? <p key={i} className="whitespace-pre-wrap break-words text-sm text-stone-800 dark:text-stone-200">{b.texto.detalle}</p>
        : <ul key={i} className="overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800">{b.herramientas.map((p) => <Paso key={p.id} paso={p} resultado={p.ref ? resultados.get(p.ref) : null} />)}</ul>))}
      {!bloques.length && !enCurso && <p className="text-sm text-stone-500">Este turno no dejó pasos guardados (motor sin detalle, o turno viejo).</p>}
      {enCurso && <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><Girando className="size-3.5" />Sigue trabajando…</p>}
    </div>
  );
}

function Turno({ t }) {
  const enCurso = t.estado === 'corriendo';
  const [abierto, setAbierto] = useState(enCurso);
  return (
    <article className="rounded-2xl border border-stone-200/80 bg-white px-4 py-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
        <span className="font-medium text-stone-700 dark:text-stone-300">{t.chat ?? (t.tipo === 'trabajo' ? 'Trabajo' : 'Sin charla')}</span>
        <span>{hora(t.ts)}</span>
        {t.duracion != null && <span>· {duracion(t.duracion)}</span>}
        {t.rol && <span>· {t.rol}</span>}
        {enCurso && <Chip tono="verde">trabajando ahora</Chip>}
        {t.estado === 'error' && <Chip tono="rojo">falló</Chip>}
      </div>
      <button type="button" onClick={() => setAbierto(!abierto)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1 text-left text-sm text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800">
        <span className="min-w-0 break-words">{t.resumen}</span>
        <Flecha abierta={abierto} />
      </button>
      {t.noResponde && <p className="mt-2 text-sm italic text-stone-600 dark:text-stone-400">No respondió: {t.noResponde}</p>}
      {t.error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{t.error.slice(0, 300)}</p>}
      {abierto && <DetalleTurno id={t.id} enCurso={enCurso} />}
    </article>
  );
}

function Descarte({ d }) {
  return (
    <div className="flex items-start gap-2 px-2 text-xs text-stone-500 dark:text-stone-400">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-600" aria-hidden="true" />
      <p className="min-w-0">
        <span className="text-stone-400">{hora(d.ts)}</span> · No se le pasó al agente: <span className="text-stone-700 dark:text-stone-300">{d.de}</span>
        {d.chat && d.chat !== d.de ? ` en ${d.chat}` : ''} — “{d.texto.slice(0, 90)}{d.texto.length > 90 ? '…' : ''}” <span className="text-stone-600 dark:text-stone-300">({d.motivo})</span>
      </p>
    </div>
  );
}

/** Franja de estado: qué hace ahora y cómo están WhatsApp, el motor y el disco. */
function Estado() {
  const { datos: e } = useDatos('/api/actividad/estado', { cada: 5000 });
  const { datos: wa } = useDatos('/api/whatsapp/numeros', { cada: 20000 });
  if (!e) return null;
  const nums = wa?.numeros ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-4 py-2 text-xs dark:border-stone-800 dark:bg-stone-950/40">
      {e.pausada ? <Chip tono="ambar">en pausa</Chip> : e.enCurso.length ? <Chip tono="verde">trabajando: {e.enCurso.length === 1 ? (e.enCurso[0].chat ?? 'un turno') : `${e.enCurso.length} turnos`}</Chip> : <Chip>en reposo</Chip>}
      {nums.map((n) => (
        <Chip key={n.nombre} tono={n.estado === 'WORKING' ? 'verde' : n.estado === 'SCAN_QR_CODE' ? 'ambar' : 'rojo'} title={n.numero ? `+${n.numero}` : n.nombre}>
          WhatsApp {n.etiqueta || (n.principal ? '' : n.nombre)} {n.estado === 'WORKING' ? 'conectado' : n.estado === 'SCAN_QR_CODE' ? 'sin vincular' : (n.estado ?? 'sin datos').toLowerCase()}
        </Chip>
      ))}
      {e.motor?.bloqueado && <Chip tono="ambar">motor en espera</Chip>}
      {e.disco && <Chip tono={e.disco.pct >= 90 ? 'rojo' : e.disco.pct >= 80 ? 'ambar' : 'neutro'}>disco {e.disco.pct}%</Chip>}
      {e.trabajos > 0 && <Chip tono="azul">{e.trabajos} trabajo{e.trabajos > 1 ? 's' : ''} en curso</Chip>}
      {e.esperas.map((x, i) => <Chip key={i} tono="violeta">esperando {x.servicio}</Chip>)}
      {e.aprobaciones > 0 && <Chip tono="ambar">{e.aprobaciones} pedido{e.aprobaciones > 1 ? 's' : ''} por aprobar</Chip>}
    </div>
  );
}

function Actividad() {
  const [chat, setChat] = useState('');
  const [items, setItems] = useState(null);
  const [mas, setMas] = useState(null);
  const [error, setError] = useState(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const { datos: chats } = useDatos('/api/actividad/chats', { cada: 30000 });
  const extra = useRef([]); // lo cargado con "ver más" (no se pisa con el refresco)

  useEffect(() => {
    let vivo = true;
    extra.current = [];
    setItems(null);
    const traer = async () => {
      try {
        const r = await api(`/api/actividad?limite=30${chat ? `&chat=${encodeURIComponent(chat)}` : ''}`);
        if (!vivo) return;
        const ids = new Set(r.items.map((i) => `${i.clase}${i.id}`));
        setItems([...r.items, ...extra.current.filter((i) => !ids.has(`${i.clase}${i.id}`))]);
        if (!extra.current.length) setMas(r.mas);
        setError(null);
      } catch (e) { if (vivo) setError(e.message); }
    };
    traer();
    const t = setInterval(traer, 4000);
    return () => { vivo = false; clearInterval(t); };
  }, [chat]);

  async function verMas() {
    if (!mas) return;
    setCargandoMas(true);
    try {
      const r = await api(`/api/actividad?limite=30&antes=${mas}${chat ? `&chat=${encodeURIComponent(chat)}` : ''}`);
      extra.current = [...extra.current, ...r.items];
      setItems((x) => [...(x ?? []), ...r.items]);
      setMas(r.mas);
    } catch (e) { setError(e.message); } finally { setCargandoMas(false); }
  }

  // Separadores por día, como en un chat.
  const filas = [];
  let ultimoDia = null;
  for (const it of items ?? []) {
    const d = new Date(it.ts).toDateString();
    if (d !== ultimoDia) { filas.push({ dia: it.ts }); ultimoDia = d; }
    filas.push({ it });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-4 py-2 dark:border-stone-800">
        <label htmlFor="act-chat" className="text-sm text-stone-500">Charla</label>
        <select id="act-chat" value={chat} onChange={(e) => setChat(e.target.value)}
          className="min-w-0 max-w-xs rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800">
          <option value="">Todas</option>
          {(chats?.chats ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </div>
      <div className="scroll-fino min-h-0 flex-1 overflow-y-auto bg-stone-50/60 dark:bg-stone-950/30">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-5">
          {error && <Aviso>{error}</Aviso>}
          {!items && !error && <div className="py-10 text-center text-stone-400"><Girando className="mx-auto size-6" /></div>}
          {items && !items.length && <p className="py-10 text-center text-sm text-stone-500">Todavía no hay actividad{chat ? ' en esta charla' : ''}.</p>}
          {filas.map((f, i) => (f.dia
            ? <p key={`d${i}`} className="pt-2 text-center text-xs font-medium text-stone-400">{dia(f.dia)}</p>
            : f.it.clase === 'turno' ? <Turno key={`t${f.it.id}`} t={f.it} /> : <Descarte key={f.it.id} d={f.it} />))}
          {mas && (
            <div className="pt-2 text-center">
              <button type="button" onClick={verMas} disabled={cargandoMas} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800">
                {cargandoMas ? 'Cargando…' : 'Ver más'}
              </button>
            </div>
          )}
          {items?.length > 0 && <p className="pt-2 text-center text-xs text-stone-400">Los secretos se tachan y el detalle de cada paso se guarda {30} días. Última actualización {fechaCorta(Date.now())}.</p>}
        </div>
      </div>
    </div>
  );
}

export default function VerAgente() {
  const [pestana, setPestana] = useState('actividad');
  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-stone-900">
      <div className="flex items-center gap-1 border-b border-stone-200 px-3 pt-2 dark:border-stone-800" role="tablist">
        {[['actividad', 'Actividad'], ['hablar', 'Hablar con el agente']].map(([id, nombre]) => (
          <button key={id} type="button" role="tab" aria-selected={pestana === id} onClick={() => setPestana(id)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', pestana === id ? 'border-emerald-600 text-emerald-800 dark:text-emerald-300' : 'border-transparent text-stone-500 hover:text-stone-800 dark:hover:text-stone-200')}>
            {nombre}
          </button>
        ))}
      </div>
      {pestana === 'actividad' ? <><Estado /><Actividad /></> : <div className="min-h-0 flex-1"><Chat /></div>}
    </div>
  );
}
