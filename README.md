# Atelier · Armario digital personal

Aplicación Next.js en español para organizar prendas reales, pedir propuestas por ocasión, guardar una agenda y solicitar simulaciones sobre una foto personal. El código está listo para configurar servicios; sin Supabase muestra una vista previa vacía y explícita, sin fingir que guarda fotos o genera IA.

## Estado de entrega

- La aplicación requiere configurar Supabase y un procesador para guardar fotos y utilizar IA. Sin estos servicios presenta una vista previa vacía.
- Incluye una configuración de servicio web Render Free para pruebas. El consumo de IA es independiente del alojamiento.
- Implementados: pantallas adaptadas al móvil, carga por lotes, normalización de fotos, revisión manual, filtros, perfil, propuestas por ocasión, favoritos, sustitución de prendas, agenda con múltiples eventos por día y simulaciones a petición.
- Implementados: sesión con cuenta única, RLS, almacenamiento privado, cola persistente, cuotas atómicas, deduplicación, caché versionada y cancelación ante cambios de fotos/prendas.
- La calidad visual debe validarse con fotos autorizadas en cada instalación. Usa `validation/README.md` antes de darla por aprobada.
- El repositorio contiene código, pruebas y ejemplos de configuración sin valores secretos. Las fotos y los datos de cada instalación se guardan en servicios privados, fuera del repositorio.

## Ejecutar

Requiere Node.js 24 y npm. Desde esta carpeta:

```text
npm ci
npm run dev
```

Abre http://127.0.0.1:3000. Sin configuración puedes explorar las pantallas, pero cargar y guardar exige el servicio privado.

Para activar el backend, copia `.env.example` a `.env.local` y rellena los valores desde tus cuentas. Nunca pegues claves en el chat, archivos versionados o variables `NEXT_PUBLIC_*` salvo URL y clave pública de Supabase. Las llamadas de IA se realizan únicamente en Render o en el trabajador local opcional.

## Supabase: proyecto nuevo y privado

1. Crea un proyecto dedicado. Ejecuta `supabase/migrations/001_armario.sql` una sola vez con permisos administrativos.
2. Desactiva los registros públicos en Authentication. Crea manualmente tu usuario con correo confirmado y contraseña.
3. Copia su UUID desde Authentication y ejecuta, reemplazando el marcador por el UUID real:

```sql
insert into public.app_owner (user_id) values ('UUID-DEL-USUARIO');
insert into public.profiles (user_id) values ('UUID-DEL-USUARIO');
```

4. Configura la URL, clave pública y clave `service_role` del mismo proyecto. La clave privilegiada solo está disponible en el servidor y trabajador.
5. Inicia sesión en la aplicación. No existe un formulario de registro ni una ruta de registro público.

La migración crea el bucket `wardrobe` como privado. Los enlaces de lectura duran 15 minutos y se renuevan al refrescar la aplicación. Cada objeto comienza con el UUID del propietario. Los enlaces ya emitidos pueden seguir siendo válidos hasta que expiren o se elimine el objeto; retirar un elemento lo oculta inmediatamente y la cola elimina sus archivos.

## Procesamiento a petición e IA

La web solicita `POST /api/process` mientras haya trabajos pendientes y la sesión esté abierta. Vercel verifica al propietario y transmite su sesión corta al origen HTTPS exacto del procesador en Render. Render vuelve a verificar la sesión con Supabase y devuelve una aceptación rápida, luego procesa un lote limitado de la cola. El catálogo, las fotos y la cola permanecen en Supabase, nunca en el disco temporal de Render. Cerrar la pestaña no borra datos: el lote activo puede terminar mientras el servicio siga encendido; las solicitudes pendientes se retoman al volver. Una generación interrumpida puede quedar incierta y no se repite automáticamente.

Render Free se duerme tras 15 minutos sin tráfico y tarda cerca de un minuto en despertar. Cada lote reclama trabajos solo mientras quede margen para ejecutarlos antes del periodo de inactividad. No se envían solicitudes artificiales para mantenerlo encendido. Los límites incluyen 750 horas gratuitas por espacio al mes. Si hay tarjeta, los excesos de transferencia o compilación pueden generar cargos: revisar el uso disponible y la configuración de facturación antes de crear el servicio. [Condiciones de Render Free](https://render.com/docs/free), [facturación](https://render.com/docs/faq).

Para procesar sin mantener abierta la web, existe además un trabajador local opcional que utiliza la misma cola y el mismo motor. No exige contratar Render:

```text
npm run worker
```

Se pueden ejecutar varios trabajadores: `FOR UPDATE SKIP LOCKED` reclama cada trabajo una vez. El análisis deja cada prenda **por confirmar**, nunca lista automáticamente. Si falla, puedes clasificarla manualmente.

Las propuestas usan datos de prendas confirmadas; no vuelven a enviar todas sus fotos al modelo. El servidor valida cada identificador y añade piezas básicas faltantes. Se solicitan tres propuestas distintas, pero se muestran menos si el inventario no permite variedad. No se generan imágenes de conjuntos incompletos.

La imagen usa tu foto como primera referencia, seguida de las fotos de las prendas. No se infieren medidas. Se utiliza `gpt-image-2`, calidad media y 1024 × 1536; se omite `input_fidelity`, como requiere ese modelo. El cache incluye propietario, conjunto, versión de foto, versiones de prendas, modelo y parámetros.

Los fallos posteriores al inicio de una llamada de imagen quedan como `uncertain`. El SDK no reintenta llamadas y la cola no repite renders expirados. Para resolver un resultado incierto, el administrador debe investigar el consumo/resultados del proveedor antes de liberar la deduplicación; no hay un botón que vuelva a facturar silenciosamente. Solicitudes fallidas y canceladas cuentan para el límite del mes de Lima.

La eliminación de archivos tiene tres intentos seguros. Si falla, Mi perfil muestra un botón para reintentar la eliminación. Un resultado generado mientras eliminas o cambias sus referencias no puede publicarse: la confirmación transaccional comprueba versiones y cancelación. Los registros de prendas retiradas permanecen como referencias de historial, pero sus fotos se eliminan.

## Despliegue

**Vercel:** importa esta carpeta como raíz del proyecto Next.js. Configura URL y clave pública de Supabase, clave de servicio, `RENDER_PROCESSOR_URL` con el origen `https://NOMBRE.onrender.com` confirmado por Render y `APP_URL` con el origen HTTPS exacto del sitio (sin ruta). La clave de OpenAI está solo en Render y nunca se expone al navegador. Cada solicitud de subida se comprime en el navegador a menos de 3 MB para ajustarse al límite de transporte de Vercel; la foto original seleccionada puede pesar hasta 10 MB.

**Render:** conecta el repositorio de código de GitHub. Puede ser público si contiene únicamente código y ejemplos sin valores secretos. `render.yaml` declara `type: web`, `plan: free`, raíz `.` y arranque `npm run render:free`; no usa un Background Worker de pago. Configura URL, clave pública y clave de servicio de Supabase, y `OPENAI_API_KEY`, desde los campos seguros de Render. `/healthz` devuelve solo disponibilidad; `/process` exige una sesión válida del único propietario. Revisa posibles cargos por exceso en la cuenta antes de crear el servicio. No cambiar ni eliminar métodos de pago o límites de otros servicios sin indicación del propietario.

**Antes del uso habitual:** comprobar que `APP_URL` coincide con el dominio final, que `/api/process` atiende la cola desde la web, que el bucket sigue privado y que otra cuenta no puede acceder a datos o fotos. Las comprobaciones locales de RLS no sustituyen la prueba en el proyecto alojado.

## Verificación

```text
npm run typecheck
npm test
npm run build
```

Las pruebas ejecutan PostgreSQL mediante PGlite con esquemas mínimos de Auth/Storage para comprobar políticas RLS, cuota, deduplicación, expiración, cancelación y agenda. No llaman a proveedores ni gastan créditos. También comprueban orientación EXIF, formatos, metadatos y validación de conjuntos.

## API del servidor

Todas las operaciones salvo `/api/status` y `/api/login` requieren sesión verificada y cuenta propietaria. Las mutaciones requieren `Origin` igual a `APP_URL`. Las respuestas privadas llevan `Cache-Control: no-store`.

| Operación | Endpoint |
| --- | --- |
| Estado, sesión | `GET /api/status`, `POST /api/login`, `POST /api/logout` |
| Estado completo | `GET /api/snapshot` |
| Procesar un trabajo propio | `POST /api/process` |
| Subir foto normalizada | `POST /api/upload` (multipart: `kind`, `file`) |
| Revisar o retirar prenda | `PATCH /api/garments/:id`, `DELETE /api/garments/:id` |
| Perfil y retirada de foto | `PATCH /api/profile`, `DELETE /api/profile-photo` |
| Propuestas | `POST /api/suggestions` |
| Personalizar / favorito | `POST /api/outfits`, `PATCH /api/outfits/:id` |
| Simulación / eliminación | `POST /api/render`, `DELETE /api/simulations/:id` |
| Agenda | `POST /api/events`, `PATCH /api/events/:id`, `DELETE /api/events/:id` |
| Progreso / repetir eliminación | `GET /api/jobs/:id`, `POST /api/jobs/:id/retry-cleanup` |

Upload, propuestas, render y creación de eventos reciben un UUID en `Idempotency-Key`. El mismo intento debe reutilizar el UUID tras una respuesta perdida. Un intento nuevo utiliza uno nuevo. La interfaz bloquea dobles pulsaciones y la base de datos deduplica renders también con distintas claves de intento.

## Referencias de integración

- [OpenAI: visión](https://developers.openai.com/api/docs/guides/images-vision), [salidas estructuradas](https://developers.openai.com/api/docs/guides/structured-outputs), [edición de imágenes](https://developers.openai.com/api/docs/guides/image-generation).
- [Supabase: sesiones SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [seguridad de Storage](https://supabase.com/docs/guides/storage/security/access-control).
