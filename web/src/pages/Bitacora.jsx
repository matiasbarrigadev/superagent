// Bitácora de decisiones: lo que se aprobó, rechazó o decidió, en la charla con el agente o en el panel.
// Solo para mirar: nada de acá hay que confirmarlo.
import { useDatos } from '../hooks.js';
import { Estado, Girando, Tabla, Tarjeta, fechaCorta } from '../components/ui.jsx';

const RESULTADO = {
  aprobado: ['Aprobado', 'ok'],
  hecho: ['Hecho', 'ok'],
  rechazado: ['Rechazado', 'error'],
  decision: ['Decisión', 'neutro'],
};
const DONDE = { charla: 'en la charla', whatsapp: 'por WhatsApp', panel: 'en el panel', sistema: 'el sistema' };

export default function Bitacora() {
  const { datos, error } = useDatos('/api/bitacora', { cada: 15000 });
  const entradas = datos?.entradas ?? [];
  return (
    <Tarjeta titulo="Bitácora de decisiones">
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
        Lo que se aprobó, rechazó o decidió. Lo que le pedís al agente en la charla se hace sin confirmar nada aparte, y queda anotado acá.
      </p>
      {!datos && !error && <div className="py-6 text-center text-stone-400"><Girando className="size-6" /></div>}
      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {datos && (
        <Tabla
          filas={entradas}
          vacio="Todavía no hay decisiones anotadas."
          columnas={[
            { clave: 'que', titulo: 'Qué', principal: true, render: (e) => <p className="max-w-xl break-words">{e.que}</p> },
            { clave: 'resultado', titulo: 'Resultado', render: (e) => { const [txt, tono] = RESULTADO[e.resultado] ?? [e.resultado, 'neutro']; return <Estado tono={tono}>{txt}</Estado>; } },
            { clave: 'quien', titulo: 'Quién', render: (e) => (
              <div className="whitespace-nowrap">
                <div>{e.persona ?? 'alguien'}</div>
                {e.pedida_por_nombre && e.pedida_por !== e.persona_id && <div className="text-xs text-stone-500">lo pidió {e.pedida_por_nombre}</div>}
              </div>
            ) },
            { clave: 'donde', titulo: 'Dónde', render: (e) => <span className="whitespace-nowrap text-stone-600 dark:text-stone-400">{(DONDE[e.donde] ?? '').replace(/^(en|por) /, '') || '—'}{e.ref && /^[APR]-\d+$/.test(e.ref) ? ` · ${e.ref}` : ''}</span> },
            { clave: 'ts', titulo: 'Cuándo', alinear: 'derecha', render: (e) => <span className="whitespace-nowrap text-stone-600 dark:text-stone-400">{fechaCorta(e.ts)}</span> },
          ]}
        />
      )}
    </Tarjeta>
  );
}
