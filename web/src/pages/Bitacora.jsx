// Bitácora de decisiones: lo que se aprobó, rechazó o decidió, en la charla con el agente o en el panel.
// Solo para mirar: nada de acá hay que confirmarlo.
import { useDatos } from '../hooks.js';
import { Estado, Girando, Tarjeta, Vacio, fechaCorta } from '../components/ui.jsx';

const RESULTADO = {
  aprobado: ['Aprobado', 'ok'],
  hecho: ['Hecho', 'ok'],
  rechazado: ['Rechazado', 'error'],
  decision: ['Decisión', 'neutro'],
};
const DONDE = { charla: 'en la charla', whatsapp: 'por WhatsApp', panel: 'en el panel' };

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
      {datos && !entradas.length && <Vacio>Todavía no hay decisiones anotadas.</Vacio>}
      {entradas.length > 0 && (
        <ol className="divide-y divide-stone-200 dark:divide-stone-800">
          {entradas.map((e) => {
            const [txt, tono] = RESULTADO[e.resultado] ?? [e.resultado, 'neutro'];
            return (
              <li key={e.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="w-28 shrink-0"><Estado tono={tono}>{txt}</Estado></div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm">{e.que}</p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                    {fechaCorta(e.ts)} · {e.persona ?? 'alguien'} {DONDE[e.donde] ?? ''}
                    {e.pedida_por_nombre && e.pedida_por !== e.persona_id ? ` · lo pidió ${e.pedida_por_nombre}` : ''}
                    {e.ref && /^[AP]-\d+$/.test(e.ref) ? ` · ${e.ref}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Tarjeta>
  );
}
