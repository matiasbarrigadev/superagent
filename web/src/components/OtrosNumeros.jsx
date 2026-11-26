// Otros números de WhatsApp: acá solo se suman y se vinculan (QR o código). Qué hace cada uno —responder, solo
// leer, qué chats, si se guardan— se define conversando con el agente; un número nuevo arranca sin hacer nada.
import { useState } from 'react';
import { borrar, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import WhatsApp from './WhatsApp.jsx';
import { Aviso, Boton, Campo, Tarjeta } from './ui.jsx';

/** Para la tarjeta del número principal: cuántos números más hay y un atajo para sumar otro. */
export function SumarNumero() {
  const d = useDatos('/api/whatsapp/numeros');
  const otros = (d.datos?.numeros ?? []).filter((n) => !n.principal).length;
  const ir = () => {
    const el = document.getElementById('sumar-numero');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el?.querySelector('input')?.focus(), 400);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3 text-sm dark:border-stone-800">
      <span className="text-stone-600 dark:text-stone-400">{otros ? `${otros} número${otros > 1 ? 's' : ''} más vinculado${otros > 1 ? 's' : ''} abajo.` : 'Podés sumar más números (el de la empresa, tu personal…).'}</span>
      <Boton variante="secundario" onClick={ir}>Sumar otro número</Boton>
      <span className="w-full text-xs text-stone-500 dark:text-stone-400">O pedíselo al agente por WhatsApp: "quiero sumar otro número" y te guía con un código.</span>
    </div>
  );
}

const MODOS = { responder: 'Responde', leer: 'Solo lee', avisos: 'Solo avisos', nada: 'Sin actividad (falta configurarlo)' };

export default function OtrosNumeros() {
  const d = useDatos('/api/whatsapp/numeros');
  const [nombre, setNombre] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [quitando, setQuitando] = useState(null);
  const { cargando, error, correr } = useAccion();
  const otros = (d.datos?.numeros ?? []).filter((n) => !n.principal);

  const sumar = correr('sumar', async () => {
    await post('/api/whatsapp/numeros', { nombre: nombre.trim().toLowerCase(), etiqueta: etiqueta.trim() || nombre.trim() });
    setNombre(''); setEtiqueta(''); d.cargar();
  });

  return (
    <div className="grid gap-5">
      {otros.map((n) => (
        <WhatsApp key={n.nombre} base={`/api/whatsapp/numeros/${n.nombre}`} titulo={`WhatsApp · ${n.etiqueta ?? n.nombre}`}
          pie={(
            <div className="flex flex-col gap-2 border-t border-stone-100 pt-3 text-sm dark:border-stone-800">
              <p className="text-stone-600 dark:text-stone-400">
                {MODOS[n.politica?.modo] ?? n.politica?.modo}. Para cambiar qué hace este número, decíselo al agente por WhatsApp.
                {n.fuera_de_alcance ? ` ${n.fuera_de_alcance} mensajes quedaron afuera de lo que maneja.` : ''}
              </p>
              {quitando !== n.nombre ? (
                <div><Boton variante="fantasma" onClick={() => setQuitando(n.nombre)}>Quitar este número</Boton></div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span>Se desvincula y se borra su configuración. ¿Seguro?</span>
                  <Boton variante="peligro" cargando={cargando === `q${n.nombre}`} onClick={correr(`q${n.nombre}`, async () => { await borrar(`/api/whatsapp/numeros/${n.nombre}`); setQuitando(null); d.cargar(); })}>Sí, quitar</Boton>
                  <Boton variante="secundario" onClick={() => setQuitando(null)}>Cancelar</Boton>
                </div>
              )}
            </div>
          )} />
      ))}

      <div id="sumar-numero" className="scroll-mt-6"><Tarjeta titulo="Sumar otro número de WhatsApp">
        <form onSubmit={sumar} className="flex flex-col gap-3 text-sm">
          <p className="text-stone-600 dark:text-stone-400">
            Por ejemplo, el número de la empresa además del tuyo, o tu WhatsApp personal para que el agente solo lea los chats de clientes.
            Un número nuevo no hace nada hasta que le cuentes al agente qué querés que haga con él.
          </p>
          <Campo etiqueta="Nombre corto (minúsculas, sin espacios)" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="personal" required />
          <Campo etiqueta="Cómo lo llamás" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} placeholder="Mi WhatsApp personal" />
          <div><Boton cargando={cargando === 'sumar'} disabled={!nombre.trim()}>Sumar y vincular</Boton></div>
        </form>
        {error && <Aviso>{error}</Aviso>}
      </Tarjeta></div>
    </div>
  );
}
