# Textos del template de Railway

**Nombre**: Superagente en WhatsApp

**Ícono**: https://gist.githubusercontent.com/matiasbarrigadev/af0de5e32d86a8b05234de5de1760a15/raw/icono.png
(fuente: `icono.svg` en esta carpeta)

**Descripción corta**:

Un agente que vive en WhatsApp y trabaja contigo: desde desarrollar sistemas hasta operar tu negocio día a día.

**Descripción larga (overview, con la estructura que exige Railway)**:

```markdown
# Deploy and Host Superagente en WhatsApp on Railway

Superagente en WhatsApp es un agente de IA que vive en tu WhatsApp y trabaja codo a codo contigo. Funciona con
Claude Code, así que no solo conversa: diseña y construye sistemas, se conecta a tus servicios, acompaña tus
procesos y opera tu negocio día a día. Solo conecta Claude y WhatsApp: un par de clics y lo tienes funcionando.

## About Hosting Superagente en WhatsApp

El template crea dos servicios: `waha`, que mantiene la sesión de WhatsApp (privado, sin acceso desde internet), y
`superagent`, que incluye el agente, Claude Code y un panel web. Cada uno tiene su volumen, así que la sesión de
WhatsApp, la base de datos y las credenciales cifradas se conservan entre deploys. Los secretos se generan solos.

Después del deploy:

1. Abre el dominio del servicio `superagent` y crea tu cuenta.
2. **Conecta Claude** con tu suscripción (Pro o Max).
3. **Conecta WhatsApp** escaneando el QR con el teléfono del número del agente.
4. Verifica tu número personal y el agente te escribe para configurarse contigo.

Todo lo demás se configura conversando con él por WhatsApp. El panel queda para revisar chats, equipo, decisiones
y consumo.

## Common Use Cases

- **Diseñar y construir sistemas a medida.** Le cuentas lo que necesitas y lo desarrolla: una web, una app, una
  automatización o una integración, con GitHub, Vercel, Supabase y cualquier servicio que le conectes.
- **Acompañar cualquier proceso.** Ventas, soporte, proyectos, cobranzas o reclutamiento: lleva el seguimiento,
  te recuerda lo pendiente y te avisa cuando algo necesita tu atención.
- **Operar tu negocio desde lo que construyó.** Carga datos, responde consultas, genera informes y ejecuta rutinas
  programadas sobre el sistema que creó contigo.
- **Atender WhatsApp por ti.** Responde a clientes y contactos con el tono y los límites que definas, y te consulta
  antes de cualquier cosa que lo requiera.
- **Trabajar con tu equipo.** Suma miembros con distintos roles: quién puede pedirle qué, en qué grupos participa y
  qué necesita tu aprobación. En los grupos escucha y responde solo cuando le hablan.
- **Entender todo tipo de mensajes y trabajar en segundo plano.** Audios, PDFs, imágenes y documentos; tareas
  largas que te avisa cuando terminan.

## Dependencies for Superagente en WhatsApp Hosting

- Una suscripción de Claude (Pro o Max).
- Un número de WhatsApp para el agente (recomendado: uno dedicado).

### Deployment Dependencies

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview): el agente usa el binario oficial con tu
  suscripción.
- [WAHA](https://waha.devlike.pro): API de WhatsApp autoalojada, con el motor GOWS.
- [Planes de Claude](https://claude.com/pricing): Pro o Max.

### Implementation Details

- Imagen de unos 3 GB (Claude Code, Chromium, whisper.cpp para audios, OCR); el primer build tarda unos minutos.
- Se recomiendan al menos 2 GB de RAM para el servicio `superagent`.
- Es autoalojado: tus mensajes, tus datos y tus credenciales quedan en tu proyecto de Railway, cifrados. Cada
  conversación corre aislada con su propio usuario del sistema, y lo que hace cada persona depende del rol que le
  asignes.

## Why Deploy Superagente en WhatsApp on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you
don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Superagente en WhatsApp on Railway, you are one step closer to supporting a complete full-stack
application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
```
