// Consumo de Claude: porcentaje del plan (si la cuenta lo informa) y lo gastado por las corridas.
import { useDatos } from '../hooks.js';
import { Tarjeta } from './ui.jsx';

const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n ?? 0));
const cuando = (ms) => (ms ? new Date(ms).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null);

function Barra({ titulo, v, umbral }) {
  if (v?.pct == null) return null;
  const pct = Math.min(100, Math.max(0, v.pct));
  const color = pct >= 95 ? 'bg-red-500' : pct >= (umbral || 80) ? 'bg-amber-500' : 'bg-emerald-600';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{titulo}</span>
        <span className="tabular-nums text-stone-600 dark:text-stone-300">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={titulo}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {v.reinicia && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Se renueva {cuando(v.reinicia)}</p>}
    </div>
  );
}

export default function Consumo() {
  const { datos } = useDatos('/api/claude/uso', { cada: 60_000 });
  if (!datos) return null;
  const { plan, local, avisoPct, compactarPct } = datos;
  return (
    <Tarjeta titulo="Consumo de Claude">
      <div className="grid gap-4">
        {plan ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Barra titulo="Ventana de 5 horas" v={plan.cincoHoras} umbral={avisoPct} />
            <Barra titulo="Semana" v={plan.semana} umbral={avisoPct} />
          </div>
        ) : (
          <p className="text-sm text-stone-600 dark:text-stone-400">La cuenta de Claude no informa el porcentaje del plan: abajo va lo medido por el agente.</p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-stone-500 dark:text-stone-400">Corridas (5 h)</dt><dd className="font-medium tabular-nums">{local.cincoHoras.corridas}</dd></div>
          <div><dt className="text-xs text-stone-500 dark:text-stone-400">Tokens (5 h)</dt><dd className="font-medium tabular-nums">{k(local.cincoHoras.entrada + local.cincoHoras.cache + local.cincoHoras.salida)}</dd></div>
          <div><dt className="text-xs text-stone-500 dark:text-stone-400">Equivale a (5 h)</dt><dd className="font-medium tabular-nums">US$ {local.cincoHoras.costo.toFixed(2)}</dd></div>
          <div><dt className="text-xs text-stone-500 dark:text-stone-400">Semana</dt><dd className="font-medium tabular-nums">US$ {local.semana.costo.toFixed(2)}</dd></div>
        </dl>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Avisa desde el {avisoPct || '—'}% · compacta el contexto al {compactarPct}%. Se cambia hablando con el agente. Los dólares son a precio de API, como referencia: con la suscripción no se cobran aparte.
        </p>
      </div>
    </Tarjeta>
  );
}
