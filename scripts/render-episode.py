#!/usr/bin/env python3
"""
Monta el episodio: Ken Burns sobre los assets + narración + subtítulos SRT.

    python3 scripts/render-episode.py

Cuatro decisiones que no son de gusto:

**El zoom sale de la resolución de cada imagen, no de un valor fijo.** La regla
del umbral 2x dice `ancho_origen >= 2 x ancho_salida x zoom_max`. Despejando,
`zoom_max = ancho_origen / (2 x 1920)`. Un escaneo de 5.000 px admite 1,30; un
retrato del XIX de 1.200 px admite 1,0, es decir, plano fijo. Forzar el mismo
zoom sobre los dos hace temblar al pequeño, y ese temblor es lo que delata el
montaje barato. Ninguna imagen se descarta por pequeña: se le quita movimiento.

**Un segmento por sección, y el corte de segmento ES el de capítulo.** La
frontera de acto, la de capítulo y la de mid-roll son la misma cosa; tratarlas
como conceptos distintos obliga a mantener tres listas sincronizadas a mano.

**`concat -c copy` exige GOP cerrado.** Sin `-g 60 -keyint_min 60
-sc_threshold 0` los segmentos se concatenan con saltos en las junturas, porque
un keyframe a mitad de GOP no es un punto de corte válido. Con GOP cerrado el
montaje final no recodifica: es copia de bytes, y por eso tarda segundos en vez
de minutos.

**Los subtítulos NO se queman.** Van como pista SRT: de quince canales del nicho
auditados, cero los queman. Y esta build de ffmpeg ni siquiera trae libass, así
que la decisión está tomada por partida doble.
"""

import json
import math
import pathlib
import subprocess
import sys

BASE = pathlib.Path('scripts-out/01-semmelweis')
ASSETS = BASE / 'assets-curados.json'
NARRACION = BASE / 'narration.wav'
LINEA = BASE / 'timeline.json'
SRT = BASE / 'narration.srt'
SEGMENTOS = BASE / 'segments'
SALIDA = BASE / 'the-doctor-who-was-right.mp4'

W, H, FPS = 1920, 1080, 30

# Régimen de archivo clásico: 4,5-6 planos por minuto. Por debajo se siente
# muerto; por encima deja de leerse como documental y empieza a leerse como
# montaje de redes, que es justo lo que la política de contenido penaliza.
SEG_POR_PLANO_MIN, SEG_POR_PLANO_MAX = 10.0, 13.0


def zoom_seguro(ancho: int, alto: int) -> float:
    """Regla del umbral 2x, despejada. 1,0 significa plano fijo."""
    if not ancho or not alto:
        return 1.0
    # El eje que manda es el que se queda corto al encuadrar a 16:9.
    escala = min(ancho / W, alto / H)
    return max(1.0, min(1.30, escala / 2 * 2))


def ffprobe_dur(ruta: pathlib.Path) -> float:
    """Duración real. Lanza si el fichero no es decodificable: eso es la señal."""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(ruta)],
        capture_output=True, text=True, check=True)
    texto = out.stdout.strip()
    if not texto:
        raise ValueError(f'{ruta.name}: ffprobe no devolvió duración (fichero truncado)')
    return float(texto)


def construir_segmento(idx: int, seccion: str, imagenes: list[dict], dur: float) -> pathlib.Path:
    """Un segmento de vídeo mudo con Ken Burns sobre N imágenes."""
    destino = SEGMENTOS / f'{idx:02d}-{seccion}.mp4'

    # La caché valida DECODIFICANDO, no pesando. La versión anterior aceptaba
    # cualquier fichero de más de 100 KB, y un MP4 truncado —el render muerto a
    # mitad de escritura— pasaba la prueba. El resultado: el montaje reutilizó un
    # segmento roto, perdió los 94,6 s del cierre sin un solo error, y el cálculo
    # de cola creyó que faltaban 102 s y generó una imagen fija de dos minutos.
    #
    # Un fichero de vídeo está bien si ffprobe puede leer su duración y esa
    # duración es la esperada. Cualquier otra comprobación es una suposición.
    if destino.exists():
        try:
            real = ffprobe_dur(destino)
            if abs(real - dur) < 1.0:
                print(f'  = {destino.name}  (ya estaba, {real:.1f}s)')
                return destino
            print(f'  ↻ {destino.name}  dura {real:.1f}s y debería {dur:.1f}s: se rehace')
        except (subprocess.CalledProcessError, ValueError):
            print(f'  ↻ {destino.name}  ilegible: se rehace')
        destino.unlink()

    n = max(1, min(len(imagenes), round(dur / SEG_POR_PLANO_MIN)))
    usar = imagenes[:n]
    por_plano = dur / len(usar)

    entradas, filtros = [], []
    for i, img in enumerate(usar):
        # `-framerate` ANTES de `-i` fija la cadencia de ENTRADA. Sin él, `-loop 1`
        # entra a 25 fps y `-t 3` produce 75 frames en vez de 90: el segmento sale
        # un 17 % corto y la narración se desincroniza acumulativamente.
        entradas += ['-framerate', str(FPS), '-loop', '1',
                     '-t', f'{por_plano:.3f}', '-i', img['fichero']]
        z = zoom_seguro(img['ancho'], img['alto'])
        frames = max(2, int(por_plano * FPS))

        if z <= 1.001:
            # Plano fijo. Una imagen pequeña ampliada a pantalla completa se ve
            # blanda, así que se encuadra a su tamaño con fondo desenfocado de
            # ella misma: es la convención de archivo y no finge resolución que
            # no existe.
            filtros.append(
                f'[{i}:v]split[fg{i}][bg{i}];'
                f'[bg{i}]scale={W}:{H}:force_original_aspect_ratio=increase,'
                f'crop={W}:{H},gblur=sigma=28,eq=brightness=-0.14[b{i}];'
                f'[fg{i}]scale={W}:{H}:force_original_aspect_ratio=decrease[f{i}];'
                f'[b{i}][f{i}]overlay=(W-w)/2:(H-h)/2,'
                f'setsar=1,fps={FPS},format=yuv420p[v{i}]')
        else:
            # zoompan trabaja sobre la imagen YA ampliada: hacerlo al revés
            # cuantiza el desplazamiento a píxeles de origen y produce el tirón
            # característico del Ken Burns mal hecho. 2x la salida basta para
            # zoom <= 1,30 y evita escalar a 8K, que multiplica el tiempo de
            # render sin ganar un píxel visible.
            grande_w, grande_h = W * 2, H * 2
            paso = (z - 1) / max(1, frames - 1)

            # `d=1` y rampa sobre `on`, NO `d=frames` acumulando sobre `zoom`.
            # Con `d=N` zoompan emite N frames POR CADA frame de entrada, y como
            # `-loop 1 -t` ya produce una secuencia, el segmento salía 75 veces
            # más largo. Medido: un clip de 3 s daba 6.750 frames en vez de 90.
            if i % 2 == 0:
                expr_z = f"'min(1+{paso:.6f}*on,{z:.4f})'"
            else:
                expr_z = f"'max({z:.4f}-{paso:.6f}*on,1.0)'"

            filtros.append(
                f'[{i}:v]scale={grande_w}:{grande_h}:force_original_aspect_ratio=increase,'
                f'crop={grande_w}:{grande_h},'
                f'zoompan=z={expr_z}:d=1:'
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS},"
                f'setsar=1,format=yuv420p[v{i}]')

    cadena = ''.join(f'[v{i}]' for i in range(len(usar)))
    filtros.append(f'{cadena}concat=n={len(usar)}:v=1:a=0[out]')

    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *entradas,
           '-filter_complex', ';'.join(filtros), '-map', '[out]',
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
           # GOP cerrado: es lo que permite que el concat final sea copia.
           '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
           '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an', str(destino)]

    subprocess.run(cmd, check=True, capture_output=True)
    print(f'  ✓ {destino.name}  {len(usar)} planos · {dur:.1f}s')
    return destino


def main() -> None:
    for req in (ASSETS, NARRACION, LINEA):
        if not req.exists():
            sys.exit(f'Falta {req}')

    catalogo = json.loads(ASSETS.read_text(encoding='utf-8'))
    if not catalogo:
        sys.exit('El catálogo de assets está vacío.')
    linea = json.loads(LINEA.read_text(encoding='utf-8'))
    secciones = linea['sections']

    SEGMENTOS.mkdir(parents=True, exist_ok=True)

    total = sum(v['endSec'] - v['startSec'] for v in secciones.values())
    print(f'\nnarración {total / 60:.1f} min · {len(catalogo)} imágenes · '
          f'{len(secciones)} secciones\n')

    # Cada asset se asigna a la sección que HABLA de él, no por turno rotatorio.
    #
    # La primera versión repartía con un cursor que avanzaba por número de
    # planos, y el resultado fue que el pivote —la autopsia de Kolletschka, la
    # muerte del amigo— salía ilustrado con el laboratorio de Robert Koch,
    # micrografías de estreptococo y lavado de manos en Ruanda. Todas imágenes
    # correctas del episodio, todas treinta años fuera de sitio.
    #
    # Un documental cuya imagen contradice lo que se está narrando es peor que
    # uno con menos imágenes, porque el espectador nota el desajuste aunque no
    # sepa nombrarlo.
    PARA_SECCION: dict[str, list[str]] = {
        'cold-open': ['Vienna General Hospital', 'History of Vienna', 'Puerperal fever'],
        'promise': ['Ignaz Semmelweis', 'Hand washing'],
        'act-i-the-arithmetic-of-the-two-doors': [
            'Vienna General Hospital', 'Puerperal fever', 'Midwifery',
            'History of obstetrics', 'Ignaz Semmelweis', 'Bloodletting',
            'Miasma theory', 'History of Vienna'],
        'pivot-kolletschka': ['Anatomical theatre', 'Autopsy', 'Vienna General Hospital'],
        'act-ii-the-experiment': ['Hand washing', 'Ignaz Semmelweis', 'Midwifery'],
        'recap': ['Vienna General Hospital', 'Anatomical theatre'],
        'act-iii-the-thirty-causes': [
            'Rudolf Virchow', 'Ferdinand Ritter von Hebra', 'Josef Škoda',
            'Carl Braun von Fernwald', 'Ignaz Semmelweis', 'Budapest'],
        'resolution': ['Lunatic asylum', 'Ignaz Semmelweis'],
        'act-iv-what-it-actually-was': [
            'Streptococcus pyogenes', 'Robert Koch', 'Louis Pasteur',
            'Optical microscope'],
        'close': ['Hand washing', 'Ignaz Semmelweis'],
    }

    por_articulo: dict[str, list[dict]] = {}
    for a in catalogo:
        por_articulo.setdefault(a['articulo'], []).append(a)

    usados: set[str] = set()
    segmentos, capitulos = [], []

    for i, (sid, rango) in enumerate(secciones.items()):
        dur = rango['endSec'] - rango['startSec']
        cuantas = max(1, round(dur / SEG_POR_PLANO_MAX))

        # Ronda 1: sin repetir, recorriendo los artículos de la sección en orden.
        trozo: list[dict] = []
        for art in PARA_SECCION.get(sid, []):
            for a in por_articulo.get(art, []):
                if len(trozo) >= cuantas:
                    break
                if a['fichero'] not in usados:
                    trozo.append(a)
                    usados.add(a['fichero'])

        # Ronda 2: si la sección es larga, repite las SUYAS antes que tomar
        # prestadas de otra. La reutilización dentro del acto es invisible; la
        # imagen de otro acto se nota.
        propias = [a for art in PARA_SECCION.get(sid, []) for a in por_articulo.get(art, [])]
        k = 0
        while len(trozo) < cuantas and propias:
            trozo.append(propias[k % len(propias)])
            k += 1
        while len(trozo) < cuantas:
            trozo.append(catalogo[len(trozo) % len(catalogo)])

        capitulos.append((rango['startSec'], sid))
        segmentos.append(construir_segmento(i, sid, trozo, dur))
        ultima = trozo[-1]

    def concatenar(partes: list[pathlib.Path], destino: pathlib.Path) -> float:
        lista = SEGMENTOS / 'concat.txt'
        lista.write_text(''.join(f"file '{p.name}'\n" for p in partes), encoding='utf-8')
        subprocess.run(
            ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-f', 'concat', '-safe', '0', '-i', str(lista), '-c', 'copy', str(destino)],
            check=True, capture_output=True)
        return ffprobe_dur(destino)

    mudo = BASE / 'video-mudo.mp4'
    dur_video = concatenar(segmentos, mudo)
    dur_audio = ffprobe_dur(NARRACION)
    print(f'\n  vídeo mudo  {dur_video:.1f}s   ·   narración {dur_audio:.1f}s')

    # El vídeo sale SIEMPRE algo más corto que la narración: `-t` por plano se
    # cuantiza a frames enteros y la pérdida se acumula sobre ~100 planos. En la
    # primera corrida fueron 7,7 s, y como el mux usa `-shortest`, esos segundos
    # se los comía del FINAL del audio: el cierre del guion desaparecía sin que
    # nada avisara.
    #
    # La cola es un SEGMENTO más, no un `tpad` sobre el vídeo ya montado. La
    # primera versión hacía lo segundo, y eso re-codificaba los 21 minutos
    # enteros para añadir ocho segundos: media hora de trabajo que anulaba justo
    # la ventaja del concat por copia. Como segmento propio con los mismos
    # parámetros de encoder, la cola entra también por copia y el montaje final
    # sigue costando segundos.
    falta = dur_audio - dur_video
    if falta > 0.04:
        cola = SEGMENTOS / '99-cola.mp4'
        z = zoom_seguro(ultima['ancho'], ultima['alto'])
        if z <= 1.001:
            vf = (f'scale={W}:{H}:force_original_aspect_ratio=decrease,'
                  f'pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black')
        else:
            # Fija al zoom FINAL del plano anterior: si volviera a 1.0 se vería
            # un salto de escala justo en el corte.
            vf = (f'scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,'
                  f'crop={W * 2}:{H * 2},scale=iw/{z:.4f}:ih/{z:.4f},'
                  f'crop={W}:{H}')
        subprocess.run(
            ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-framerate', str(FPS), '-loop', '1', '-t', f'{falta + 0.2:.3f}',
             '-i', ultima['fichero'], '-vf', f'{vf},setsar=1,format=yuv420p',
             '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
             '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
             '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an', str(cola)],
            check=True, capture_output=True)
        dur_video = concatenar([*segmentos, cola], mudo)
        print(f'  cola de {falta + 0.2:.2f}s como segmento → {dur_video:.1f}s (copia, sin recodificar)')

    # Capítulos como metadatos: YouTube los lee, y son las MISMAS fronteras.
    meta = BASE / 'chapters.txt'
    lineas = [';FFMETADATA1\n']
    for j, (ini, sid) in enumerate(capitulos):
        fin = capitulos[j + 1][0] if j + 1 < len(capitulos) else linea['durationSec']
        titulo = sid.replace('-', ' ').title()
        lineas.append(f'[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(ini * 1000)}\n'
                      f'END={int(fin * 1000)}\ntitle={titulo}\n')
    meta.write_text(''.join(lineas), encoding='utf-8')

    # Mezcla final. El audio se normaliza a -14 LUFS, que es el objetivo de
    # YouTube: por encima lo bajan ellos y el resultado suena aplastado.
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
           '-i', str(mudo), '-i', str(NARRACION), '-i', str(meta)]
    if SRT.exists():
        cmd += ['-i', str(SRT)]
    cmd += ['-map', '0:v', '-map', '1:a', '-map_metadata', '2']
    if SRT.exists():
        cmd += ['-map', '3', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng']
    cmd += ['-c:v', 'copy',
            '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-movflags', '+faststart', '-shortest', str(SALIDA)]
    subprocess.run(cmd, check=True, capture_output=True)

    dur = ffprobe_dur(SALIDA)
    mb = SALIDA.stat().st_size / 1024 / 1024
    print(f'\n  ▸ {SALIDA}')
    print(f'    {int(dur // 60)}:{int(dur % 60):02d} · {mb:.0f} MB · '
          f'{len(capitulos)} capítulos · subtítulos {"sí" if SRT.exists() else "no"}\n')


if __name__ == '__main__':
    main()
