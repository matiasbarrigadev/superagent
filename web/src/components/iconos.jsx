// Iconos de línea (24×24, trazo 1.8). Decorativos: el texto al lado dice qué son.
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const I = (d) => function Icono({ className = 'size-5' }) {
  return <svg {...base} className={className}>{d}</svg>;
};

export const IconoInicio = I(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>);
export const IconoBandeja = I(<><path d="M21 12a8.5 8.5 0 0 1-12.6 7.5L3 21l1.6-5A8.5 8.5 0 1 1 21 12Z" /><path d="M8.5 10.5h7M8.5 13.5h4.5" /></>);
export const IconoChat = I(<><path d="M12 3.5 13.6 8l4.4 1.6-4.4 1.6L12 15.6l-1.6-4.4L6 9.6 10.4 8 12 3.5Z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></>);
export const IconoPersonas = I(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20" /></>);
export const IconoClientes = I(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" /></>);
export const IconoAgente = I(<><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M9 12.5v1M15 12.5v1M2 12v3M22 12v3" /></>);
export const IconoConexiones = I(<><path d="M9 7.5 7.5 6a3.5 3.5 0 0 0-5 5L4 12.5M15 16.5l1.5 1.5a3.5 3.5 0 0 0 5-5L20 11.5" /><path d="m8.5 15.5 7-7" /><path d="M10 6.5 11.5 5a3.5 3.5 0 0 1 5 0M14 17.5 12.5 19a3.5 3.5 0 0 1-5 0" /></>);
export const IconoCuenta = I(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IconoSalir = I(<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16l-4-4 4-4M6 12h10" /></>);
export const IconoMenu = I(<path d="M4 7h16M4 12h16M4 17h16" />);
export const IconoCerrar = I(<path d="M6 6l12 12M18 6 6 18" />);
export const IconoAtras = I(<path d="M15 5l-7 7 7 7" />);
export const IconoBuscar = I(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>);
export const IconoEnviar = I(<path d="M4.5 12 3 4l18 8-18 8 1.5-8Zm0 0h7" />);
export const IconoGrupo = I(<><circle cx="8" cy="9" r="3" /><circle cx="16.5" cy="9.5" r="2.5" /><path d="M2.5 19a5.5 5.5 0 0 1 11 0M14 14.2a4.5 4.5 0 0 1 7.5 3.3" /></>);
export const IconoAdjunto = I(<path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7.2" />);
export const IconoCheck = I(<path d="m4 12.5 4.5 4.5L20 6" />);
export const IconoReloj = I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconoBitacora = I(<><path d="M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z" /><path d="M8.5 8h6M8.5 11.5h6M8.5 15h3.5" /></>);
