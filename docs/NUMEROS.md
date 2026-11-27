# Varios números de WhatsApp

Una instalación puede manejar varios números de WhatsApp. Cada número es una sesión de WAHA en el mismo servicio:
desde la versión 2026.6.1 de WAHA, las sesiones múltiples vienen incluidas en la imagen gratis y no hace falta
ninguna clave.

- **En el panel solo se vincula**: *Inicio → Sumar otro número*, con un nombre corto, y después QR o código.
- **Qué hace cada número se define conversando** con el agente. El Propietario cuenta lo que quiere y el agente
  guarda su pedido con sus palabras (`texto`) más un resumen mínimo. Antes de aplicarlo, muestra una ficha con lo
  que hace cumplir el sistema y lo que queda en manos del agente, y lo aplica cuando el Propietario confirma en
  otro mensaje.

## Qué queda en código y qué en el agente

- **Código** (autoridad, seguridad y privacidad: no depende de que el modelo se acuerde):
  - si un número puede enviar: en solo lectura o sin actividad no sale nada, y en solo avisos solo sale a los
    Propietarios;
  - si escribe primero;
  - qué chats entran y si se guardan (y cuánto);
  - qué conectores se usan ahí;
  - que un chat que solo ve un número que no responde nunca se conteste por otro número;
  - que un cambio de política lo haga solo un Propietario, con confirmación en otro mensaje;
  - la bitácora.
- **Agente** (con instrucciones y datos):
  - interpretar el pedido del Propietario;
  - detectar conflictos: grupos que ven dos números, alcances que se pisan, pedidos que chocan;
  - decidir si responder en un chat compartido sin número elegido (por defecto, consulta antes de responder);
  - proponer cómo resolverlo.

  Para esto tiene la herramienta `numeros`: qué números hay, su política y qué chats ve cada uno.

## La política

| Campo | Valores | Qué hace cumplir el gateway |
|---|---|---|
| `modo` | `responder`, `leer`, `avisos`, `nada` | `leer` y `nada` no envían nunca; `avisos` solo envía a los Propietarios; `responder` responde según el rol de quien escribe. |
| `chats` | `todos`, `grupos`, `directos`, `clientes`, `lista`, `ninguno` (+ `lista` y `excluir` con JIDs) | Lo que no entra no se guarda ni despierta al agente; solo se cuenta. `clientes` = chats ligados a un cliente. |
| `guardar` / `dias` | sí o no / cantidad de días | Sin guardar, lo que se lee no queda en la base. Con días, lo viejo se borra solo cada hora. Para responder siempre se guarda. |
| `escribir_primero` | `segun_rol`, `no` | Con `no`, un primer mensaje a alguien nuevo no sale por ese número. |
| `conectores` | lista de nombres o `null` | En las charlas de ese número solo se cargan esos conectores (además del recorte por rol). |
| `texto` | texto | Lo que pidió el Propietario, con sus palabras. El agente lo usa para todo lo que el resumen no cubre. |
| `notas` | texto | Instrucciones para el agente. Las cumple él; no son un bloqueo. |

Defaults:

- **número principal**: responde en todos los chats y guarda todo, como siempre;
- **número nuevo**: no hace nada (`modo: nada`, `chats: ninguno`, sin guardar) hasta que un Propietario lo
  configure.

## Cómo se rutea

- **Entrada:** cada mensaje trae su número y la política se aplica antes de guardar y antes de despertar al
  agente.
- **Respuesta:** sale por el mismo número por el que entró el mensaje. La salida vuelve a revisar la política
  justo antes de enviar.
- **Mismo grupo visto desde dos números:**
  - el mensaje se guarda una sola vez;
  - quién responde lo elige el Propietario (`responde_en`); mientras no lo elija, el agente lo ve en su contexto,
    no responde ahí y le pregunta;
  - lo que escribe un número propio no despierta al agente en el otro.
- **Número donde el agente no escribe** (por ejemplo, el personal de alguien): lo que sale de ese teléfono se
  guarda como escrito por esa persona, no por el agente.
- **Contexto:** la memoria y los chats son del cliente y la persona, no del número, así que es uno solo. El agente
  sabe por qué número entró cada charla.

## El WhatsApp personal del Propietario como número del agente

Se detecta solo: cuando el número vinculado es el mismo que el de un Propietario (cargado antes o después de
vincular).

- **Verificación:** queda verificado sin mandarse un código a sí mismo, porque escanear el QR con ese teléfono ya
  prueba que es suyo.
- **Modo personal cerrado:** si la política estaba abierta, pasa a `chats: lista` vacía y `escribir_primero: no`.
  No responde ni guarda nada de sus chats hasta que el Propietario habilite cuáles, conversando con el agente.
- **Su canal es "Mensaje a ti mismo":** lo que escribe ahí despierta al agente como un mensaje suyo, y el agente le
  responde en ese mismo chat. Para no confundir los ecos, lo que mandó el agente se reconoce por el id que devolvió
  WhatsApp o por el texto reciente.
- **Lo que escribe a mano en un chat habilitado** se guarda como escrito por él (no por el agente) y nunca despierta
  al agente ni cuenta como una orden.
- **Recomendación:** un número aparte (otra eSIM o WhatsApp Business). Si WhatsApp restringe este número, se pierde
  el WhatsApp personal. Además, WhatsApp no avisa de los mensajes nuevos en "Mensaje a ti mismo".

## Ejemplo

> **Agente:** Ya quedó vinculado el +54 9 11 … ("personal"). Por ahora no hago nada con él. ¿Qué querés que haga?
>
> **Propietario:** Es mi WhatsApp personal. Leé solo los chats de clientes, nunca escribas, y guardá un mes.
>
> **Agente:** Así quedaría "personal": solo leo y el sistema bloquea cualquier envío por ese número, aunque yo me
> equivoque. Entran solo los chats ligados a un cliente; del resto no guardo nada. Los mensajes se guardan 30 días.
> Lo que leo ahí me sirve de contexto para cada cliente y no lo comento con terceros: eso último lo cumplo yo, no es
> un bloqueo. ¿Lo confirmo?
>
> **Propietario:** Sí.

## Paquetes

Los números y sus políticas viajan en el paquete (`numeros`, y `responde_por` en cada chat), sin credenciales. En
una instalación nueva, cada número se vuelve a vincular en el panel. Ver [IMPORTAR.md](IMPORTAR.md).
