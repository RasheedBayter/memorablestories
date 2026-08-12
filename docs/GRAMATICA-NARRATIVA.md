# Gramática narrativa

**Guía de lectura de un guion reconstruido.**
Entra: un vídeo de referencia reconstruido en nuestro formato —cada frase de la
narración con el fotograma que está en pantalla mientras se dice, y la marca de dónde
cae cada corte—. Sale: una lista corta de cambios concretos en nuestro guion y en
nuestra línea de tiempo.

No es un análisis de vídeo. Es un **procedimiento de lectura**: siete preguntas, cada
una con qué buscar, cómo anotarlo, qué revela cuando la respuesta es A o es B, y qué
decisión nuestra cambia según el resultado.

El número es el suelo. La regla narrativa es el techo.

---

## 0. De dónde partimos

Medido sobre `scripts-out/03-motorola/montaje/timeline.json`,
`montaje/alineacion.json` y `montaje/palabras-parte-2.json` el 07/08/2026.
Episodio 3 (*Motorola*), 11 min 43 s, 87 planos.

| | valor medido |
|---|---|
| planos visibles | 76 · media **9,06 s** · mediana 8,09 s · 6,5 cortes/min |
| reparto en pantalla | archivo 53 % · fija 26 % · generado 19 % · negro 2 % |
| narración | 1.980 palabras · **169 ppm** · 100 párrafos · frase media 11 palabras |
| **posición del corte** | **67 de 83 caen exactamente en el límite de párrafo (±60 ms)** |
| el resto | 11 negros fijos de 1,30 s + 5 divisiones automáticas al 50 % del párrafo |
| pausas de voz | 48 en el acto II, media 0,71 s, **máxima 1,12 s** |
| silencio real (sin voz) | **0 s** — los 11 negros llevan narración encima |
| plano bajo cifra dura | 10,52 s · plano sin cifra 11,20 s (**diferencia: ninguna**) |
| tarjetas tipográficas | 8, una cada 88 s |
| rimas visuales de largo alcance | **1** (el coche patrulla de 1951: 3,4 min → 11,2 min) |

**El dato que manda sobre todos los demás: ninguna de las 83 posiciones de corte fue
elegida.** Las 83 las genera una regla del script de montaje. La imagen cambia cuando
el narrador termina un párrafo, y el corte cae dentro del hueco de ~0,7 s que hay
entre párrafo y párrafo. Nunca cambia mientras alguien habla.

Eso no es un montaje lento. Es un montaje **sin sintaxis**: no hay diferencia entre el
corte que cierra una idea y el que abre otra, porque son el mismo corte.

---

## 1. Cómo tiene que venir anotado el guion reconstruido

Para que estas siete lecturas se puedan hacer, el guion reconstruido necesita cuatro
marcas por frase. Sin ellas, la lectura no se puede ejecutar.

```
[00:41.2] ¶ Y en 1987 no había cobertura | en casi ningún sitio.
          ↑corte 00:41.2 (inicio de frase)        ↑corte 00:43.8 (tras "cobertura", coma)
          IMG-A hasta 43.8: mapa fijo, sin movimiento, rótulo "1987"
          IMG-B desde 43.8: aéreo en movimiento, sin rótulo
          VOZ: continua · MÚSICA: entra en 43.8
```

| marca | qué es | por qué hace falta |
|---|---|---|
| `[mm:ss.d]` | inicio de la frase en el audio | ancla todo lo demás |
| `\|` dentro de la frase | dónde cae cada corte **dentro** del texto | es la lectura 2, la más importante |
| `IMG-x` | descripción del fotograma + **fijo / con movimiento / movimiento interno** | lectura 3 |
| `VOZ` / `MÚSICA` | si hay voz sonando y si hay lecho musical | lectura 4 |

Y una lista aparte: **cada tramo de más de 0,8 s sin voz**, con qué imagen lo ocupa.

---

## 2. Las siete lecturas

### L1 · ¿Dónde cae el corte respecto a la frase?

**Qué buscar.** Para cada corte, la palabra que suena justo antes y la que suena justo
después. Clasificar en cuatro:

| clase | dónde cae | qué hace |
|---|---|---|
| **cierre** | tras punto, en la pausa | cierra la idea. El corte confirma lo dicho |
| **suspensión** | tras coma o dos puntos | la frase sigue en otra imagen. Enlaza |
| **tensión** | a mitad de sintagma, con la voz sonando | la imagen se adelanta a la palabra. Empuja |
| **anticipación** | la imagen entra **antes** de que la frase la nombre | el espectador ve el dato y luego lo oye confirmado |

**Cómo se anota.** Un histograma de cuatro barras, y aparte el porcentaje de cortes
que ocurren **con la voz sonando** frente a los que ocurren en una pausa.

**Qué revela.**
Si la referencia está por encima del 40 % en tensión + anticipación, su montaje va
**por delante** de la narración: la imagen entrega y la voz confirma. Si está por
encima del 80 % en cierre, la referencia es tan lockstep como nosotros y no hay nada
que copiar en esta lectura —pásese a L2.
Ojo a la **anticipación**: es la clase que más cuesta ver y la que más rinde. Si en la
referencia la imagen del dato aparece medio segundo antes de que la voz lo diga, es
una decisión de montaje deliberada, no un desfase.

**Lo nuestro.** 100 % de cortes en pausa. En el acto II, con alineación palabra a
palabra: 14 cierres, 1 suspensión, 3 «tensiones» — y las tres son la división
automática al 50 %, ninguna elegida.

**Qué decisión cambia.**
En el **guion**: marcar con `|` en el propio texto los puntos donde queremos que corte
antes de acabar la frase. Es escritura, no montaje: hay que escribir frases con una
bisagra interna que aguante el corte («Y en 1987 no había cobertura | en casi ningún
sitio»).
En el **montaje**: `render-mixed.py` tiene que aceptar cortes en un offset arbitrario
dentro del párrafo, no solo en el límite y en el 50 %. Es un cambio pequeño en el
render y grande en el resultado.

---

### L2 · ¿Qué imagen sostiene un dato duro y cuál sostiene una emoción?

**Qué buscar.** Clasificar cada frase de la referencia en **dato** (lleva cifra, fecha,
nombre propio verificable) o **juicio** (lleva valoración, ironía, consecuencia). Y
para cada una, el estado de la imagen que la sostiene:

- fija absoluta · fija con deriva lenta (Ken Burns) · movimiento interno (algo se mueve
  en el plano) · cámara en movimiento · texto en pantalla

**Cómo se anota.** Tabla cruzada 2×5, con el tiempo en pantalla, no el número de
planos. Y una columna más: **duración media del plano bajo dato frente a bajo juicio**.

**Qué revela.**
La hipótesis nuestra era «fijo para las cifras, movimiento para lo demás». Hay tres
resultados posibles y los tres son accionables:

- **La confirma** → la cifra necesita que la imagen se calle. Es una regla de montaje:
  bajo una cifra, plano fijo y, si hay rótulo, el rótulo entra con la cifra.
- **La invierte** (movimiento bajo el dato, fijo bajo el juicio) → el canal usa el
  movimiento como energía continua y reserva la quietud para el remate emocional. Es
  otra gramática, igual de coherente, y se elige una de las dos, no las dos.
- **No hay patrón** → la referencia no distingue, y lo que sostiene sus cifras es la
  tipografía, no el plano. Entonces la lectura útil es L7.

**Lo nuestro.** No distinguimos: bajo cifra 10,52 s de plano medio, sin cifra 11,20 s;
el reparto de tipos es casi idéntico (FILM 45 %/62 %, PHOTO 33 %/21 %, GEN 21 %/15 %).
La intuición está escrita en `secuencias-gen.md` («las cifras nunca las genera el
modelo, las ponemos nosotros») pero **no llegó al timeline**: la regla existe para
proteger la veracidad del rótulo, no para gobernar el plano que hay debajo.

Peor: *«Motorola. Sound in motion.»* —el momento en que la marca recibe su nombre—
suena a los 14,4 s de un plano de 27,94 s de nave de montaje. La mejor frase del acto I
no tiene imagen propia.

**Qué decisión cambia.**
En el **guion**: marcar cada frase como `DATO` o `JUICIO` en el momento de escribirla,
igual que ya marcamos `FILM:` y `GEN:`. Es una columna más en los `parte-*.md`.
En el **montaje**: una regla derivada por cada clase. Si la referencia confirma la
hipótesis, la regla es «toda frase `DATO` empieza plano nuevo, fijo, y con rótulo si la
cifra es de las doce del PROMISE».

---

### L3 · ¿Cuándo se deja respirar una imagen sin voz?

**Qué buscar.** Todo tramo de más de 0,8 s sin voz. Para cada uno anotar:

1. **Duración.**
2. **Dónde cae**: ¿tras una revelación (deja posar) o antes (crea espera)?
3. **Qué imagen lo ocupa**: ¿la que ya estaba, una nueva, o negro?
4. **Qué hace la música ahí**: ¿sigue, se corta, entra?

**Cómo se anota.** Una lista cronológica de respiraciones con esos cuatro campos, y el
porcentaje de metraje total que ocupan.

**Qué revela.**
El silencio es el único recurso que **no cuesta dinero y no compromete la veracidad**,
y es el que menos usamos. Lo que hay que aprender de la referencia no es cuánto
silencio mete, sino **de qué lado del dato lo pone**:

- silencio **después** = «esto que acabas de oír pesa». Sirve al remate.
- silencio **antes** = «prepárate». Sirve al giro.
- silencio **sobre imagen nueva** = la imagen habla sola, y eso solo funciona si la
  imagen es literalmente el objeto del que se hablaba.

**Lo nuestro.** Cero. Las pausas entre párrafos existen (48 en el acto II, media
0,71 s) pero son la respiración natural de la voz de ElevenLabs, no una decisión: la
más larga es 1,12 s. Los 11 negros duran **exactamente 1,30 s todos** y **todos llevan
voz encima** —el negro no es un silencio, es un fondo—. Las marcas `>> Silence.` que
sí están escritas en el guion (`Silence. Black`, `Silence. Photo: Iridium sat`) **no
sobrevivieron al render**.

**Qué decisión cambia.**
En el **guion**: la marca `>> Silence, N s` deja de ser decorativa y pasa a ser un
campo con duración, colocado a un lado concreto de la frase.
En el **montaje**: el render tiene que insertar hueco real en la pista de voz, no solo
poner negro debajo de la voz. Hoy es imposible expresar «aguanta esta imagen dos
segundos sin decir nada» y es el cambio de mayor rendimiento por menor coste de todo
el documento.
Candidatos ya escritos, esperando su silencio: *«That was the summit.»*,
*«Which is where people are.»*, *«It stayed ink for twenty-seven years.»*

---

### L4 · ¿Cómo se planta y se recoge algo?

**Qué buscar.** Recorrer el guion reconstruido dos veces.

- **Primera pasada, hacia delante**: anotar cada objeto, frase o plano que aparece sin
  que la narración lo justifique todavía. Eso es una **siembra**.
- **Segunda pasada, hacia atrás**: desde el final, cada vez que la narración da por
  sabido algo, localizar dónde se sembró. Eso es una **recogida**.

Para cada par medir: **distancia en minutos**, si la recogida es **verbal** (vuelve la
frase), **visual** (vuelve el plano) o **las dos**, y si la referencia **avisa** de que
está sembrando («recuerda esto») o lo deja pasar.

**Cómo se anota.** Un diagrama de arcos sobre la línea de tiempo: origen, destino,
tipo. Y el número de arcos por cada diez minutos.

**Qué revela.**
Es la lectura que separa un vídeo que se recuerda de uno que se ve. Un canal con
muchos arcos cortos (30–90 s) construye **ritmo**; uno con pocos arcos largos
(> 5 min) construye **tesis**. Los dos funcionan, pero exigen escrituras opuestas: el
arco corto se escribe línea a línea, el arco largo se escribe desde la estructura y
obliga a decidir el final antes que el principio.

Anotar también las **recogidas visuales sin recogida verbal**: el plano vuelve y la
voz no lo menciona. Es el recurso más elegante de este oficio y el más barato para
nosotros, porque no cuesta ni un fotograma nuevo —el material ya está descargado.

**Lo nuestro.** Un solo arco largo, y es bueno: la radio de policía se siembra en el
acto II a los 3,4 min (*«the part of the catalogue nobody wrote about»*) y se recoge a
los 11,2 min con **la misma película y el mismo plano** (`ThisIsYo1951`, coche patrulla
de Detroit), 7,8 minutos después. Verbal y visual a la vez.
Hay una siembra explícita bien puesta —*«Remember the shape of that. It comes back»*—
y una rima corta —el mismo salón de `Magicint1955` en 3,4 min y 5,0 min, la caja del
salón y la caja de la Luna—.
Los otros 12 assets repetidos **no son rimas**: vuelven a menos de 35 s de distancia.
Eso no es recogida, es que se acabó el material.

**Qué decisión cambia.**
En el **guion**: una tabla de siembras y recogidas al final de cada `parte-*.md`, con
minutaje, obligatoria antes de dar el guion por cerrado. Objetivo declarado de arcos
por episodio, fijado según lo que diga la referencia.
En el **montaje**: `planos-archivo.md` reserva explícitamente los planos de recogida y
**prohíbe usarlos en medio**. Hoy `ThisIsYo1951` se usa cinco veces, cuatro de ellas
seguidas en el acto II: la recogida final funciona a pesar de eso, no gracias a eso.

---

### L5 · ¿Cómo se entra y se sale de una digresión?

**Qué buscar.** Localizar todo salto —en el tiempo, de personaje o de tema— y aislar
**la frase inmediatamente anterior** y **la inmediatamente posterior**. Clasificar la
entrada:

| tipo de entrada | forma | efecto |
|---|---|---|
| **anuncio** | «para entender esto hay que volver a 1946» | seguro, lento, cuesta una frase |
| **corte seco** | la fecha nueva y punto | rápido, exige que la imagen cambie a la vez |
| **pregunta** | «¿de dónde salió esa idea?» | fácil de escribir, se gasta si se repite |
| **objeto** | un plano de un objeto que pertenece a la otra época | el más elegante, el que más depende del archivo |

Y la salida: ¿la referencia **avisa de que vuelve** o vuelve sin más? ¿Repite la última
frase de antes de irse?

**Cómo se anota.** Una tabla de digresiones: minuto, tipo de entrada, tipo de salida,
duración de la digresión, **y si el corte de imagen coincide con la frase de entrada o
la precede**. Ese último campo es el importante: si la imagen salta antes que la voz,
el espectador ya está en la otra época cuando le nombran la fecha.

**Qué revela.**
La digresión es donde más vídeos pierden al espectador y donde más se nota el oficio.
Un canal que entra siempre igual es predecible; uno que alterna anuncio y corte seco
según lo lejos que esté el salto tiene una regla, y esa regla se puede copiar.

**Lo nuestro.** 19 de 100 párrafos abren con salto temporal, casi todos por **corte
seco de fecha**: *«In 1947…»*, *«In 1962, in Scottsdale…»*, *«In August 1999…»*. Es
consistente y es sobrio, pero es un solo registro repetido veinte veces. Tenemos un
anuncio bueno (*«Remember the shape of that. It comes back»*) y una sola pregunta en
todo el episodio (*«What does a company do after it has reached the Moon?»*), y es
exactamente el punto de bisagra entre el acto II y el III. Funciona. La usamos una vez.

El caso mejor resuelto es la recogida final, que entra por **objeto**: vuelve el coche
patrulla de 1951 y solo después la voz dice *«In 1951 a film about the Detroit police
department…»*.

**Qué decisión cambia.**
En el **guion**: prohibirse abrir dos actos seguidos con la misma forma. Es una regla
de escritura verificable con un grep sobre los `parte-*.md`.
En el **montaje**: en toda entrada por objeto, el corte de imagen va **antes** que la
frase de entrada. Eso es exactamente un corte de clase «anticipación» de L1, y solo se
puede montar si el render acepta cortes fuera del límite de párrafo.

---

### L6 · ¿Qué hace la primera imagen tras el gancho?

**Qué buscar.** Delimitar el gancho: desde el primer fotograma hasta que la narración
enuncia de qué va el vídeo. Y entonces mirar **la primera imagen de después**, aislada,
respondiendo a cuatro preguntas:

1. ¿Es **concreta** (un objeto, un lugar) o **abstracta** (una textura, un esquema)?
2. ¿Es **la misma familia visual** que el gancho o rompe con ella?
3. ¿Cuánto **dura** comparada con la media del vídeo?
4. ¿La narración **la nombra** o pasa por encima?

**Cómo se anota.** El fotograma, su duración, y una frase que diga qué promete.

**Qué revela.**
El gancho promete; **la primera imagen de después dice qué clase de vídeo es esto**. Si
es concreta, el canal promete «te voy a enseñar cosas». Si es abstracta, promete «te
voy a explicar algo». Si rompe la familia visual del gancho, avisa de que el gancho era
una excepción y que el cuerpo tiene otro tono. Esa promesa se cumple o se rompe, y es
medible: comparar esa primera imagen con la imagen media del minuto 5.

Medir también **el hueco**: cuántos segundos y cuántos cortes pasan entre el final del
gancho y esa primera imagen. Si hay negro en medio, cuánto dura.

**Lo nuestro.** El cold open son tres planos en 43,2 s —dos de archivo Apollo (9,68 s y
10,88 s) y un generado de 22,64 s—, negro de 1,30 s, y la primera imagen del PROMISE es
`electronics_at_work`: una batería de válvulas encendidas, 10,18 s. Es **abstracta,
rompe la familia** (de la Luna a un primer plano de electrónica de 1943) y la narración
**no la nombra**: dice *«This is a story about a company that spent most of a century
being the best in the world at solving the previous problem.»*

Es una buena elección y fue deliberada. Lo que no es deliberado es el plano generado de
**22,64 s** que ocupa la mitad del cold open: `secuencias-gen.md` especificaba **cinco
clips** para S1 —casco, mochila, caja del módulo, la Tierra, la parabólica— y solo se
generaron tres; el timeline usa **uno**. Los primeros cuarenta segundos, que el propio
documento llama *«la secuencia más importante del episodio»*, son un plano fijo largo.

**Qué decisión cambia.**
En el **guion**: la primera marca visual después del PROMISE se elige y se justifica por
escrito, con una frase que diga qué promete. Hoy se elige, pero no se escribe por qué.
En el **producción**: la brecha entre `secuencias-gen.md` y el timeline es la deuda más
cara del episodio. De 39 clips planificados existen 8 vídeos. Cerrar S1 antes que
cualquier otra cosa.

---

### L7 · ¿Qué pasa dentro del plano cuando no hay corte?

Lectura de apoyo, y la que más ayuda cuando la referencia corta mucho más rápido que
nosotros y copiar su ritmo es imposible.

**Qué buscar.** En los planos largos de la referencia (por encima de su mediana), qué
cambia sin que haya corte: entra un rótulo · se mueve la cámara · aparece o desaparece
un elemento · cambia la escala por zoom · entra o sale la música.

**Qué revela.**
La alternativa honesta a «cortar más» es **que dentro del plano pase algo**. Un plano
de 12 s con dos entradas de rótulo tiene tres estados visuales; sin ellas tiene uno.
Nuestro material —archivo de 1933–1973 y fijas de Commons— soporta mal el corte rápido:
un plano de archivo de 2 s no se lee. Pero soporta perfectamente que entre un rótulo.

**Lo nuestro.** 8 tarjetas tipográficas en 11 min 43 s, una cada 88 s, todas en el
acto IV y el V. Los actos I, II y III no llevan ni una, y son los que más cifras
verificadas contienen: 565 dólares, 5 empleados, 179 dólares, 32 libras, 35 vatios,
3.995 dólares, 3,4 defectos por millón. **Se dicen y no se ven.**

**Qué decisión cambia.**
En el **montaje**: toda cifra que esté en la lista de doce datos del plan lleva rótulo,
y el rótulo entra **con la palabra**, no con el plano. Es la única forma de subir la
densidad de estados visuales sin tocar el archivo ni gastar créditos.

---

## 3. Ficha de lectura rellenable

Una por vídeo de referencia. Se rellena leyendo el guion reconstruido, no viendo el
vídeo.

| # | lectura | referencia | nosotros (ep. 3) | brecha | acción | dónde |
|---|---|---|---|---|---|---|
| L1 | cortes en cierre / suspensión / tensión / anticipación | %/%/%/% | 100/0/0/0 | | | guion + render |
| L1b | cortes con la voz sonando | % | **0 %** | | | render |
| L2 | estado de imagen bajo `DATO` | | sin distinguir | | | guion |
| L2b | duración de plano bajo `DATO` vs `JUICIO` | s / s | 10,5 / 11,2 | | | montaje |
| L3 | silencios > 0,8 s | n · % metraje | **0 · 0 %** | | | guion + render |
| L3b | lado del dato en que caen | antes / después | — | | | guion |
| L4 | arcos siembra→recogida por 10 min | n | **1** | | | guion |
| L4b | recogidas solo visuales | n | 1 | | | montaje |
| L5 | formas de entrada a digresión distintas | n | **1 de 4** | | | guion |
| L5b | corte de imagen antes de la frase de entrada | % | ~0 % | | | render |
| L6 | primera imagen tras el gancho | concreta/abstracta | abstracta, 10,2 s | | | guion |
| L7 | estados visuales por minuto | n | 0,7 rótulos/min | | | montaje |
| — | duración media de plano | s | 9,06 s | | | montaje |
| — | palabras por minuto | ppm | 169 | | | guion |

**Regla de uso.** Una ficha rellena que no produzca **entre tres y cinco acciones** está
mal rellena. Si produce quince, tampoco sirve: ordenar por brecha y quedarse con las
cinco primeras.

---

## 4. Qué NO copiar

Nuestro episodio se sostiene sobre dos cosas: **archivo verificado fotograma a
fotograma** y **no afirmar nada sin fuente**. Hay recursos que funcionan muy bien en
YouTube y que chocan de frente con eso. Si aparecen en la referencia, se anotan y se
descartan por escrito, no se discuten cada vez.

**1. Reconstrucción fotorrealista de personas reales en hechos reales.**
Cooper llamando en la Sexta Avenida, Galvin en su fábrica, Reagan entregando el
Baldrige. Es lo que más rinde y lo único que puede hundir el canal. Ya está prohibido
en `03-motorola-plan.md` §6 y en `secuencias-gen.md` regla 3, y hay que mantenerlo
aunque la referencia lo haga cada treinta segundos. Nuestra salida es la que ya
usamos: reconstrucción declaradamente estilizada, o el objeto sin la persona.

**2. Cifras, rótulos o documentos generados por el modelo.**
Ya nos pasó: el modelo inventó una claqueta *«NASA TECH DOC · REEL 4 · 1969»*. Un
documento de archivo fabricado es indistinguible de una falsificación. La tipografía
se compone en montaje, siempre.

**3. El corte cada dos segundos por el corte.**
Obliga a meter planos que no dicen nada. Nuestra regla —**un plano, una afirmación**—
es incompatible con un colchón visual genérico. Si la referencia corta a 2,8 s y
nosotros a 9,06 s, la respuesta no es cortar a 2,8: es **trocear cada hueco en más
planos que sí afirman algo** (lo que ya intenta `secuencias-gen.md`) y usar L7 para el
resto. Copiar el número sin copiar el material es cómo se acaba con archivo usado de
relleno.

**4. La pregunta retórica que insinúa sin afirmar.**
*«¿Y si Motorola supiera desde 1995 que Iridium iba a fracasar?»* permite decir algo no
verificado sin decirlo, y es indefendible cuando alguien lo comprueba. Toda afirmación
va con su fuente o no va. Se aplica también a la miniatura y al título.

**5. Archivo usado como textura sin identificar.**
En metraje de combate se ven radios que no son Motorola. La regla 3 del plan —**lo
adyacente se nombra como adyacente**— es innegociable, y es justo la que se rompe sin
querer cuando se acelera el ritmo. Si la referencia hace pasar material genérico por
material específico, es su problema; para nosotros es el defecto que el episodio 2 se
pasó veinte minutos denunciando en otros.

**6. Música que dicta la emoción antes de que el dato la justifique.**
Hoy no tenemos música y eso es una decisión de producción con coste. Si se añade, la
trampa que hay que evitar no es la música: es el swell que llega **antes** del dato y
le dice al espectador qué sentir. La música entra después del dato o no entra.

**7. La cara del presentador en cámara como pegamento.**
Tenemos a Finn (`generated/finn/`, 7 clips), y es un recurso caro que resuelve
transiciones sin decir nada. Un canal grande sostiene un vídeo con su presentador. A
nosotros el presentador nos consume el tiempo de pantalla que financia la tesis.

**8. Fechas relativas.**
*«Hace tres años»*, *«recientemente»*, *«cotiza en máximos»*. Ya nos costó una
corrección en el plan. Todo dato lleva su fecha absoluta.

---

## 5. Qué adoptaríamos ya, sin esperar a la referencia

Estas cinco salen de medir lo nuestro. La referencia servirá para calibrarlas, no para
descubrirlas.

1. **Cortes fuera del límite de párrafo.** Cambiar `render-mixed.py` para que acepte un
   offset arbitrario, y marcar en el guion con `|` dónde queremos cortar dentro de la
   frase. Es el desbloqueo del que dependen L1, L5b y L6.
2. **Silencio real.** Que `>> Silence, N s` inserte hueco en la pista de voz. Tres
   candidatos ya escritos: *«That was the summit.»*, *«Which is where people are.»*,
   *«It stayed ink for twenty-seven years.»*
3. **Marcar `DATO` / `JUICIO` al escribir** y derivar de ahí el estado de la imagen.
   Empezar por la regla mínima: toda frase `DATO` empieza plano nuevo.
4. **Rótulo para toda cifra de la lista de doce**, entrando con la palabra. Los actos I,
   II y III no llevan ni una tarjeta y son los que más cifras verificadas contienen.
5. **Cerrar la deuda de S1.** De 39 clips planificados existen 8. Los primeros cuarenta
   segundos del episodio son un plano generado fijo de 22,64 s donde el propio documento
   de producción pedía cinco.

---

*Medido el 07/08/2026 sobre el episodio 3 con
`python3 scripts/medir-montaje.py scripts-out/03-motorola`, que rellena la columna
«nosotros» de la ficha de la §3. Si cambia el timeline, cambian los números.*
