# Secuencias generadas — episodio 3 (*Motorola*)

Sustituye a la lista plana de 15 huecos. **Los huecos siguen siendo 15**; lo que
cambia es que por dentro dejan de ser un plano fijo y pasan a ser **secuencias de 2 a
5 clips**. Mismo tiempo de pantalla, mismo porcentaje de archivo, muchos más cortes.

**Presupuesto: 350 créditos.** Medido con preflight el 05/08/2026:
imagen Nano Banana Pro 2K = **2 cr** · vídeo Kling 3.0 5 s std sin audio = **7,5 cr**.

---

## Las tres reglas que gobiernan todo lo generado

**1. Que parezca rodado el mismo año que el archivo de al lado.**
El 55 % del episodio es película de 1933–1973 con grano, halación, óptica blanda y
suciedad de emulsión. Un plano limpio de 2026 no impacta: delata el corte. Todos los
prompts piden emulsión de época, aberración, viñeteo y cámara quieta o casi. La
excepción es el cierre, que sí es contemporáneo y debe parecerlo.

**2. Las cifras nunca las genera el modelo. Las ponemos nosotros.**
La imagen generada aporta el mundo —satélites, órbitas, mapas, el papel del informe—
y la tipografía se compone encima en montaje. Así se conserva el impacto visual sin
arriesgar que un 6 % salga convertido en un 8 %. Esto vale para las seis secuencias
de esquema.

**3. Ninguna persona. Punto.**
No basta con "ninguna persona real": el primer intento del cold open pedía tres veces
que no hubiera rostro y salió **una cara con los ojos visibles tras el visor**, que en
un episodio sobre el Apolo 11 se lee como Neil Armstrong. La regla operativa es más
dura: **si un plano implica a alguien dentro, se cambia el plano**. El interior del
casco pasó a ser un casco vacío sobre un banco — y es mejor imagen.

**4. Ni una letra en la imagen generada.**
Descubierto al segundo intento: pedir textura de época —"documental técnico de la NASA
de 1969"— hace que el modelo **invente rótulos de archivo**. Salió una claqueta con
"NASA TECH DOC · REEL 4 · 1969 · A7L HELMET TEST", que es un documento de archivo
fabricado y exactamente lo que este episodio no puede permitirse. Todo prompt lleva un
bloque explícito prohibiendo claquetas, pizarras, etiquetas, carteles, letras, cifras,
logotipos e insignias, y exigiendo que cualquier superficie que normalmente llevaría
texto salga en blanco.

---

## Método de producción: imagen primero, vídeo después

No se pide vídeo directamente. Para cada clip:

1. **Generar la imagen** con `nano_banana_pro` (2 cr).
2. **Mirarla.** Sin mirarla no pasa — la misma disciplina que con los fotogramas de
   archivo.
3. **Animar solo la aprobada** con `kling3_0` desde ese fotograma (7,5 cr).

Cuesta 2 créditos más por clip y los devuelve con creces: un fallo en la fase de imagen
cuesta 2 en vez de 7,5, y sobre todo **las violaciones de regla se cazan baratas**. Las
dos reglas de arriba salieron precisamente de ahí.

Coste real del arranque: 11,5 créditos para dejar aprobado el primer fotograma
(un vídeo descartado por la cara, una imagen descartada por la claqueta, una aprobada).

---

## Las secuencias

### S1 · `senal-luna-tierra` — el viaje de la señal · COLD OPEN
**5 clips · 37,5 cr.** La secuencia más importante del episodio: son los primeros
cuarenta segundos y deciden si el espectador se queda.

1. Interior del casco, el micrófono junto a la boca, respiración empañando el visor.
2. La mochila de soporte vital a la espalda, la antena de pala en lo alto.
3. Interior del módulo lunar: la caja atornillada a la pared, luces de estado.
4. La Tierra pequeña y lejana, negro alrededor, un arco de señal apenas insinuado.
5. Una parabólica de seguimiento girando en el desierto, noche.

### S2 · `eliminador-baterias-1928` — el primer producto · ACTO I
**2 clips · 15 cr.** Banco de taller de 1928: la caja negra con bornes, luz lateral de
ventana, polvo en el aire. Segundo plano, el cable de red enchufado a la pared.

### S3 · `radio-coche-1930-salpicadero` — la radio que se mueve · ACTO I
**3 clips · 22,5 cr.** Salpicadero de madera y metal, la caja atornillada debajo.
Detalle del dial redondo. Y el coche en marcha desde dentro, el paisaje pasando por
la ventanilla — **el plano que dice la tesis: la radio se mueve.**

### S4 · `televisor-siete-pulgadas-1947` — la caja en el salón · ACTO II
**2 clips · 15 cr.** Mueble de madera con pantalla de siete pulgadas encendida en un
salón vacío. Y el resplandor de la pantalla sobre la pared a oscuras.

### S5 · `radio-pulsera-1946` — lo que Gould dibujó · ACTO III
**2 clips · 15 cr.** Esquema de patente sobre papel de época, la muñeca y el aparato.
**Estilo declaradamente de dibujo, nunca fotorrealista** — no puede confundirse ni con
archivo ni con una viñeta de Gould, que sigue con derechos.

### S6 · `sexta-avenida-1973` — la llamada · ACTO III
**3 clips · 22,5 cr.** Acera de Manhattan en 1973 a la altura del suelo, sin rostros.
Una cabina telefónica con el auricular colgando. Y el cielo entre edificios.
**No se reconstruye a Cooper.** El plano acompaña, no ilustra.

### S7 · `constelacion-77-vs-66` — el dibujo de 1987 · ACTO IV
**4 clips · 30 cr.** La Tierra de noche desde órbita alta. Los puntos apareciendo uno
a uno hasta llenar el cielo. Un plano orbital completo visto de canto. Y la retirada
de once puntos. **Las cifras 77 y 66 van compuestas encima, no generadas.**

### S8 · `telefono-satelite-no-funciona` — «which is where people are» · ACTO IV
**3 clips · 22,5 cr.** La mejor línea del acto y hoy es un solo plano fijo. Pasa a
escalera de tres:
1. Despacho de los noventa, el aparato sobre la mesa **lejos de la ventana**.
2. Interior de un coche, la antena contra el techo.
3. Calle estrecha entre torres, una franja de cielo al fondo.
La narración dice que no funciona bajo techo, ni en un coche, ni en una ciudad. Los
tres planos son exactamente esos tres sitios, en ese orden.

### S9 · `el-suelo-se-movio` — las antenas ganando desde abajo · ACTO IV
**3 clips · 22,5 cr.** Un mástil barato en una colina al amanecer. Otro. Otro más,
hasta que se ven tres a la vez en el mismo valle. Contra la constelación de arriba:
**lo aburrido gana.**

### S10 · `cinco-mil-veinticinco-ocho-mil` — las tres cifras · ACTO IV
**2 clips · 15 cr.** Fondo de sala vacía, luz dura. **Las cifras se componen encima.**

### S11 · `razr-lo-que-no-habia-detras` — el objeto y el vacío · ACTO V
**3 clips · 22,5 cr.** El RAZR cerrado sobre superficie lisa, luz de joyería, giro
lentísimo. El teclado grabado encendiéndose en azul. Y el mismo objeto en una sala
vacía, la luz apagándose. **El objeto más bello de la década, y detrás no había nada.**

### S12 · `curva-cuota-2006-2009` — la caída · ACTO V
**2 clips · 15 cr.** Textura de papel de informe, luz rasante. **Curva y cifras encima.**

### S13 · `parrafo-10k-2009` — la cifra que desaparece · ACTO V
**2 clips · 15 cr.** Página de informe anual a contraluz, el ojo yendo al párrafo.
**El texto se compone encima**, y es una cita literal: hay que escribirla bien.

### S14 · `google-lenovo-flujo` — 12.500 → 2.910 · ACTO V
**2 clips · 15 cr.** Abstracto de flujo y desvío. **Cifras encima.**

### S15 · `radio-hombro-hoy` — lo que quedó · CIERRE
**3 clips · 22,5 cr.** **Aquí sí, contemporáneo y nítido**, en contraste deliberado con
todo lo anterior: micrófono de hombro en primer plano, sin rostro. La rejilla del
altavoz. Y el lateral de un vehículo de emergencias, sin marca legible.

---

## Presupuesto

| | clips | créditos |
|---|---|---|
| 15 secuencias | **39 clips de vídeo** | 292,5 |
| Imágenes de arranque para los planos que lo necesiten | ~15 | 30 |
| **Subtotal** | | **322,5** |
| Margen de reintentos | ~4 clips | 30 |
| **Total** | | **≈ 352 de 3000** |

Sobran 2650 créditos. Si una secuencia sale floja, se rehace sin mirar el precio.

---

## Orden de producción

1. **S1 (cold open)** primero y sola. Es la que decide el tono de todo el episodio: si
   la textura no casa con el archivo, se ajustan los prompts antes de generar las otras
   catorce, no después.
2. Luego **S8, S9 y S11**, las de más impacto narrativo en el tramo con menos archivo.
3. El resto por orden de acto.
4. Las seis de esquema (S7, S10, S12, S13, S14 y la parte de cifras de S1) **se generan
   sin texto**; la tipografía se compone en montaje.

## Lo que NO se genera

Las 19 fijas con fichero de Commons verificado **se quedan como fijas con Ken Burns**.
Son fotografías reales de objetos reales —el DynaTAC, el RAZR, el satélite Iridium, el
trofeo Baldrige— y sustituirlas por una recreación generada cambiaría un documento por
un dibujo. El movimiento se les da en montaje, no en el modelo.
