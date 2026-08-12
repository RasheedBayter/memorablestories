# Analizar vídeos de referencia

Convierte un vídeo ajeno al formato en el que escribimos nuestros guiones, para
poder estudiar **cómo se casa cada imagen con lo que se está diciendo**.

```bash
python3 scripts/analizar-referencia.py https://www.youtube.com/watch?v=XXXX
python3 scripts/analizar-referencia.py referencia.mp4 --slug mi-referencia
```

Todo aterriza en `referencias/<slug>/`.

---

## Qué produce, y en qué orden mirarlo

**1. `guion-reconstruido.md` — el entregable.** El vídeo escrito como escribimos
nosotros: marcas `>>` con el plano y, debajo, las frases que suenan mientras ese
plano está en pantalla.

```
>> frames/plano-010.jpg — [00:34 – 00:38] · 3,3 s · fijo · 1 frase
   corte a mitad de frase, justo antes de «to»

[00:34.1] Now to our commander, Marine Corps Colonel Artemis III Commander, | Randy Bresner.
```

Se lee así:

- **`|` marca el punto exacto del texto donde cambió la imagen.** Es el dato que
  más dice de un montaje y no aparece en ninguna métrica agregada.
- `[mm:ss.d]` abre cada frase; es el ancla que pide `docs/GRAMATICA-NARRATIVA.md`.
- La línea bajo la marca dice **cómo entró el corte**: `en pausa` (en el silencio
  entre dos frases), `en el punto`, `en la coma`, o `a mitad de frase`.
- Cada plano lleva si está **fijo**, **con movimiento** (se mueve la cámara) o con
  **movimiento interno** (la cámara está quieta y se mueve lo de dentro).
- Si la frase que parte el corte se imprime bajo otro plano, lo dice: *«corte a
  mitad de la frase anterior»*.
- Un plano sin frase propia no siempre es un plano mudo. Si la voz viene de
  antes, pone *(sigue sonando la frase del plano N)*; solo cuando de verdad no
  hay voz encima pone *(sin narración: solo imagen)*.
- Al final, la tabla de **respiros**: cada tramo de más de 0,8 s sin voz y qué
  planos lo ocupan.

La notación es la de `docs/GRAMATICA-NARRATIVA.md`, que es la guía que se lee
después sobre este documento.

**2. `contactos-NN.jpg`** — los planos en orden, numerados, con minutaje y
duración. Se miran con el guion al lado: el número del contacto es el mismo que
el de la marca `>>`.

**3. Lo secundario.** `ritmo.md` (duración media y mediana, distribución, cortes
por minuto y cómo varía por bloques), `audio.md` (voz/música/silencio),
`planos.csv`, `transcripcion.txt` y `.json`, `INFORME.md`.

### Opciones

| opción | para qué |
|---|---|
| `--slug X` | fuerza el nombre de la carpeta |
| `--modelo small.en` | modelo de whisper; `base.en` por defecto |
| `--idioma es` | fuerza el idioma en vez de detectarlo |
| `--umbral 0.25` | sensibilidad del detector de escenas de ffmpeg |
| `--subs-youtube` | usa los subtítulos de YouTube si están puntuados |
| `--sin-ocr` | salta la lectura de rótulos |

Volver a lanzarlo sobre la misma URL **no vuelve a descargar** el vídeo.

---

## Qué se instaló

| herramienta | versión | cómo | para qué |
|---|---|---|---|
| `yt-dlp` | 2026.07.04 | `brew install yt-dlp` | descarga y metadatos |
| `curl_cffi` | 0.15.x | en el entorno de yt-dlp | ver más abajo |
| `PySceneDetect` | 0.6.7.1 | `pip3 install --user scenedetect` | detección de planos |
| `opencv-python-headless` | 5.0.0 | `pip3 install --user` | lo exige scenedetect |
| `tesseract` | 5.5.3 (163 idiomas) | `brew install tesseract tesseract-lang` | OCR de rótulos |
| `pytesseract` | — | `pip3 install --user` | puente de Python |

Ya estaban: `ffmpeg` 8.1.2, `faster-whisper` 1.2.1 con el modelo `base.en` en
caché, `Pillow`, `numpy`.

Todo lo de `pip3 install --user` vive en `~/Library/Python/3.9/`, que es donde ya
estaba `faster-whisper`. No hace falta activar ningún entorno.

### Tres tropiezos que conviene saber

**`yt-dlp` de pip se queda viejo.** Python 3.9 está fuera de soporte y las
versiones nuevas de yt-dlp ya no lo admiten: `pip install --upgrade yt-dlp` se
queda clavado en octubre de 2025 y YouTube le responde *«The page needs to be
reloaded»*. La versión de Homebrew trae su propio Python y sí se actualiza. Un
yt-dlp viejo deja de funcionar con YouTube en semanas, así que `brew upgrade
yt-dlp` de vez en cuando.

**Los subtítulos de YouTube exigen suplantación de navegador.** Sin `curl_cffi`,
bajar subtítulos devuelve `HTTP Error 429: Too Many Requests` aunque sea la
primera petición del día. Se arregla con:

```bash
/opt/homebrew/Cellar/yt-dlp/*/libexec/bin/python -m pip install "curl_cffi>=0.10,<0.16"
```

El rango importa: yt-dlp solo admite 0.5.10 y de 0.10 a 0.15. Con 0.16 instalado
dice *«impersonate targets unavailable»* y no explica por qué.

**Este `ffmpeg` no trae `drawtext`** (viene compilado sin libfreetype), así que
las etiquetas de las hojas de contacto se dibujan con Pillow.

---

## Por qué la transcripción la hace whisper y no YouTube

Los subtítulos automáticos de YouTube **no llevan puntuación**. Sin puntos no hay
frases, y sin frases no hay nada que cruzar con los cortes: todo el análisis se
apoya en saber dónde termina una oración. Además salen sucios —en el primer vídeo
que probamos, el primer evento era `เฮ` y el resto `[music]`—.

`faster-whisper` puntúa y da marcas **por palabra**, que es lo que permite situar
el corte dentro del texto. Por eso es la vía por defecto.

`--subs-youtube` sirve cuando el canal ha **subido** subtítulos propios en vez de
dejar los automáticos: esos sí van puntuados, porque son el guion real. El script
los descarta solo si detecta que no tienen puntuación.

**El modelo importa para lo que estamos midiendo.** `base.en` puntúa poco: en
*Survival Under Atomic Attack* no generó ni una coma, así que ningún corte pudo
clasificarse como `en la coma` y todos cayeron en `a mitad de frase`. Si lo que
se quiere afinar es precisamente dónde caen los cortes, conviene `--modelo
small.en` o `medium.en`.

---

## Por qué se usan los dos detectores de planos a la vez

Se midieron contra un vídeo construido a propósito: 36 clips recortados de tres
documentales, **cada uno verificado como plano único**, concatenados con las
fronteras conocidas al fotograma. En cortes duros limpios los dos aciertan igual:

| método | detectados | aciertos | FP | FN | precisión | cobertura | seg |
|---|---:|---:|---:|---:|---:|---:|---:|
| ffmpeg `gt(scene,0.2)` | 35 | 35 | 0 | 0 | 1,000 | 1,000 | 0,5 |
| ffmpeg `gt(scene,0.3)` | 35 | 35 | 0 | 0 | 1,000 | 1,000 | 0,5 |
| ffmpeg `gt(scene,0.4)` | 32 | 32 | 0 | 3 | 1,000 | 0,914 | 0,5 |
| PySceneDetect Content 27 | 35 | 35 | 0 | 0 | 1,000 | 1,000 | 1,1 |
| PySceneDetect Content 30 | 33 | 33 | 0 | 2 | 1,000 | 0,943 | 1,1 |
| PySceneDetect Adaptive | 35 | 35 | 0 | 0 | 1,000 | 1,000 | 1,2 |

Empate: el sintético no discrimina. **La diferencia sale en metraje real.** Sobre
*Survival Under Atomic Attack* (8:46) ffmpeg encontró 86 cortes y PySceneDetect
72, con 65 en común. Extrayendo el fotograma de antes y el de después de cada
discrepancia y mirándolos uno a uno:

- **De los 14 que solo vio ffmpeg, 13 eran cortes reales** que PySceneDetect se
  dejó (nube a panorámica, escombros a fachada, rótulo a rótulo). El único falso
  era el instante 0, que ffmpeg siempre emite y el script descarta.
- **Los 8 que solo vio PySceneDetect eran todos fundidos** a o desde negro.
  ffmpeg no los ve nunca: un fundido reparte el cambio entre muchos fotogramas y
  jamás supera el umbral en uno solo.

O sea que **fallan en direcciones opuestas**, y cuál domina depende del material:
en el documental de 1951 ganaba ffmpeg (86 frente a 72), pero en un vídeo moderno
de NASA lleno de encadenados se dio la vuelta (11 frente a 25). Por eso el script
usa **la unión**, fusiona las detecciones separadas por menos de 0,35 s y anota
en `planos.csv` quién vio cada corte.

### El tercer detector: encadenados

Hay un tipo de corte que **no ve ninguno de los dos**. Al verificar la
clasificación de movimiento saltó a la vista: los tres rótulos de cabecera de
*Survival Under Atomic Attack* estaban metidos dentro de un mismo «plano» de
16,6 s, y un plano de 12 s en el minuto 6 contenía tres imágenes distintas
(un reloj de pulsera, una torre del reloj y una calle). ffmpeg, ContentDetector
y AdaptiveDetector no encontraban **nada** ahí dentro: un encadenado reparte el
cambio entre uno o dos segundos y ningún fotograma se separa lo bastante del
anterior.

Se detectan por la definición del propio efecto: **en un encadenado lineal el
fotograma del centro es la media de los dos extremos**. En una panorámica no,
porque promediar dos encuadres desplazados da un fantasma. La puntuación es
`|extremos| / |centro − media|`.

Verificando 14 candidatos a mano, los encadenados reales puntuaban 3,9 · 4,6 ·
4,9 · 11,7 y los falsos se quedaban por debajo de 3,7 —eran planos con
movimiento amplio y suave (una seta nuclear creciendo, alguien moviéndose), que
también cumplen «el centro es la media»—. El umbral está en **3,85**, dentro de
ese hueco, y solo se añaden los cortes que los otros dos no vieron.

Con esto la película pasa de 92 a 105 planos y los tres rótulos quedan
separados. **Está calibrado sobre 14 casos de una sola película**: el hueco
entre 3,7 y 3,9 es estrecho y en otro material puede colarse algún falso. Se ha
preferido pecar de conservador, porque un encadenado suave que se escapa deja
dos planos pegados —molesto pero visible en los contactos— mientras que un falso
positivo inventa un corte que nunca existió.

### Movimiento de cada plano

`fijo` / `con movimiento` / `movimiento interno`, en una sola pasada a 4 fps y
160×90 en gris que se reaprovecha para los encadenados.

Un umbral absoluto **no vale**: el grano de la película de 1951 da de suelo más
diferencia entre fotogramas (mediana 10,5) que el plano medio del vídeo moderno
de NASA (4,7), así que con un número fijo no salía «fijo» prácticamente nunca.
El suelo de ruido se estima con los planos más quietos del propio vídeo y todo
se mide contra él.

Verificado sacando tres fotogramas repartidos por el plano y mirándolos: los
`fijo` salen casi idénticos, los `con movimiento` cambian de encuadre. Es una
heurística, no seguimiento óptico: distingue bien quieto de movido, y de forma
más aproximada cámara de sujeto.

### Sobre el OCR

Merece la pena, pero solo con la imagen preparada y filtrando fuerte. En crudo,
un fotograma de 1951 devolvía `oro 1s Sess elastin oa ee cle`. Pasándolo a gris,
al doble de tamaño y con el contraste estirado, el mismo rótulo se lee. Aun así
se descarta todo lo que no llegue a dos palabras con confianza media ≥ 70,
porque **un rótulo inventado es peor que ningún rótulo**: en la primera prueba
salían 23 rótulos de 93 planos y casi todos eran ruido; con el filtro salen 2, y
son los dos reales. En el vídeo de NASA salieron 0, que es lo correcto: no tiene
rotulación, solo el decorado del escenario.

Sobre metraje granulado el OCR sigue siendo aproximado —`UNITED STAT, FILMG
FEDERAL CIVIL DEFENSE ADMINISTRATION`—: sirve para saber **que hay un rótulo y
de qué habla**, no para citarlo literalmente.

---

## Ejemplos ya generados

- `referencias/survival-1951/` — *Survival Under Atomic Attack* (1951), dominio
  público, 8:46. 106 planos, 71 frases.
- `referencias/artemis-iii-announcement-recap.../` — NASA, 2:07. 28 planos.

Un documental de ~9 min tarda algo más de un minuto de principio a fin.

---

## Lo legal

*Esto es un resumen de lo que dicen las fuentes, no asesoramiento jurídico.*

### Qué dicen los términos de YouTube

Los Términos de Servicio prohíben, en «Permisos y restricciones»:

- **acceder, reproducir, descargar o distribuir** cualquier parte del Servicio o
  del Contenido, salvo que lo autorice expresamente el Servicio o haya permiso
  escrito de YouTube y de los titulares de derechos;
- **acceder al Servicio por medios automatizados** (robots, botnets, scrapers),
  salvo buscadores públicos que respeten el `robots.txt`, o con consentimiento
  escrito previo.

Descargar con `yt-dlp` entra de lleno en ambas. La única descarga que los
términos contemplan es la función de sin conexión del propio YouTube, que no da
un fichero utilizable fuera de su app.

### Qué permite la API oficial

| operación | ¿sirve para vídeos ajenos? | coste |
|---|---|---|
| `videos.list` — título, descripción, duración, canal, fechas, contadores | **sí**, con clave de API | 1 unidad |
| `captions.list` — qué pistas de subtítulos existen | sí | 50 unidades |
| `captions.download` — **el texto** de los subtítulos | **no**: exige OAuth con permiso de edición sobre el vídeo, o sea ser el dueño | 200 unidades |
| descargar el vídeo | **no existe** en la API | — |

Cuota diaria: 10.000 unidades. Resumiendo: **la API oficial da metadatos de
cualquier vídeo, pero ni la transcripción ajena ni el vídeo.** Justo lo que
necesitamos es lo que no ofrece.

### `youtube-transcript-api`

No usa la API oficial. Llama al endpoint interno **InnerTube**, el mismo que usa
el reproductor web, sin documentar y sin autenticar. Consecuencias:

- Es **acceso automatizado no autorizado**: el mismo punto de los términos que
  incumple `yt-dlp`, aunque no descargue el vídeo.
- Es **frágil**: YouTube puede cambiar el endpoint sin avisar.
- **Limita por IP**: a las pocas peticiones devuelve 429 o captcha. Es
  exactamente el 429 que nos salió a nosotros bajando subtítulos, y que solo se
  esquivó suplantando el TLS de un navegador con `curl_cffi` — o sea, rodeando
  una medida antiautomatización.

No aporta nada frente a transcribir en local, y arrastra el mismo problema.

### Analizar para uso propio ≠ redistribuir

Son dos cosas distintas y conviene no mezclarlas:

- **Incumplir los términos** es un asunto **contractual** con YouTube. La sanción
  típica es que te corten el acceso o te cierren la cuenta, no una demanda.
- **Copiar la obra** es un asunto de **derechos de autor**, y es independiente de
  los términos. Aquí sí importa qué haces con la copia.

Descargar un vídeo, medirlo y tirar la copia es el caso más defendible: uso
privado, transformador, sin sustituir al original ni afectar a su mercado. Nada
de eso lo autoriza YouTube, pero el daño y la exposición son mínimos.

Publicar es otra cosa. **Las cifras que saca este script —duraciones de plano,
cortes por minuto, dónde cae cada corte— son medidas, no la obra**, y usarlas o
publicarlas no reproduce nada. **Los fotogramas y la transcripción sí son
reproducciones** de la obra ajena: se pueden citar de forma limitada según la
jurisdicción, pero no publicar en bloque.

Por eso `.gitignore` excluye `referencias/*/fuente/`: el vídeo descargado **no
entra en el repo**. El análisis se queda; la copia, no.

### Las vías limpias

1. **Pedir permiso al canal.** Para una referencia de estilo que vas a estudiar a
   fondo, suele ser un correo.
2. **Elegir material con licencia abierta.** YouTube permite publicar bajo
   **Creative Commons BY**, y `yt-dlp --print "%(license)s"` lo dice antes de
   descargar nada. Ahí no hay problema de derechos; queda solo el de los términos.
3. **Fuentes que no son YouTube.** Internet Archive y Prelinger sirven ficheros
   directos de dominio público, sin términos que lo impidan. Es de donde salen
   nuestros ejemplos, y por eso el script acepta ficheros locales.
4. **Obra pública por ley.** Lo producido por el gobierno de EE. UU. es dominio
   público (17 U.S.C. § 105) — NASA, entre otros. Cuidado: un canal
   institucional puede incluir material de terceros o de contratistas que no lo
   sea.
5. **Vídeos propios.** Ahí la API oficial sí da los subtítulos.

Para lo que de verdad queremos —aprender cómo un canal casa imagen y frase— la
opción 1 y la 2 dan lo mismo sin discusión posible.
