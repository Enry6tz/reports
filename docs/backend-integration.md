# Integrar Reports con su backend

Esta guía corresponde a **@e6tz/reports 0.1.1**. Su objetivo es conectar el paquete a una aplicación existente, sin cambiar su autenticación ni imponer una base de datos.

Reports es una biblioteca cliente, no un receptor alojado. La URL `/api/reports` de esta guía es un ejemplo: su aplicación debe implementarla y protegerla. La demo de la landing es una vista previa sintética; no ejecuta el SDK ni envía reportes.

## Inicio rápido

1. Instale `npm install @e6tz/reports` en su aplicación. El núcleo requiere Node.js 20.9 o posterior y no depende de React.
2. Implemente el receptor HTTP descrito abajo y pruebe su autorización y persistencia.
3. Configure el transporte desde la aplicación anfitriona. Mantenga la función desactivada hasta terminar esa conexión.
4. Envíe desde una acción explícita y muestre el resultado confirmado, incierto o rechazado.
5. Descarte la instancia con `dispose()` al terminar la integración o cambiar de identidad o proyecto.

```ts
import {
  createReportsClient,
  createHttpReportsTransport,
} from "@e6tz/reports";

export function connectReports(
  getRequestHeaders: () => HeadersInit | Promise<HeadersInit>,
) {
  return createReportsClient({
    transport: createHttpReportsTransport({
      endpoint: "/api/reports",
      headers: () => getRequestHeaders(),
    }),
  });
}

// La anfitriona proporciona cabeceras autorizadas y decide cuándo habilitar.
export async function submitFromUserAction(
  client: ReturnType<typeof connectReports>,
  message: string,
) {
  client.prepare({ message });
  const result = await client.send();
  return result; // accepted incluye receipt; uncertain no confirma recepción.
}
```

No copie credenciales fijas dentro del navegador. `getRequestHeaders` representa la integración con su mecanismo autorizado, no una función incluida en Reports. Conserve una instancia para el mismo intento si debe ofrecer `retry()`.

Para React o Next.js, `@e6tz/reports/react` exporta `ReportForm` y `useReportsSnapshot`. Instale React 18.3 o 19. Cree y descarte el cliente en un componente cliente; montar el formulario no envía por sí solo.

## Reparto de responsabilidades

| Reports | Aplicación anfitriona |
| --- | --- |
| Valida y congela un intento y su UUID. | Decide cuándo habilitar la función y qué contexto compartir. |
| Entrega mediante un transporte explícito. | Autentica, autoriza, limita y almacena las solicitudes. |
| Comprueba el ACK y conserva el intento para reintentar. | Deduplica atómicamente y confirma sólo después de persistir. |

El servidor deriva usuario, organización y proyecto de un contexto verificado. Un campo o cabecera controlado por el cliente no demuestra que tenga permiso. Reports no añade esos campos al cuerpo ni define cómo debe llamarse su modelo de usuarios.

## Solicitud HTTP

El transporte predeterminado envía `POST` a una URL HTTP(S) absoluta o una ruta relativa, con `Content-Type: application/json` y `Accept: application/json`. No permite credenciales en la URL, fragmentos ni URLs relativas al protocolo como `//host/path`.

```json
{
  "submissionId": "0ac851cc-8a49-4f51-9800-907d87c346d8",
  "message": "Al confirmar el pedido, la pantalla queda en blanco.",
  "context": {
    "pathname": "/checkout",
    "appVersion": "1.2.0",
    "viewport": { "width": 1440, "height": 900 },
    "capturedAt": "2026-10-26T12:00:00.000Z"
  }
}
```

`submissionId` es un UUID v4. `message` es texto no vacío. `context.capturedAt` es obligatorio en el cuerpo enviado; si omite el contexto al llamar a `prepare()`, el SDK lo genera. Las fechas deben ser ISO 8601 en UTC con sufijo Z.

Los campos opcionales de contexto son `pathname`, `browser`, `viewport` y `appVersion`. La imagen opcional usa `image: {mediaType, data}`: el tipo es PNG, JPEG o WebP y `data` contiene base64 puro, no una URL data ni multipart.

`collectReportContext()` y `readReportImage(file)`, de `@e6tz/reports/browser`, se ejecutan sólo cuando los llama. El primero elimina query y fragmento del pathname; el segundo valida tipo, firma y tamaño de la imagen. El servidor debe repetir sus propias validaciones.

## Confirmación HTTP

Responda con un estado 2xx y JSON `{data: Acknowledgement}`, con `Content-Type: application/json`. Un 200 vacío o una redirección a HTML no confirman el reporte.

```json
{
  "data": {
    "submissionId": "0ac851cc-8a49-4f51-9800-907d87c346d8",
    "reportId": "REP-42",
    "documentId": 42,
    "receivedAt": "2026-10-26T12:00:01.000Z",
    "status": "accepted"
  }
}
```

El ACK repite exactamente el UUID enviado. `reportId` cumple `REP-[1-9][0-9]{0,14}`; `documentId` es un entero positivo seguro de JavaScript. `status` sólo admite `accepted` o `duplicate`; `receivedAt` es una fecha UTC válida.

El nombre `documentId` forma parte del contrato publicado, pero no obliga a instalar otro sistema de documentos. Si su backend usa UUID u otro identificador, mantenga un identificador numérico estable o un mapeo propio para este campo. No genere uno nuevo en cada reintento.

Un transporte personalizado devuelve el ACK directamente, sin el contenedor `data`. Puede usar una llamada interna, otro servicio o almacenamiento de demostración, pero debe conservar las mismas garantías del receptor.

## Límites y validación

| Campo | Límite del contrato |
| --- | --- |
| Mensaje | 4096 bytes UTF-8; no vacío ni sólo espacios. |
| Imagen | 2 MiB decodificados; PNG, JPEG o WebP con firma compatible. |
| Cuerpo JSON completo | 3 MiB, incluida la expansión base64. |
| ACK HTTP | 4096 bytes. |
| Pathname normalizado | 1024 bytes; ruta local sin query ni fragmento. |
| Navegador / versión | 512 / 128 bytes UTF-8. |
| Viewport | Ancho y alto enteros entre 1 y 32768. |

Mida bytes, no caracteres. Rechace JSON inválido, controles no permitidos, tipos incorrectos e imágenes que no coincidan con su formato. Configure el límite del proxy y del parser antes de cargar un cuerpo demasiado grande en memoria.

Además de estos límites, aplique permisos, cuotas y límites de frecuencia. Revise imágenes y rutas antes de conservarlas: pueden contener información sensible. La biblioteca no establece una política de retención ni elimina datos del receptor.

## Autenticación y permisos

El adaptador HTTP usa **credentials: "omit"**, **cache: "no-store"** y **redirect: "error"**, incluso con una ruta del mismo origen. Una URL relativa no transmite automáticamente las cookies de la sesión.

Si su aplicación usa cabeceras autorizadas, proporciónelas mediante `headers`; el callback puede ser asíncrono y recibe una señal de aborto. La emisión, renovación y revocación de esas credenciales pertenecen a la anfitriona.

Si necesita cookies, inyecte explícitamente un `fetch` o transporte propio que habilite su mecanismo de sesión, limitado al receptor de confianza. Implemente protección CSRF en el servidor cuando corresponda. No reenvíe cookies o tokens a URLs arbitrarias.

CORS, la validación de origen, la visibilidad del formulario y un flag de interfaz no sustituyen la autorización. Compruebe identidad, proyecto y operación en cada solicitud; nunca envíe secretos administrativos al navegador.

## Persistencia e idempotencia

Use una restricción única atómica para `(ámbito autorizado, submissionId)`. El ámbito puede representar el proyecto de su aplicación, pero se deriva del contexto autorizado del servidor.

Compare un contenido normalizado estable para el mismo identificador: mensaje, imagen y contexto enviados. Puede guardar el cuerpo canónico o su hash. No confíe en un hash proporcionado por el cliente ni en el orden original de las claves JSON.

```text
Autenticar y autorizar la solicitud
Validar JSON, campos, tamaños y cuotas
Derivar el ámbito autorizado y el contenido canónico
Iniciar transacción
  Reservar (ámbito, submissionId) bajo una restricción única
  Si ya existe:
    Si el contenido es diferente: terminar sin cambios y responder 409
    Si es igual: recuperar los identificadores y fecha originales
  Si es nuevo:
    Guardar reporte, imagen o referencia y confirmación estable
Confirmar la transacción duradera
Responder accepted para el nuevo o duplicate para el existente
```

La reserva, el contenido y la confirmación deben ser consistentes en una transacción. Dos solicitudes simultáneas no deben crear dos reportes. Resuelva el conflicto de unicidad recuperando el registro confirmado; no use una consulta previa como única protección.

Si guarda imágenes en un almacenamiento separado, diseñe estados y limpieza de cargas incompletas. No devuelva un ACK mientras el reporte o su imagen requerida puedan perderse por un fallo de persistencia. Una pérdida de respuesta después del commit se resuelve reintentando el mismo UUID.

## Modelo de datos de referencia

Este esquema conceptual es **una implementación posible**, no una base de datos ni tablas exigidas por el paquete. Adáptelo a sus entidades y motor actuales.

| Entidad de ejemplo | Campos y restricciones |
| --- | --- |
| reports | id interno, ámbito autorizado, submission_id, contenido canónico/hash, mensaje, contexto, received_at. Único: ámbito + submission_id. |
| report_receipts | report_id público REP-n y document_id numérico estable, vinculados al reporte. Puede ser parte de la misma fila. |
| report_images | Tipo, tamaño y referencia al objeto o contenido validado. Es opcional y pertenece al reporte. |

El servidor asigna los identificadores y la fecha de recepción. Las claves de organización, proyecto o usuario deben usar sus relaciones existentes. Una consulta del inbox debe filtrar por el mismo ámbito autorizado; las rutas de administración del inbox no están definidas por este SDK.

## Errores y reintentos

| Respuesta del receptor | Resultado del SDK / acción |
| --- | --- |
| 401 o 403 | `rejected`. Corrija la sesión o los permisos; no reenvíe sin autorización. |
| 409 | `rejected` por contenido diferente para el mismo UUID. No sobrescriba el reporte. |
| 413 u otro 4xx salvo 408, 425 y 429 | `rejected`. Corrija el problema y descarte explícitamente antes de preparar otro intento. |
| 429 | `retry-later`. Respete `Retry-After` y ofrezca otro reintento explícito. |
| 408, 425, 5xx, fallo de red o timeout | `uncertain`: la recepción puede haber ocurrido. Conserve UUID y contenido para reintentar. |
| 2xx sin ACK válido, JSON incorrecto o ACK excesivo | `uncertain`. No muestre entrega confirmada. |

El timeout predeterminado del cliente es de 10 segundos. `Retry-After` admite segundos o fecha HTTP; el adaptador limita la espera a 24 horas y usa 60 segundos si falta un valor válido. No existe polling ni reintento automático.

`retry()` conserva el intento preparado. No llame a `prepare()` para representar un reintento del mismo envío. Las llamadas concurrentes a `send()` comparten la solicitud en curso.

`cancel()` descarta el intento local; puede devolver `may-have-been-sent`. `dispose()` cancela y desconecta definitivamente la instancia. Ninguna de las dos operaciones retira un reporte ya persistido. Al cerrar sesión o cambiar de proyecto, elimine la interfaz y descarte la instancia anterior.

## Adaptar Next.js o NestJS

El contrato no depende del framework. En Next.js, una ruta POST de App Router puede validar la sesión y delegar en un receptor; en NestJS, un controlador puede delegar en un servicio con la misma responsabilidad.

Conserve la lógica de recepción y almacenamiento fuera de la capa HTTP. Ambos adaptadores deberían pasar las mismas pruebas de contrato: autorización, límites, deduplicación y ACK posterior al commit. No conecte el navegador directamente a la base de datos ni confíe en permisos decididos por el cliente.

Estos son puntos de conexión, no módulos Next o Nest incluidos en Reports. Instalar el paquete no crea rutas, tablas, migraciones, login ni un inbox administrativo.

## Demostración local y backend real

Un transporte de demostración puede guardar reportes en `localStorage` y devolver un ACK después de una escritura correcta. Debe mostrar que la confirmación es sólo local; si falla por cuota o bloqueo, no debe fingir que guardó.

Ese almacenamiento pertenece al origen y al perfil del navegador. Puede borrarse, no comparte datos entre usuarios y no ofrece transacciones de base de datos entre pestañas ni permisos de servidor. No guarde secretos ni use sus IDs como prueba de identidad.

Para producción, sustituya el transporte por el receptor HTTP protegido y la persistencia local por su repositorio de servidor. Conserve los contratos del SDK y pruebe la autorización de forma independiente. La demo de esta landing sólo genera una vista previa REP-DEMO: no es ese receptor local ni remoto.

## Probar el receptor

Use una sesión o credencial válida de su aplicación. El siguiente comando supone que ya implementó `http://localhost:3000/api/reports` y que su backend acepta una cabecera Bearer. `HOST_SESSION_TOKEN` es un valor de su entorno de pruebas, no un token emitido por Reports.

```sh
curl -i http://localhost:3000/api/reports \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HOST_SESSION_TOKEN" \
  --data '{"submissionId":"0ac851cc-8a49-4f51-9800-907d87c346d8","message":"Prueba del receptor","context":{"capturedAt":"2026-10-26T12:00:00.000Z"}}'
```

Compruebe estos casos a través de la ruta real, no sólo de sus funciones internas:

- Sin sesión: 401. Con identidad sin permiso: 403. Ningún caso debe guardar datos.
- Primer UUID válido: un único reporte persistido y ACK `accepted` con el mismo UUID.
- Mismo UUID y contenido, incluso en paralelo: los mismos IDs y ACK `duplicate`, sin otra fila.
- Mismo UUID y contenido distinto: 409 y datos originales intactos.
- Límites de texto, imagen y cuerpo: rechazo antes de persistir.
- Fallo de almacenamiento: sin confirmación falsa; respuesta perdida tras commit: reintento sin duplicado.
- 429: espera indicada y reintento explícito; fallo remoto: no marcar como entregado.
- Cambio de identidad o proyecto: el inbox no expone reportes de otro ámbito.
- Cancelación o desmontaje: no hay actualización tardía del estado del cliente; el servidor puede haber terminado.

## Referencia y siguientes pasos

El [README del paquete](https://github.com/Enry6tz/reports#readme) documenta el formulario React, los helpers de navegador y la interfaz completa. El [código fuente](https://github.com/Enry6tz/reports) es la referencia de esta versión y el [paquete npm](https://www.npmjs.com/package/@e6tz/reports) contiene la biblioteca publicada.

Consulte también los contratos independientes de [Flags](https://flags.6tz.tech/docs/) y [Toolkit](https://github.com/Enry6tz/Toolkit/blob/main/docs/host-integration.md). Compartir la anfitriona no hace idénticos sus transportes ni sus necesidades de backend.
