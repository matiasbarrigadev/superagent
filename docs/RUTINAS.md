# Rutinas, aprobaciones y conectores de solo lectura

## Rutinas

Una rutina despierta al agente a una hora fija con una instrucción ("todos los días a las 9, mandale a Ana el
reporte de ventas"). Se crea conversando (`programar_rutina`); si la pide alguien que no es Propietario, pasa por
aprobación.

Las que ya existen se **editan**, no se copian. Por WhatsApp, el Propietario se lo pide al agente (herramienta
`rutinas`); en el panel, en **Agente → Rutinas → Editar**. Se puede cambiar:

- la instrucción, el horario (cron de 5 campos) y la zona horaria;
- a quién le llega (el destino);
- pausarla, reactivarla o borrarla;
- **con qué permisos corre**: los de quien la pidió, o los del Propietario.

### Correr con los permisos del Propietario

Sirve cuando la rutina necesita algo que el rol de quien la pidió no tiene, o cuando cada consulta pediría
aprobación. Corre como el Propietario (sus conectores, sin pedir un ok por cada consulta) y le sigue llegando a
quien la pidió. Lo que manda lo lee esa persona: la instrucción tiene que dejar claro qué puede ver (por ejemplo,
"solo cantidades, sin montos").

Por WhatsApp, el agente explica el cambio y lo aplica recién cuando el Propietario lo confirma en otro mensaje.
Borrar una rutina también se confirma.

## Aprobaciones

Un pedido de otra persona (A-n) se aprueba con un mensaje del Propietario escrito **después** de que llegó el
pedido. Un "sí" a otra pregunta no aprueba lo que llegó más tarde: el agente lo cuenta y espera la respuesta a eso.

## Varios Propietarios

Cada Propietario habla con el agente en su charla y no ve la del otro. Para no pisarse:

- todo cambio de rutinas (por WhatsApp, en el panel o del sistema) queda en la bitácora con quién lo hizo;
- el agente ve las rutinas y lo que hicieron los otros Propietarios en las últimas 24 h, y lo habla antes de
  cambiarlo de nuevo.

## Conectores de solo lectura

El gateway toma lo que declara cada herramienta de un conector: si no dice que solo lee (`readOnlyHint`), la trata
como escritura. Por eso una herramienta genérica (ejecutar SQL, llamar a una API) pide aprobación aunque se use
para leer, y un rol que solo lee no la ve.

Un conector es de **solo lectura** cuando:

- su URL le pide al servicio que no deje escribir (`read_only=true`, que aceptan muchos MCP, por ejemplo Supabase).
  El gateway lo detecta solo;
- o un Propietario lo marca así (en **Conexiones → Permisos → Solo lectura**, o conversando, con ficha y
  confirmación). Marcalo solo si el servicio de verdad no deja escribir con esa conexión: conectado en modo lectura
  o con un usuario o una clave que solo lee.

Con eso, ninguna de sus herramientas cuenta como escritura: no piden aprobación y las ve un rol que solo lee. Si
hace falta escribir y leer con el mismo servicio, se conectan dos conectores (uno normal y uno de solo lectura) y a
cada rol se le habilita el que corresponde.

No hay nada específico de un servicio: vale para cualquier conector.
