// Terminal web (xterm.js) conectada por WebSocket a `claude setup-token` en el servidor.
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export default function Terminal({ alTerminar }) {
  const caja = useRef(null);
  const [estado, setEstado] = useState('conectando');

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0c0a09', foreground: '#e7e5e4', cursor: '#34d399', selectionBackground: '#44403c' },
    });
    const ajuste = new FitAddon();
    term.loadAddon(ajuste);
    term.loadAddon(new WebLinksAddon((_e, url) => window.open(url, '_blank', 'noopener,noreferrer')));
    term.open(caja.current);
    ajuste.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/claude/terminal?cols=${term.cols}&rows=${term.rows}`);
    const enviar = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    ws.onopen = () => { setEstado('abierta'); term.focus(); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'd') term.write(m.d);
      if (m.t === 'fin') {
        term.write(`\r\n\x1b[90m[terminó con código ${m.codigo}]\x1b[0m\r\n`);
        setEstado('terminada');
        alTerminar?.(m.codigo);
      }
    };
    ws.onclose = () => setEstado((s) => (s === 'terminada' ? s : 'cerrada'));
    const entrada = term.onData((d) => enviar({ t: 'd', d }));

    const alRedimensionar = () => {
      ajuste.fit();
      enviar({ t: 'r', cols: term.cols, rows: term.rows });
    };
    const obs = new ResizeObserver(alRedimensionar);
    obs.observe(caja.current);

    return () => {
      obs.disconnect();
      entrada.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div ref={caja} className="h-80 w-full overflow-hidden rounded-xl bg-stone-950 p-2" />
      <p className="text-xs text-stone-500 dark:text-stone-400">
        {estado === 'conectando' && 'Conectando…'}
        {estado === 'abierta' && 'Abrí el enlace, autorizá y pegá el código acá (Ctrl+V o clic derecho).'}
        {estado === 'terminada' && 'Listo. El estado de Claude se actualizó arriba.'}
        {estado === 'cerrada' && 'La conexión con la terminal se cerró.'}
      </p>
    </div>
  );
}
