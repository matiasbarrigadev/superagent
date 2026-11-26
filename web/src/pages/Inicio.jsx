// Inicio: los pasos para dejar el agente andando, la pausa, las conexiones y lo pendiente.
import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Boton } from '../components/ui.jsx';
import WhatsApp from '../components/WhatsApp.jsx';
import OtrosNumeros, { SumarNumero } from '../components/OtrosNumeros.jsx';
import Claude from '../components/Claude.jsx';
import Pendientes from '../components/Pendientes.jsx';
import MiNumero from '../components/MiNumero.jsx';
import Consumo from '../components/Consumo.jsx';
import { IconoCheck } from '../components/iconos.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

function saludo() {
  const h = new Date().getHours();
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

/** Inicio de un invitado al panel: solo lo que le dieron (por ejemplo, vincular WhatsApp). */
function InicioInvitado({ usuario }) {
  const nombre = (usuario?.nombre || '').split(' ')[0];
  const a = Array.isArray(usuario?.accesos) ? usuario.accesos : [];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{saludo()}{nombre ? `, ${nombre}` : ''}</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">Esto es lo que podés ver y hacer en el panel del agente.</p>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {a.includes('whatsapp') && <div id="whatsapp" className="scroll-mt-6"><WhatsApp /></div>}
        {a.includes('whatsapp') && <div className="lg:col-span-2"><OtrosNumeros /></div>}
        {a.includes('claude') && <div id="claude" className="scroll-mt-6"><Claude /></div>}
        {a.includes('claude') && <div className="lg:col-span-2"><Consumo /></div>}
      </div>
      {!a.includes('whatsapp') && !a.includes('claude') && <p className="text-sm text-stone-500 dark:text-stone-400">Usá el menú para ir a tus secciones.</p>}
    </div>
  );
}

/** Checklist de puesta en marcha: desaparece cuando está todo listo. */
function PuestaEnMarcha({ r, irA }) {
  const [wa, setWa] = useState(null);
  const [cl, setCl] = useState(null);
  useEffect(() => {
    let vivo = true;
    const traer = async () => {
      const [a, b] = await Promise.all([api('/api/whatsapp/estado').catch(() => null), api('/api/claude/estado').catch(() => null)]);
      if (vivo) { setWa(a); setCl(b); }
    };
    traer();
    const t = setInterval(traer, 15000);
    return () => { vivo = false; clearInterval(t); };
  }, []);
  if (!r || !wa || !cl) return null;
  const pasos = [
    { hecho: !!cl.conectado && cl.funciona !== false, titulo: 'Conectar Claude', texto: 'La suscripción que usa el agente para pensar.', ir: '#claude' },
    { hecho: !!r.yo?.verificada, titulo: 'Tu número de WhatsApp',
      texto: r.yo?.pendiente ? (wa.status === 'WORKING' ? 'El agente te escribió: respondele con el código de la tarjeta.' : 'Listo: cuando vincules WhatsApp, el agente te escribe.') : 'Para que el agente sepa quién sos y te escriba.', ir: '#mi-numero' },
    { hecho: wa.status === 'WORKING', titulo: 'Vincular WhatsApp', texto: 'Escaneá el QR con el teléfono del agente. Al vincularlo, te escribe para presentarse.', ir: '#whatsapp' },
  ];
  const listos = pasos.filter((p) => p.hecho).length;
  if (listos === pasos.length) return null;
  return (
    <section className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm dark:border-emerald-900/60 dark:from-emerald-950/40 dark:to-stone-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Puesta en marcha</h2>
          <p className="text-sm text-stone-600 dark:text-stone-400">{listos} de {pasos.length} pasos listos.</p>
        </div>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-950" role="progressbar" aria-valuemin={0} aria-valuemax={pasos.length} aria-valuenow={listos}>
          <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${(listos / pasos.length) * 100}%` }} />
        </div>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2">
        {pasos.map((p, i) => {
          const contenido = (
            <>
              <span className={cx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                p.hecho ? 'bg-emerald-600 text-white' : 'border border-stone-300 bg-white text-stone-500 dark:border-stone-700 dark:bg-stone-900')}>
                {p.hecho ? <IconoCheck className="size-3.5" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cx('block text-sm font-medium', p.hecho && 'text-stone-500 line-through decoration-stone-300 dark:text-stone-400')}>{p.titulo}</span>
                {!p.hecho && <span className="block text-xs text-stone-500 dark:text-stone-400">{p.texto}</span>}
              </span>
            </>
          );
          const clase = 'flex w-full items-start gap-3 rounded-xl bg-white/70 p-3 text-left transition hover:bg-white dark:bg-stone-900/50 dark:hover:bg-stone-900';
          return (
            <li key={p.titulo}>
              {p.hecho ? <div className={cx(clase, 'opacity-70')}>{contenido}</div>
                : p.accion ? <button type="button" onClick={p.accion} className={clase}>{contenido}</button>
                  : <a href={p.ir} onClick={(e) => { e.preventDefault(); document.querySelector(p.ir)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className={clase}>{contenido}</a>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function Inicio({ resumen, irA, usuario }) {
  const r = resumen.datos;
  if (usuario?.accesos !== 'todo') return <InicioInvitado usuario={usuario} />;
  const nombre = (usuario?.nombre || '').split(' ')[0];
  const urgente = (r?.propuestas ?? 0) + (r?.aprobaciones ?? 0) > 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{saludo()}{nombre ? `, ${nombre}` : ''}</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {r?.pausada ? 'El agente está en pausa.' : r?.nombreAgente ? `${r.nombreAgente} está atendiendo.` : 'Así está tu agente.'}
          </p>
        </div>
        <Boton variante={r?.pausada ? 'primario' : 'secundario'} onClick={async () => { await post('/api/cuenta/pausa', { pausada: !r?.pausada }); resumen.cargar(); }}>
          {r?.pausada ? 'Reanudar el agente' : 'Pausar todo'}
        </Boton>
      </div>

      {r?.pausada && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          No se procesa nada. Quien escribe recibe un aviso y su mensaje queda guardado para cuando reanudes. También podés escribir "reanudá" desde tu WhatsApp.
        </div>
      )}

      <PuestaEnMarcha r={r} irA={irA} />

      {/* Lo que espera tu ok va arriba; si no hay nada, abajo de las conexiones. */}
      {urgente && <Pendientes />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {/* En la puesta en marcha, el número va antes que WhatsApp: al vincular, el agente ya sabe a quién escribirle. */}
        {r && !r.yo?.verificada && <div id="mi-numero" className="scroll-mt-6 lg:col-span-2"><MiNumero yo={r.yo} alCambiar={resumen.cargar} /></div>}
        <div id="claude" className="scroll-mt-6"><Claude /></div>
        <div id="whatsapp" className="scroll-mt-6"><WhatsApp pie={r?.yo?.verificada ? <SumarNumero /> : null} /></div>
        {r?.yo?.verificada && <div id="otros-numeros" className="scroll-mt-6 lg:col-span-2"><OtrosNumeros /></div>}
        <div className="lg:col-span-2"><Consumo /></div>
        {r?.yo?.verificada && <div id="mi-numero" className="scroll-mt-6 lg:col-span-2"><MiNumero yo={r.yo} alCambiar={resumen.cargar} /></div>}
      </div>
      {!urgente && <Pendientes />}
      {!r?.pausada && (
        <p className="text-xs text-stone-500 dark:text-stone-400">"Pausar todo" corta lo que está corriendo y deja de responder hasta que reanudes. También: "pausá todo" desde tu WhatsApp.</p>
      )}
    </div>
  );
}
