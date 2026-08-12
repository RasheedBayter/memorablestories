# Informe de descarga y corte — planos de archivo, episodio 3 (Motorola)

41 de 42 cortes conseguidos. 25 de 26 películas descargadas. Cada corte se verificó extrayendo
un fotograma del segundo 1 (o del inicio, cuando el clip dura solo 3 s) con `ffmpeg` y mirándolo
directamente. Detalle fila por fila:

| # | identificador | minutaje usado | duración | ¿fotograma coincide? | notas |
|---|---|---|---|---|---|
| 01 | PartiallyRestoredVideoEventsFromTheApollo11Mission | 01:15 | 6 s | Sí | — |
| 02 | Apollo11MoonLanding | 02:30 | 6 s | Sí | — |
| 03 | electronics_at_work | 00:39 | 6 s | Sí | — |
| 04 | MasterHa1936_4 | 02:36 | 6 s | Sí | — |
| 05 | MasterHa1936_4 | 09:32 | 6 s | Sí | — |
| 06 | ChicagoW1933 | 02:16 | 6 s | Sí | vista aérea en movimiento, genérica pero consistente |
| 07 | MasterHa1936_2 | 03:09 | 6 s | Sí | — |
| 08 | Radioand1940 | 00:06 | — | **No conseguido** | película no descargada (ver abajo) |
| 09 | CS-1252 | 07:05 | 6 s | Sí | — |
| 10 | CS-1252 | 06:20 | 6 s | Sí | — |
| 11 | MasterHa1936_3 | 03:00 | 6 s | Sí | mano sobre componentes internos de bloque motor; no se aprecian con nitidez los muelles de válvula en sí, pero la escena (mano + interior de motor) es consistente |
| 12 | BehindYo1947 | 04:56 | 6 s | Sí | — |
| 13 | Magicint1955 | 01:03 | 6 s | Sí | — |
| 14 | Magicint1955 | 01:03 | 6 s | Sí | idéntico al 13, como indica la tabla |
| 15 | ThisIsYo1951 | 08:40 | 6 s | Sí | — |
| 16 | ThisIsYo1951 | 08:34 | 6 s | Sí | — |
| 17 | ThisIsYo1951 | 09:20 | 6 s | Sí | — |
| 18 | ThisIsYo1951 | 09:43 | 6 s | Sí | — |
| 19 | ThisIsYo1951 | 09:22 | 6 s | Sí | — |
| 20 | ADTWhenE1958 | 05:46 | 6 s | Sí | en color, como pide la descripción |
| 21 | VJSC_1425C | 30:00 | 6 s | Sí | — |
| 22 | Apollo1116mmOnboardFilm | 01:10:00 | 6 s | Sí | — |
| 23 | Apollo1116mmOnboardFilm | 40:00 | 6 s | Sí | — |
| 24 | VJSC_1425L | 06:00 | 6 s | Sí | — |
| 25 | HSF-mov-apollo11_onbclip17 | 00:20 | 6 s | Sí | — |
| 26 | Televisi1970 | 03:30 | 6 s | **Parcial — ver aviso** | el astronauta aparece exactamente en t=0 del corte, pero el original funde a otra imagen (un técnico con gafas de sol) en menos de 1 s. Es un montaje caleidoscópico muy rápido en la fuente; no existe en el original un plano de 6 s continuos del astronauta. Se dejó el corte en 03:30 porque ahí es donde aparece el plano correcto, pero el clip resultante NO sostiene la imagen 6 s |
| 27 | Televisi1970 | 03:50 | 6 s | Sí | — |
| 28 | dick_tracy_detctive | 00:01 | 6 s | Sí | imagen oscura pero reconocible |
| 29 | dick_tracy_detctive | 04:00 | 6 s | Sí | — |
| 30 | dick_tracy_detctive | 19:00 | 6 s | Sí | — |
| 31 | dick_tracy_detctive | 02:30 | 6 s | Sí | — |
| 32 | WhenYouG1973 | **04:12 (ajustado, tabla decía 04:15)** | 6 s | Sí, tras ajuste | a 04:15 exacto el fotograma mostraba a un operario de bulldozer, no el cruce de calle. El plano de cruce de calle con cuadrilla solo existe de ~04:12.0 a ~04:15.4 en el original (corte duro a otra escena de obra); se adelantó el inicio a 04:12 para capturar el plano completo al principio del clip. A partir de ahí el clip pasa a la escena del bulldozer para completar los 6 s |
| 33 | WhenYouG1973 | 03:45 | 6 s | Sí | — |
| 34 | American1960 | 07:40 | 6 s | Sí | — |
| 35 | Precisel1937_2 | 05:40 | 6 s | Sí | — |
| 36 | Precisel1937_2 | 09:00 | 6 s | Sí | — |
| 37 | BigBounc1960 | 00:34 | 6 s | Sí | — |
| 38 | BigBounc1960 | 08:20 | 6 s | Sí | — |
| 39 | BigBounc1960 | 04:57 | 6 s | Sí | — |
| 40 | RSS_253126main_vafb_062008_ostm_launch | 00:10 | 6 s | Sí, tras ajuste de recorte | el crop indicado en las instrucciones (quitar 12 % superior) no bastaba: el logotipo NASA seguía visible. Se probó 15/18/20 % y se confirmó visualmente que **20 %** (`crop=iw:ih*0.80:0:ih*0.20`) lo elimina por completo. Aplicado ese crop |
| 41 | Telegram1956 | 14:23 | 3 s | Sí | torre sin rótulo visible, tal y como pedían las instrucciones |
| 42 | Townandt1950 | 06:51 | 6 s | Sí | — |

## Plano no conseguido: #08, `Radioand1940`

El endpoint de metadatos de `Radioand1940` está roto igual que el de `BigBounc1960`
(`https://archive.org/metadata/Radioand1940` devuelve `{"error":"item metadata may be invalid"}`),
pero a diferencia de `BigBounc1960` no hay instrucción con el nombre de fichero bueno conocido.
Se intentó:
- Metadatos vía API (3 intentos): siempre error de metadatos inválidos.
- Página de detalle `https://archive.org/details/Radioand1940`: primero devolvió 404, luego timeout.
- Descarga directa por convención de nombres (`Radioand1940.mp4`, `Radioand1940_edit.mp4`,
  `Radioand1940_512kb.mp4`, `Radioand1940_files.xml`, `Radioand1940_archive.torrent`): todas
  las peticiones a `/download/Radioand1940/...` devuelven 503 (error de servidor de archive.org).
- Búsqueda en el índice (`advancedsearch.php`) confirma que el ítem existe (título "Radio and
  Television") pero el servidor que sirve sus ficheros no responde.
- Wayback Machine (CDX API) sin snapshots del listado de descargas del ítem.

No se dispone de un nombre de fichero verificado ni de una URL que responda, así que **no se
inventó nada**: el plano 8 queda pendiente. Si el servidor de archive.org se recupera, repetir
la descarga con:
```
curl -s -A "MemorableStories/0.1" https://archive.org/metadata/Radioand1940
```
y cortar en `00:06` durante 6 s.

## Espacio en disco

- `archivo/fuentes/`: 25 películas, ~5.2 GB
- `archivo/cortes/`: 41 clips, ~43 MB
- Total `archivo/`: ~5.2 GB
