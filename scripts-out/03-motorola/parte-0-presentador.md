# Capa de presentador — Finn a cámara

**Episodio 3 · *Motorola* · nueva capa sobre el guion existente.**
Tres apariciones: entrada, corte a mitad y salida. **No sustituye narración**: la
envuelve. El guion de los cinco actos no se toca.

| | palabras | duración a 159 wpm |
|---|---|---|
| A · Entrada | 31 | **11,7 s** |
| B · Corte a mitad | 18 | **6,8 s** |
| C · Salida | 30 | **11,3 s** |
| **Total añadido** | **79** | **≈ 30 s** |

Episodio: 12:25 → **12:55**. Cuota de ElevenLabs: 11.020 → 11.450 caracteres de los
20.385 disponibles. Sigue cabiendo en una sola pasada.

---

## A · ENTRADA — 0:00, antes del cold open

>> HOST:finn-desk-wide — plano medio corto de Finn en el set de podcast, mirando a cámara

Hey — I'm Finn. I'm from Arkansas, and I make videos about the stories nobody finished telling you.

>> HOST:finn-desk-close — plano más cerrado, ligero escorzo

Today: the company that put a man's voice on the Moon, and then vanished.

>> Corte duro al COLD OPEN

---

## B · CORTE A MITAD — al final del Acto I

>> HOST:finn-desk-lean — Finn recostado hacia la mesa, tono más informal

Quick one. Every archive shot in this film was licence-checked by hand.

>> HOST:finn-desk-close

If that's your thing, subscribe.

>> Vuelta al ACTO II

**⚠️ Cambio de sitio que propongo, y el motivo.**
Pediste el corte "en el minuto 3". A los 3:00 caemos **dentro** del Acto I, justo
antes de su remate — *"And a radio that moves is an object. Every defeat in the rest
of this story comes from something that is not."* Es la frase que sostiene el
episodio entero y la que mejor engancha.

Moviendo el corte 28 segundos, a **3:28**, cae **inmediatamente después** de esa
frase. El espectador entra en la pausa con la tesis recién plantada, que es
exactamente cuando menos se abandona un vídeo. Mismo minuto aproximado, ningún coste,
y no se parte el acto por la mitad.

---

## C · SALIDA — 12:44, después del último plano

>> Negro tras *"It still says Motorola on the side."* · 2 s de silencio

>> HOST:finn-desk-wide

That's the story. This one took a lot of archive work — if you want more like it, subscribe,

>> HOST:finn-desk-close

and tell me which company should be next. I'm Finn. See you.

---

## El set y la cara

**Finn.** Hombre joven, caucásico, rubio, ojos azules, americano. Camisa lisa
oscura, sin logotipos. Nada de gafas de sol, gorras ni atrezo llamativo: la cara y la
voz llevan el peso.

**El set.** Estudio de pódcast profesional pero sobrio, no un decorado de gamer:
mesa de madera, micrófono de brazo articulado con antipop, dos monitores apagados o
fuera de plano, panel acústico detrás desenfocado, iluminación cálida de dos puntos
con un contraluz suave.

**Los tres cuadros de la pared del fondo**, de izquierda a derecha, ligeramente
desenfocados por la profundidad de campo:

1. **Una playa.** Horizonte bajo, mar y cielo, sin figuras.
2. **Unos pollos jugando al frisbee.** Absurdo y encantador — es el objeto que hace
   que el set parezca la habitación de alguien y no un decorado. Ilustración plana y
   naíf, colores planos, nada fotorrealista.
3. **Una máquina.** Corte técnico o despiece de un mecanismo: engranajes, ejes,
   bobinas. Estética de lámina de manual antiguo. **Es el guiño al episodio** — la
   empresa que sabía hacer objetos — y por eso va en el lado del encuadre donde más
   se ve en el plano cerrado.

**Sin texto legible en ningún sitio** — ni pósters, ni rótulos, ni marcas en el
micrófono, **ni firmas, ni títulos, ni cartelas en los tres cuadros**. Es la regla 4,
y los cuadros son la superficie que más la invita: un lienzo enmarcado es exactamente
donde el modelo quiere escribir algo. Va explícito en el prompt.

**Cuatro encuadres, no uno.** `finn-desk-wide` (plano medio, se ve el set),
`finn-desk-close` (busto, escorzo ligero), `finn-desk-lean` (recostado hacia la mesa,
informal), `finn-desk-hands` (manos sobre la mesa, sin cara — el plano de recurso).

---

## Identidad: Reference Element, no Soul

Finn tiene que ser **la misma persona** en las tres apariciones y en los cuatro
encuadres. Dos caminos posibles en Higgsfield:

| | Soul entrenado | **Reference Element** ✅ |
|---|---|---|
| Fidelidad | máxima | alta |
| Preparación | 5–20 fotos, ~10 min de entrenamiento | instantáneo, una sola imagen |
| Modelos compatibles | **solo** Soul V2 y Soul Cinema (imagen) | Nano Banana Pro/2, GPT Image 2, **Kling 3.0**, **Seedance 2.0** |

**Element**, sin dudarlo: nuestros modelos de vídeo son Kling 3.0 y Seedance 2.0, y
Soul no funciona con ellos — habría que generar imagen con Soul y animarla aparte,
perdiendo el control. Con Element se genera **una** imagen buena de Finn, se guarda
como referencia y se reutiliza en los cuatro encuadres y en los tres momentos.

---

## El audio y la cara: vídeo mudo en Higgsfield, voz de ElevenLabs encima

**Decisión tomada para no duplicar coste.** Existe ElevenLabs Avatars —busto
parlante con lip sync nativo— pero se descarta: obligaría a pagar generación de vídeo
en una segunda plataforma teniendo 3000 créditos ya comprados en Higgsfield.

| Herramienta | Qué produce |
|---|---|
| **Higgsfield** (Kling 3.0 / Seedance) | Los clips de Finn, **mudos**, y los 39 clips de las secuencias |
| **ElevenLabs** | **Solo voz**: los tres segmentos de presentador y los 12 minutos de narración |
| **Internet Archive** | Los 42 planos de archivo |

Una sola voz en todo el episodio, un solo proveedor de vídeo, ninguna sincronía entre
plataformas que negociar.

### Sin lip sync, y el montaje construido para que no importe

Los clips de Finn se generan **con `sound: off`**: nada de audio del modelo. Finn
aparece hablando —la boca se mueve con naturalidad— pero sin correspondencia palabra
por palabra. A dos o tres segundos por plano, eso es indetectable.

Cuatro reglas de montaje que lo sostienen:

1. **Ningún plano frontal de boca por encima de tres segundos.**
2. **Cortar en frontera de frase**, nunca a mitad. El corte sobre la pausa natural es
   lo que el ojo lee como sincronía, más que el movimiento de los labios.
3. **Encuadres de descarga entre frases**: manos sobre la mesa, escorzo, el set en
   plano abierto, el micrófono en primer plano, uno de los tres cuadros. En estos la
   boca no se ve y la voz sigue.
4. **Empezar cada segmento en plano medio** y cerrar en escorzo o manos, no al revés:
   la primera impresión es la única que se examina de verdad.

Por eso los tres segmentos van escritos ya troceados en dos y tres encuadres. No era
un plan B: es el diseño.

---

## Matiz a la regla 4, aprendido generando este set

La regla nació de una claqueta inventada — "NASA TECH DOC · REEL 4 · 1969" — que un
espectador lee como **un documento de archivo real**. Eso es lo que hay que impedir.

En el set del presentador salieron números de pieza en el esquema de la máquina y un
garabato de firma en el grabado de los pollos. **Eso no es lo mismo**: son marcas
decorativas en un decorado moderno, desenfocadas, que no afirman nada. Perseguirlas
es quemar créditos sin ganar nada.

**La regla, afinada: prohibido el texto que pueda leerse como documento o como
afirmación. Permitida la marca decorativa en un set contemporáneo.**

Una excepción que sí se corrige: **la marca del fabricante en el brazo del
micrófono**. Un logotipo comercial legible en pantalla en un vídeo monetizado es otra
categoría de problema. Va prohibido explícitamente en los cuatro encuadres.

### El montaje sigue diseñado para no depender del lip sync

Aunque ahora la sincronía debería salir nativa, cada segmento va troceado en dos o
tres encuadres en vez de un plano único: se abre en Finn, se corta a plano de manos,
al set, a escorzo, con la voz por encima. Es como se monta un pódcast de verdad, y
significa que **nunca sostenemos un plano frontal de boca más de dos o tres
segundos**. Si la sincronía sale perfecta, ganamos; si sale regular, no se nota.

---

## Coste

| | clips | créditos |
|---|---|---|
| Imagen de referencia de Finn (2–3 intentos) | — | 4–6 |
| 4 encuadres del set como imagen | 4 | 8 |
| Clips de vídeo (2 entrada · 2 mitad · 2 salida + recurso) | 7 | 52,5 |
| Margen | | 15 |
| **Total capa de presentador** | | **≈ 80** |

Suma con las 15 secuencias: **≈ 430 de 3000**. Sigue holgado.

---

## Una fricción editorial, dicha una vez

El episodio se sostiene sobre no afirmar nada que no esté verificado — hasta el punto
de que reescribimos frases para no decir "esta es una radio Motorola" sobre un plano
no identificado. Un presentador sintético que dice ser de Arkansas es una afirmación
sobre una persona que no existe.

No es lo mismo que falsear el archivo, y los presentadores de marca son un formato
establecido; muchos canales lo hacen. Pero conviene decidirlo a conciencia, no por
inercia. Si en algún momento quieres cubrirte, basta una línea en la descripción del
vídeo diciendo que el presentador es generado. **Tu decisión — yo lo construyo igual.**
