// Número personal del Propietario. Se carga antes de vincular WhatsApp: apenas el número del agente queda
// vinculado, el agente le escribe, y el Propietario confirma respondiendo con el código que se ve acá.
// Con el número confirmado, el agente lo reconoce y arranca la configuración por WhatsApp.
import { useEffect, useState } from 'react';
import { post } from '../api.js';
import { useAccion } from '../hooks.js';
import { Aviso, Boton, Campo, Estado, Tarjeta } from './ui.jsx';

export default function MiNumero({ yo, alCambiar }) {
  const [telefono, setTelefono] = useState('');
  const [pedido, setPedido] = useState(null); // { telefono, codigo, enviado }
  const [cambiando, setCambiando] = useState(false);
  const { cargando, error, correr } = useAccion();
  const pendiente = yo?.pendiente ?? null;

  // Mientras espera la respuesta por WhatsApp, se revisa solo si ya quedó confirmado.
  useEffect(() => {
    if (yo?.verificada || !(pedido || pendiente)) return undefined;
    const t = setInterval(() => alCambiar?.(), 5000);
    return () => clearInterval(t);
  }, [yo?.verificada, pedido, pendiente, alCambiar]);

  const pedir = (tel) => correr('pedir', async () => { setPedido(await post('/api/personas/yo/numero', { telefono: tel })); setCambiando(false); alCambiar?.(); });

  if (yo?.verificada && !cambiando) {
    return (
      <Tarjeta titulo="Tu número" accion={<Estado tono="ok">Confirmado</Estado>}>
        <p className="text-sm">+{yo.telefono}. Desde este número el agente te reconoce como Propietario.</p>
        <button type="button" className="mt-2 text-xs underline" onClick={() => { setCambiando(true); setPedido(null); }}>Cambiar de número</button>
      </Tarjeta>
    );
  }

  const esperando = !cambiando && (pedido || pendiente);
  return (
    <Tarjeta titulo="Tu número de WhatsApp" accion={<Estado tono="espera">{esperando ? 'Esperando tu respuesta' : 'Sin cargar'}</Estado>}>
      {!esperando ? (
        <>
          <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">
            Tu WhatsApp personal, para que el agente sepa quién sos. Apenas vincules el número del agente, te escribe para presentarse y configurarse con vos.
          </p>
          <form className="flex flex-wrap items-end gap-2" onSubmit={pedir(telefono)}>
            <Campo etiqueta="Número con código de país" inputMode="tel" placeholder="5491112345678" value={telefono} onChange={(e) => setTelefono(e.target.value)} className="min-w-56 flex-1" />
            <Boton cargando={cargando === 'pedir'} disabled={!telefono}>Guardar</Boton>
          </form>
        </>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p>+{pedido?.telefono ?? pendiente.telefono}</p>
          {pedido?.codigo ? (
            <>
              <p className="text-stone-600 dark:text-stone-400">
                {pedido.enviado || pendiente?.saludado
                  ? 'El agente ya te escribió por WhatsApp. Respondele con este código:'
                  : 'Cuando vincules el WhatsApp del agente, te va a escribir. Respondele con este código:'}
              </p>
              <p className="font-mono text-3xl font-semibold tracking-[0.3em]">{pedido.codigo}</p>
            </>
          ) : (
            <p className="text-stone-600 dark:text-stone-400">
              {pendiente?.saludado ? 'El agente ya te escribió por WhatsApp.' : 'Cuando vincules el WhatsApp del agente, te va a escribir.'} Para ver el código de nuevo, pedí uno nuevo.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Boton variante="secundario" cargando={cargando === 'pedir'} onClick={pedir(pedido?.telefono ?? pendiente.telefono)}>Código nuevo</Boton>
            <Boton variante="fantasma" onClick={() => { setPedido(null); setCambiando(true); }}>Cambiar número</Boton>
          </div>
        </div>
      )}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}
