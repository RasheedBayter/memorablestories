#!/usr/bin/env python3
"""
Monta un episodio mezclando metraje real de archivo, fotos fijas y vídeo IA.

    python3 scripts/render-mixed.py 02-duck-and-cover

QUÉ LO DIFERENCIA DEL RENDER ANTERIOR

`render-episode.py` solo sabía animar fotos. Este sabe además CORTAR PLANOS de
películas de dominio público, que es lo que hace que el resultado parezca real:
no es una foto con movimiento inventado, es cine de época.

EL REPARTO SALE DEL GUION, NO DE UN PORCENTAJE

Las pistas visuales que empiezan por `FILM:` piden metraje de una película
concreta; el resto piden foto. Así la proporción de archivo no se impone desde
fuera —"quiero un 50 %"— sino que emerge de dónde el guion pide qué. Un acto que
habla de lo que decía una película se ilustra con esa película; un acto que
habla de lo que pensaba el Congreso, no.

El informe final dice la mezcla REAL conseguida, que es la que importa.

LA SINCRONÍA MANDA SOBRE TODO

Cada segmento de vídeo dura su HUECO en el audio —incluidos el silencio de
entrada y los respiros entre actos— y no su tiempo de habla. Concatenar los
segmentos pegados adelantaba la imagen hasta 7 s al final del episodio, y la
duración total seguía cuadrando porque la cola lo compensaba. Ver
`render-episode.py` para la medición.
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

W, H, FPS = 1920, 1080, 30
SEG_POR_PLANO = 11.0     # régimen de archivo: ~5,5 planos por minuto


def ffprobe_dur(ruta: pathlib.Path) -> float:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(ruta)],
        capture_output=True, text=True, check=True)
    t = out.stdout.strip()
    if not t:
        raise ValueError(f'{ruta.name}: ffprobe no devolvió duración')
    return float(t)


def secciones_del_guion(md: pathlib.Path) -> dict[str, list[str]]:
    """Pistas visuales por sección, en orden."""
    cuerpo = md.read_text()
    if '\n---\n' in cuerpo:
        cuerpo = '\n---\n'.join(cuerpo.split('\n---\n')[1:])
    out: dict[str, list[str]] = {}
    actual = None
    for linea in cuerpo.split('\n'):
        s = linea.strip()
        if s.startswith('## '):
            titulo = s[3:].strip()
            if titulo.lower().startswith('fuentes'):
                break
            actual = titulo.lower().replace('—', '').replace('  ', ' ')
            actual = re.sub(r'[^a-z0-9]+', '-', actual).strip('-')
            out[actual] = []
        elif s.startswith('>> ') and actual:
            out[actual].append(s[3:].strip())
    return out


def zoom_seguro(a: int, b: int) -> float:
    if not a or not b:
        return 1.0
    return max(1.0, min(1.30, min(a / W, b / H)))


def clip_de_archivo(peli: pathlib.Path, ini: float, dur: float, destino: pathlib.Path) -> None:
    """
    Corta un plano de una película y lo lleva al formato del montaje.

    `-ss` va ANTES de `-i` para que ffmpeg busque por keyframe en vez de
    decodificar desde el principio: sobre una película de diez minutos la
    diferencia es de segundos a minutos por corte, y con cincuenta cortes eso
    decide si el render dura veinte minutos o dos horas.

    El material de archivo es 4:3 a 320x240 o 640x480. Se amplía con `lanczos` y
    se pone sobre fondo desenfocado de sí mismo en vez de recortarlo a 16:9:
    recortar un 4:3 a panorámico se come la cabeza de la gente, y en cine de
    época la composición está centrada y apretada.
    """
    vf = (
        f'split[fg][bg];'
        f'[bg]scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,'
        f'crop={W}:{H},gblur=sigma=32,eq=brightness=-0.18[b];'
        f'[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[f];'
        f'[b][f]overlay=(W-w)/2:(H-h)/2,fps={FPS},setsar=1,format=yuv420p'
    )
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-ss', f'{ini:.2f}', '-i', str(peli), '-t', f'{dur:.2f}',
         '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
         '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
         '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an', str(destino)],
        check=True, capture_output=True)


def clip_de_foto(img: dict, dur: float, destino: pathlib.Path) -> None:
    z = zoom_seguro(img['ancho'], img['alto'])
    frames = max(2, int(dur * FPS))
    if z <= 1.001:
        vf = (f'split[fg][bg];'
              f'[bg]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
              f'gblur=sigma=28,eq=brightness=-0.14[b];'
              f'[fg]scale={W}:{H}:force_original_aspect_ratio=decrease[f];'
              f'[b][f]overlay=(W-w)/2:(H-h)/2,fps={FPS},setsar=1,format=yuv420p')
    else:
        paso = (z - 1) / max(1, frames - 1)
        vf = (f'scale={W*2}:{H*2}:force_original_aspect_ratio=increase,crop={W*2}:{H*2},'
              f"zoompan=z='min(1+{paso:.6f}*on,{z:.4f})':d=1:"
              f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS},"
              f'setsar=1,format=yuv420p')
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-framerate', str(FPS), '-loop', '1', '-t', f'{dur:.3f}', '-i', img['fichero'],
         '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
         '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
         '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an', str(destino)],
        check=True, capture_output=True)


def main() -> None:
    ep = sys.argv[1] if len(sys.argv) > 1 else '02-duck-and-cover'
    B = pathlib.Path('scripts-out') / ep
    MD = pathlib.Path('scripts-out') / f'{ep}.md'
    SEG = B / 'segments'
    SEG.mkdir(parents=True, exist_ok=True)

    linea = json.loads((B / 'timeline.json').read_text())
    secciones = linea['sections']
    pistas = secciones_del_guion(MD)
    planos = json.loads((B / 'footage' / 'planos.json').read_text())
    fotos = json.loads((B / 'assets-curados.json').read_text()) if (B / 'assets-curados.json').exists() else []

    # Clips de IA: sustituyen tiempo dentro de su sección, nunca se suman. La
    # duración de la sección la fija la narración.
    gen_por_seccion: dict[str, list[dict]] = {}
    plan_gen = B / 'generated' / 'plan.json'
    if plan_gen.exists():
        for g in json.loads(plan_gen.read_text()):
            if pathlib.Path(g['fichero']).exists():
                gen_por_seccion.setdefault(g['seccion'], []).append(g)

    por_peli: dict[str, list[dict]] = {}
    for p in planos:
        por_peli.setdefault(p['peli'], []).append(p)
    cursor_peli = {k: 0 for k in por_peli}
    cursor_foto = 0
    # Fotos ya gastadas. Cuando se agotan, NO se repiten: se tira de un plano de
    # archivo sin usar.
    #
    # Medido sobre la versión anterior: 325 s de 965 —el 34 % del episodio—
    # mostraban imágenes repetidas, y tres de ellas salían SIETE veces. La causa
    # es aritmética: 35 fotos rotando sobre ~90 huecos. Mientras tanto había 144
    # planos de archivo y se usaba una fracción.
    #
    # Repetir una foto es lo peor de las tres opciones: el archivo no repetido
    # siempre es preferible, porque además es material real.
    fotos_usadas: set[int] = set()

    def siguiente_plano_archivo(preferida: str | None = None):
        """Un plano de archivo no usado. Prefiere la película indicada."""
        orden = ([preferida] if preferida in por_peli else []) + \
                sorted(por_peli, key=lambda k: cursor_peli[k] / max(1, len(por_peli[k])))
        for peli in orden:
            if cursor_peli[peli] < len(por_peli[peli]):
                p = por_peli[peli][cursor_peli[peli]]
                cursor_peli[peli] += 1
                return peli, p
        return None, None

    dur_audio = ffprobe_dur(B / 'narration.wav')
    ids = list(secciones.keys())
    huecos = []
    for i, sid in enumerate(ids):
        ini = 0.0 if i == 0 else secciones[sid]['startSec']
        fin = secciones[ids[i + 1]]['startSec'] if i + 1 < len(ids) else dur_audio
        huecos.append(fin - ini)

    print(f'\n{ep} · narración {dur_audio/60:.1f} min · {len(ids)} secciones')
    print(f'{len(planos)} planos de archivo · {len(fotos)} fotos\n')

    segmentos, capitulos = [], []
    seg_archivo = seg_foto = seg_ia = 0.0

    for i, sid in enumerate(ids):
        dur = huecos[i]
        destino = SEG / f'{i:02d}-{sid[:34]}.mp4'
        capitulos.append((0.0 if i == 0 else secciones[sid]['startSec'], sid))

        if destino.exists():
            try:
                if abs(ffprobe_dur(destino) - dur) < 1.0:
                    print(f'  = {destino.name}')
                    segmentos.append(destino)
                    continue
            except (subprocess.CalledProcessError, ValueError):
                pass
            destino.unlink()

        gen = gen_por_seccion.get(sid, [])
        dur_gen = sum(g['duracionSegundos'] for g in gen)
        dur_resto = max(1.0, dur - dur_gen)

        cues = pistas.get(sid, []) or ['Foto']
        n = max(1, min(len(cues), round(dur_resto / SEG_POR_PLANO)))
        elegidas = cues[:n]
        por_plano = dur_resto / len(elegidas)

        partes, na, nf = [], 0, 0
        for j, cue in enumerate(elegidas):
            trozo = SEG / f'.{i:02d}-{j:02d}.mp4'
            m = re.match(r'FILM:(\w+)', cue)
            if m and m.group(1) in por_peli:
                peli = m.group(1)
                lista = por_peli[peli]
                # Un plano de archivo casi nunca dura lo que el hueco pide, así
                # que se ENCADENAN planos consecutivos hasta cubrirlo y se
                # recorta el último.
                #
                # La primera versión hacía `min(hueco, duración del plano)` y
                # dejaba el resto sin cubrir. El déficit se acumulaba: medido,
                # 796 s de vídeo contra 965 de audio — dos minutos y cuarenta y
                # nueve segundos, que `-shortest` se comía del FINAL de la
                # narración. El comentario decía que el sobrante se rellenaba;
                # el código no lo hacía.
                sub, cubierto, k = [], 0.0, 0
                while cubierto < por_plano - 0.05 and k < 12:
                    if cursor_peli[peli] >= len(lista):
                        break
                    p = lista[cursor_peli[peli]]
                    cursor_peli[peli] += 1
                    d = min(p['dur'], por_plano - cubierto)
                    if d < 0.5:
                        break
                    sp = SEG / f'.{i:02d}-{j:02d}-{k:02d}.mp4'
                    clip_de_archivo(B / 'footage' / f'{peli}.mp4', p['ini'], d, sp)
                    sub.append(sp)
                    cubierto += d
                    k += 1
                if not sub:
                    continue
                if len(sub) == 1:
                    sub[0].rename(trozo)
                else:
                    lt = SEG / f'.{i:02d}-{j:02d}-l.txt'
                    lt.write_text(''.join(f"file '{q.name}'\n" for q in sub))
                    subprocess.run(
                        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
                         '-safe', '0', '-i', str(lt), '-c', 'copy', str(trozo)],
                        check=True, capture_output=True)
                    for q in [*sub, lt]:
                        q.unlink(missing_ok=True)
                seg_archivo += cubierto
                na += len(sub)
            elif fotos and len(fotos_usadas) < len(fotos):
                # Foto NUEVA. Si ya se gastaron todas, cae al archivo de abajo.
                while cursor_foto % len(fotos) in fotos_usadas:
                    cursor_foto += 1
                idx = cursor_foto % len(fotos)
                fotos_usadas.add(idx)
                cursor_foto += 1
                clip_de_foto(fotos[idx], por_plano, trozo)
                seg_foto += por_plano
                nf += 1
            else:
                # Sin fotos nuevas: archivo antes que repetir. Se encadenan
                # planos hasta cubrir el hueco, igual que en la rama FILM.
                sub, cubierto, k = [], 0.0, 0
                while cubierto < por_plano - 0.05 and k < 12:
                    peli, p = siguiente_plano_archivo()
                    if p is None:
                        break
                    d = min(p['dur'], por_plano - cubierto)
                    if d < 0.5:
                        break
                    sp = SEG / f'.{i:02d}-{j:02d}-r{k:02d}.mp4'
                    clip_de_archivo(B / 'footage' / f'{peli}.mp4', p['ini'], d, sp)
                    sub.append(sp)
                    cubierto += d
                    k += 1
                if not sub:
                    continue
                if len(sub) == 1:
                    sub[0].rename(trozo)
                else:
                    lt = SEG / f'.{i:02d}-{j:02d}-rl.txt'
                    lt.write_text(''.join(f"file '{q.name}'\n" for q in sub))
                    subprocess.run(
                        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
                         '-safe', '0', '-i', str(lt), '-c', 'copy', str(trozo)],
                        check=True, capture_output=True)
                    for q in [*sub, lt]:
                        q.unlink(missing_ok=True)
                seg_archivo += cubierto
                na += len(sub)
            partes.append(trozo)

        # Los generados van al final de su sección, conformados al formato del
        # montaje: 1920x1080, 30 fps, GOP cerrado, para que el concat sea copia.
        for k, g in enumerate(gen):
            gp = SEG / f'.{i:02d}-gen{k}.mp4'
            vf = (f'scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,'
                  f'crop={W}:{H},fps={FPS},setsar=1,format=yuv420p')
            subprocess.run(
                ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                 '-i', g['fichero'], '-t', f"{g['duracionSegundos']:.3f}", '-vf', vf,
                 '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                 '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
                 '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an', str(gp)],
                check=True, capture_output=True)
            partes.append(gp)
            seg_ia += g['duracionSegundos']

        if not partes:
            continue

        lista_txt = SEG / f'.{i:02d}-lista.txt'
        lista_txt.write_text(''.join(f"file '{q.name}'\n" for q in partes))
        subprocess.run(
            ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
             '-safe', '0', '-i', str(lista_txt), '-c', 'copy', str(destino)],
            check=True, capture_output=True)
        for q in [*partes, lista_txt]:
            q.unlink(missing_ok=True)
        print(f'  ✓ {destino.name}  {na} archivo + {nf} foto'
              f'{f" + {len(gen)} IA" if gen else ""} · {dur:.0f}s')
        segmentos.append(destino)

    def concatenar(partes, destino):
        l = SEG / 'concat.txt'
        l.write_text(''.join(f"file '{p.name}'\n" for p in partes))
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat',
                        '-safe', '0', '-i', str(l), '-c', 'copy', str(destino)],
                       check=True, capture_output=True)
        return ffprobe_dur(destino)

    mudo = B / 'video-mudo.mp4'
    dv = concatenar(segmentos, mudo)
    falta = dur_audio - dv
    print(f'\n  vídeo {dv:.1f}s · audio {dur_audio:.1f}s · falta {falta:.2f}s')

    salida = B / f'{ep}.mp4'
    srt = B / 'narration.srt'
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(mudo),
           '-i', str(B / 'narration.wav')]
    if srt.exists():
        cmd += ['-i', str(srt)]
    cmd += ['-map', '0:v', '-map', '1:a']
    if srt.exists():
        cmd += ['-map', '2', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng']
    cmd += ['-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-movflags', '+faststart', '-shortest', str(salida)]
    subprocess.run(cmd, check=True, capture_output=True)

    d = ffprobe_dur(salida)
    total = seg_archivo + seg_foto + seg_ia
    print(f'\n  ▸ {salida}')
    print(f'    {int(d//60)}:{int(d%60):02d} · {salida.stat().st_size/1048576:.0f} MB')
    print(f'\n  MEZCLA REAL CONSEGUIDA')
    print(f'    metraje de archivo  {seg_archivo:6.0f}s  {seg_archivo/total*100:5.1f} %')
    print(f'    fotos con Ken Burns {seg_foto:6.0f}s  {seg_foto/total*100:5.1f} %')
    print(f'    vídeo IA            {seg_ia:6.0f}s  {seg_ia/total*100:5.1f} %\n')


if __name__ == '__main__':
    main()
