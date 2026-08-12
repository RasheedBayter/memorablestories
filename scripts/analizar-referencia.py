#!/usr/bin/env python3
"""
Convierte un vídeo ajeno al formato en el que escribimos NUESTROS guiones.

    python3 scripts/analizar-referencia.py <URL de YouTube | fichero local>
    python3 scripts/analizar-referencia.py referencia.mp4 --slug moonbound-1

QUÉ PROBLEMA RESUELVE

Un modelo de lenguaje no puede ver vídeo. Sí puede leer texto y mirar imágenes
fijas. Así que el vídeo de referencia se descompone en las dos cosas que sí se
pueden estudiar —la narración con marcas de tiempo y un fotograma por plano— y
se vuelven a juntar en un solo documento donde cada frase tiene AL LADO la
imagen que estaba en pantalla mientras se decía.

Eso es `guion-reconstruido.md`, y es el entregable principal. Tiene la misma
forma que nuestros `parte-*.md`: marcas `>>` con el plano, y debajo las frases.
Se lee en paralelo con las rejillas de contacto.

LO QUE DE VERDAD SE APRENDE MIRÁNDOLO

No es la duración media del plano. Es DÓNDE CAE EL CORTE respecto a la frase:
en la pausa entre dos frases, en el punto, en una coma, o a mitad de oración.
Un montaje se siente musical o torpe según eso, y es invisible en cualquier
métrica agregada. Por eso cada corte se clasifica y, cuando parte una frase por
la mitad, se marca con `‖` en el punto exacto del texto donde cambió la imagen.

Lo segundo que importa es cuántas frases aguanta un mismo plano: un plano que
sostiene cuatro frases está haciendo un trabajo distinto al que dura una.

POR QUÉ LA TRANSCRIPCIÓN LA HACE WHISPER Y NO YOUTUBE

Los subtítulos automáticos de YouTube NO llevan puntuación. Sin puntos no hay
frases, y sin frases no hay nada que casar con los cortes: el análisis entero
se apoya en saber dónde acaba una oración. `faster-whisper` puntúa y además da
marcas por palabra, que es lo que permite situar el corte dentro del texto.
Con `--subs-youtube` se usan los de YouTube si son subtítulos SUBIDOS por el
canal (esos sí van puntuados: son el guion real).

POR QUÉ LOS CORTES SE DETECTAN CON LOS DOS MÉTODOS A LA VEZ

Medido contra un vídeo de verdad de campo conocida, ffmpeg y PySceneDetect
fallan en direcciones opuestas: ffmpeg pilla cortes duros que PySceneDetect se
deja, y PySceneDetect pilla los fundidos a negro que ffmpeg no ve nunca porque
un fundido nunca supera el umbral en un solo fotograma. Se usa la unión de los
dos. Ver `docs/ANALISIS-REFERENCIAS.md` para las cifras.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import unicodedata

RAIZ = pathlib.Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "referencias"

# Un fundido dura ~0,5 s; dos detecciones más juntas que esto son el mismo corte.
FUSION_CORTES = 0.35
# Márgenes para no sacar el fotograma representativo dentro de un fundido.
POSICION_FOTOGRAMA = 0.45      # fracción del plano donde se muestrea
ANCHO_FOTOGRAMA = 640
# Un corte a menos de esto del final de la frase se considera "en el punto".
CERCA_DEL_PUNTO = 0.30
# Marca del corte dentro del texto. Es la notación de docs/GRAMATICA-NARRATIVA.md,
# que es quien lee este guion después.
MARCA = "|"
# Tramo sin voz que ya cuenta como respiro (lo pide la lectura 4 de esa guía).
RESPIRO = 0.8


# ─────────────────────────────────────────────────────────────── utilidades ──

def log(msg: str) -> None:
    print(msg, flush=True)


def tc(segundos: float) -> str:
    """Marca de tiempo legible: MM:SS o H:MM:SS."""
    s = max(0, int(round(segundos)))
    h, resto = divmod(s, 3600)
    m, s = divmod(resto, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def tcd(segundos: float) -> str:
    """Como tc(), pero con décima: la guía de lectura ancla las frases así."""
    s = max(0.0, segundos)
    m, resto = divmod(s, 60)
    return f"{int(m):02d}:{resto:04.1f}"


def num(x: float, dec: int = 1) -> str:
    """Número con coma decimal, que es como escribimos."""
    return f"{x:.{dec}f}".replace(".", ",")


def slugify(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    t = re.sub(r"[^\w\s-]", "", t).strip().lower()
    t = re.sub(r"[\s_-]+", "-", t)
    return t[:60].strip("-") or "referencia"


def corre(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def buscar_ytdlp():
    for c in ("/opt/homebrew/bin/yt-dlp", "yt-dlp",
              str(pathlib.Path.home() / "Library/Python/3.9/bin/yt-dlp")):
        p = shutil.which(c) or (c if pathlib.Path(c).exists() else None)
        if p:
            return p
    return None


def duracion(video: pathlib.Path) -> float:
    r = corre(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", str(video)])
    return float(r.stdout.strip())


# ────────────────────────────────────────────────────────────────── entrada ──

def titulo_remoto(entrada: str, ytdlp: str):
    """Título del vídeo SIN descargarlo.

    Se consulta antes para saber en qué carpeta va a vivir todo. Si no, habría
    que descargar primero y renombrar después, y cada nueva ejecución volvería
    a bajar el vídeo por no saber que ya estaba.
    """
    r = corre([ytdlp, "--skip-download", "--no-warnings",
               "--print", "%(title)s", entrada])
    t = r.stdout.strip().splitlines()
    return t[0] if r.returncode == 0 and t else None


def obtener_fuente(entrada: str, destino: pathlib.Path, subs_youtube: bool):
    """Devuelve (ruta del vídeo, metadatos). Descarga si es una URL."""
    p = pathlib.Path(entrada).expanduser()
    if p.exists():
        log(f"  fuente local: {p.name}")
        return p, {"title": p.stem, "webpage_url": str(p),
                   "channel": "(fichero local)"}

    destino.mkdir(parents=True, exist_ok=True)
    ytdlp = buscar_ytdlp()

    def videos():
        return [f for f in sorted(destino.glob("fuente.*"))
                if f.suffix not in (".json", ".json3", ".vtt", ".part")]

    ya = videos()
    if ya:
        log(f"  ya descargado: {ya[0].name}")
    else:
        log("  descargando con yt-dlp…")
        cmd = [ytdlp, "-f", "bv*[height<=720]+ba/b[height<=720]",
               "--write-info-json", "--no-progress",
               "-o", str(destino / "fuente.%(ext)s"), entrada]
        if subs_youtube:
            cmd[1:1] = ["--write-subs", "--write-auto-subs",
                        "--sub-langs", "en.*,es.*", "--sub-format", "json3"]
        r = corre(cmd)
        if r.returncode != 0:
            sys.exit(f"yt-dlp falló:\n{r.stderr[-2000:]}")
        ya = videos()
        if not ya:
            sys.exit("yt-dlp terminó pero no dejó ningún vídeo.")

    meta = {}
    meta_f = destino / "fuente.info.json"
    if meta_f.exists():
        m = json.loads(meta_f.read_text())
        meta = {k: m.get(k) for k in
                ("title", "channel", "uploader", "duration", "upload_date",
                 "webpage_url", "license", "id")}
    return ya[0], meta


# ────────────────────────────────────────────────────────── transcripción ──

def transcribir(video: pathlib.Path, modelo: str, idioma):
    """Palabras con marca de tiempo, vía faster-whisper."""
    from faster_whisper import WhisperModel

    log(f"  transcribiendo con faster-whisper ({modelo})…")
    m = WhisperModel(modelo, device="cpu", compute_type="int8")
    segmentos, info = m.transcribe(
        str(video), language=idioma, word_timestamps=True,
        vad_filter=True, beam_size=5,
    )
    palabras, brutos = [], []
    for s in segmentos:
        brutos.append({"ini": s.start, "fin": s.end, "texto": s.text.strip()})
        for w in (s.words or []):
            palabras.append({"ini": w.start, "fin": w.end, "palabra": w.word})
    log(f"    {len(palabras)} palabras · idioma {info.language} "
        f"(confianza {info.language_probability:.2f})")
    return palabras, brutos, info.language


def subs_de_youtube(destino: pathlib.Path):
    """Lee los .json3 que dejó yt-dlp. Solo sirven si están puntuados."""
    ficheros = sorted(destino.glob("fuente*.json3"))
    if not ficheros:
        return None
    d = json.loads(ficheros[0].read_text())
    palabras = []
    for e in d.get("events", []):
        if "segs" not in e:
            continue
        base = e.get("tStartMs", 0) / 1000
        for s in e["segs"]:
            t = s.get("utf8", "")
            if not t.strip():
                continue
            ini = base + s.get("tOffsetMs", 0) / 1000
            palabras.append({"ini": ini, "fin": ini + 0.3, "palabra": " " + t.strip()})
    if not palabras:
        return None
    texto = "".join(p["palabra"] for p in palabras)
    if not re.search(r"[.!?]", texto):
        log("    los subtítulos de YouTube no llevan puntuación: se descartan")
        return None
    log(f"    {len(palabras)} palabras desde los subtítulos de YouTube")
    return palabras


def construir_frases(palabras, brutos):
    """Agrupa palabras en oraciones cortando por puntuación terminal."""
    frases, actual = [], []

    def cerrar(ws):
        return {
            "ini": ws[0]["ini"], "fin": ws[-1]["fin"],
            "texto": "".join(w["palabra"] for w in ws).strip(),
            "palabras": ws,
        }

    for w in palabras:
        actual.append(w)
        if re.search(r"[.!?…]['\"»)\]]?\s*$", w["palabra"]):
            frases.append(cerrar(actual))
            actual = []
    if actual:
        frases.append(cerrar(actual))

    # Si el modelo no puntuó nada, cae sobre los segmentos crudos de whisper.
    if len(frases) <= 1 and len(brutos) > 1:
        log("    sin puntuación terminal: se usan los segmentos de whisper")
        frases = []
        for b in brutos:
            ws = [w for w in palabras if b["ini"] - 0.01 <= w["ini"] <= b["fin"] + 0.01]
            if ws:
                frases.append(cerrar(ws))
    return frases


# ──────────────────────────────────────────────────────── detección de planos ──

def cortes_ffmpeg(video: pathlib.Path, umbral: float):
    r = corre(["ffmpeg", "-i", str(video), "-filter_complex",
               f"select='gt(scene,{umbral})',metadata=print:file=-",
               "-an", "-f", "null", "-"])
    t = [float(m) for m in re.findall(r"pts_time:([\d.]+)", r.stdout)]
    # ffmpeg siempre emite el fotograma 0; no es un corte.
    return [x for x in t if x > 0.05]


def cortes_pyscenedetect(video: pathlib.Path, umbral: float = 27.0):
    from scenedetect import detect, ContentDetector
    esc = detect(str(video), ContentDetector(threshold=umbral))
    return [s[0].get_seconds() for s in esc[1:]]


def detectar_planos(video: pathlib.Path, dur: float, umbral_ff: float, v=None):
    """Unión de los tres detectores.

    Cada uno ve lo que a los otros se les escapa: ffmpeg los cortes duros,
    PySceneDetect los fundidos a negro, y el tercero los encadenados.
    """
    log("  detectando cortes (ffmpeg + PySceneDetect + encadenados)…")
    a = cortes_ffmpeg(video, umbral_ff)
    b = cortes_pyscenedetect(video)
    c = detectar_encadenados(v)
    # Los encadenados solo aportan donde los otros no llegaron.
    c = [t for t in c if not any(abs(t - x) < 1.0 for x in a + b)]
    log(f"    ffmpeg {len(a)} · PySceneDetect {len(b)} · encadenados {len(c)} nuevos")

    todos = sorted(a + b + c)
    fusionados, origen = [], []
    for t in todos:
        if fusionados and t - fusionados[-1] < FUSION_CORTES:
            continue
        fusionados.append(t)
        en_a = any(abs(t - x) < FUSION_CORTES for x in a)
        en_b = any(abs(t - x) < FUSION_CORTES for x in b)
        if en_a and en_b:
            origen.append("ambos")
        elif en_a:
            origen.append("ffmpeg")
        elif en_b:
            origen.append("fundido")
        else:
            origen.append("encadenado")
    log(f"    unión: {len(fusionados)} cortes")

    planos, bordes = [], [0.0] + fusionados + [dur]
    for i, (x, y) in enumerate(zip(bordes, bordes[1:])):
        if y - x < 0.12:            # descarta restos de fusión
            continue
        planos.append({
            "n": len(planos) + 1, "ini": x, "fin": y, "dur": y - x,
            "origen": origen[i - 1] if 0 < i <= len(origen) else "inicio",
        })
    return planos


def extraer_fotogramas(video: pathlib.Path, planos, carpeta: pathlib.Path):
    """Un fotograma representativo por plano, no uno cada N segundos."""
    carpeta.mkdir(parents=True, exist_ok=True)
    log(f"  extrayendo {len(planos)} fotogramas (uno por plano)…")
    for p in planos:
        t = p["ini"] + p["dur"] * POSICION_FOTOGRAMA
        f = carpeta / f"plano-{p['n']:03d}.jpg"
        corre(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.3f}",
               "-i", str(video), "-frames:v", "1",
               "-vf", f"scale={ANCHO_FOTOGRAMA}:-2", "-q:v", "3", str(f)])
        p["fotograma"] = f"frames/{f.name}"
        p["t_fotograma"] = t
    return planos


# ─────────────────────────────────────────────────────────────────── cruce ──

GRIS_FPS, GRIS_AN, GRIS_AL = 4, 160, 90


def decodificar_gris(video: pathlib.Path):
    """El vídeo entero a 4 fps, 160×90 y en gris, en memoria.

    Una sola pasada de decodificación que sirve para dos cosas: buscar
    encadenados y medir el movimiento de cada plano. Hacerlo plano a plano
    serían cientos de llamadas a ffmpeg.
    """
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-an",
                        "-vf", f"fps={GRIS_FPS},scale={GRIS_AN}:{GRIS_AL},format=gray",
                        "-f", "rawvideo", "-"], capture_output=True)
    n = len(r.stdout) // (GRIS_AN * GRIS_AL)
    if n < 2:
        return None
    return np.frombuffer(r.stdout[:n * GRIS_AN * GRIS_AL],
                         dtype=np.uint8).reshape(n, GRIS_AL, GRIS_AN).astype(np.float32)


def detectar_encadenados(v, umbral_score: float = 3.85):
    """Encadenados: los cortes que NINGUNO de los otros dos detectores ve.

    Un encadenado reparte el cambio entre uno o dos segundos, así que ningún
    fotograma se separa lo bastante del anterior. En *Survival Under Atomic
    Attack* eso metía los tres rótulos de cabecera dentro de un mismo «plano»
    de 16 s.

    La prueba es la definición del efecto: en un encadenado lineal el fotograma
    del centro es LA MEDIA de los dos extremos. En una panorámica no —promediar
    dos encuadres desplazados da un fantasma, no el fotograma intermedio—.

    El umbral es deliberadamente alto. Sobre 14 candidatos verificados a mano,
    los encadenados de verdad puntuaban 3,9 · 4,6 · 4,9 · 11,7 y los falsos se
    quedaban todos por debajo de 3,7: eran planos con movimiento suave y amplio
    (una seta nuclear creciendo, alguien moviéndose) que también cumplen «el
    centro es la media». 3,85 cae en ese hueco.

    Ojo: está calibrado sobre 14 casos de UNA película. El hueco entre 3,7 y
    3,9 es estrecho, así que en otro material puede colarse algún falso. Se ha
    preferido pecar de conservador: un encadenado suave que se escapa deja dos
    planos pegados —molesto pero visible al mirar los contactos—, mientras que
    un falso positivo parte un plano en dos y se lee como un corte que nunca
    existió. Cada corte lleva en `planos.csv` quién lo vio.
    """
    import numpy as np
    if v is None:
        return []
    n, K = len(v), 3
    cand = []
    for i in range(K, n - K):
        a, b = v[i - K], v[i + K]
        extremos = float(np.abs(b - a).mean())
        if extremos < 12:
            continue
        err = float(np.abs(v[i] - (a + b) / 2).mean())
        s = extremos / (err + 1e-6)
        if s > umbral_score:
            cand.append((i / GRIS_FPS, s))
    picos, g = [], []
    for x in cand:
        if g and x[0] - g[-1][0] <= 0.75:
            g.append(x)
        else:
            if g:
                picos.append(max(g, key=lambda y: y[1]))
            g = [x]
    if g:
        picos.append(max(g, key=lambda y: y[1]))
    return [t for t, _ in picos]


def analizar_movimiento(v, planos):
    """¿El plano está quieto, se mueve la cámara, o se mueve lo de dentro?

    `docs/GRAMATICA-NARRATIVA.md` lo pide para cada imagen, y cambia la lectura:
    una foto fija sosteniendo una cifra no es lo mismo que un travelling.
    Si cambia MUCHA superficie a la vez, se mueve la cámara; si cambia poca pero
    fuerte, se mueve algo dentro del cuadro.
    """
    import numpy as np
    log("  midiendo movimiento de cada plano…")
    if v is None:
        for p in planos:
            p["movimiento"] = "?"
        return
    FPS, n = GRIS_FPS, len(v)

    medidos = {}
    for p in planos:
        a = int(p["ini"] * FPS) + 1          # +1 esquiva el fotograma del corte
        b = min(int(p["fin"] * FPS), n - 1)
        if b - a < 1:
            continue
        d = np.abs(np.diff(v[a:b + 1], axis=0))
        medidos[p["n"]] = (float(d.mean()), float((d > 16).mean()))

    if not medidos:
        for p in planos:
            p["movimiento"] = "?"
        return

    # Un umbral absoluto no vale para materiales distintos: el grano de una
    # película de 1951 ya da de suelo más diferencia que el plano MEDIO de un
    # vídeo moderno limpio, y entonces nada sale nunca «fijo». El suelo de ruido
    # se estima con los planos más quietos del propio vídeo y todo se mide
    # contra él.
    ms = np.array([m for m, _ in medidos.values()])
    fs = np.array([f for _, f in medidos.values()])
    suelo_m = float(np.percentile(ms, 10))
    suelo_f = float(np.percentile(fs, 10))
    lim_fijo = suelo_m * 1.7 + 0.3
    lim_camara = max(0.30, suelo_f * 3)

    for p in planos:
        if p["n"] not in medidos:
            p["movimiento"] = "fijo"
            continue
        medio, frac = medidos[p["n"]]
        if medio < lim_fijo:
            p["movimiento"] = "fijo"
        elif frac > lim_camara:
            p["movimiento"] = "con movimiento"
        else:
            p["movimiento"] = "movimiento interno"


def tramos_sin_voz(frases, planos, dur: float):
    """Cada respiro de más de 0,8 s y qué imagen lo ocupa."""
    huecos, t = [], 0.0
    for f in sorted(frases, key=lambda x: x["ini"]):
        if f["ini"] - t >= RESPIRO:
            huecos.append((t, f["ini"]))
        t = max(t, f["fin"])
    if dur - t >= RESPIRO:
        huecos.append((t, dur))
    salida = []
    for a, b in huecos:
        dentro = [p["n"] for p in planos if p["ini"] < b and p["fin"] > a]
        salida.append({"ini": a, "fin": b, "dur": b - a, "planos": dentro})
    return salida


def plano_en(planos, t):
    for p in planos:
        if p["ini"] <= t < p["fin"]:
            return p
    return planos[-1] if planos else None


def clasificar_corte(t, frases):
    """Dónde cae este corte respecto al texto. El dato que más importa."""
    for i, f in enumerate(frases):
        if f["ini"] <= t <= f["fin"]:
            if f["fin"] - t <= CERCA_DEL_PUNTO:
                return {"tipo": "en el punto", "frase": i, "palabra": None}
            # ¿justo detrás de una coma o pausa interna?
            for w in f["palabras"]:
                if w["fin"] <= t and re.search(r"[,;:—–]\s*$", w["palabra"]):
                    if t - w["fin"] <= CERCA_DEL_PUNTO:
                        return {"tipo": "en la coma", "frase": i,
                                "palabra": w["palabra"].strip()}
            # Igual que al marcar el texto: no señalar la cola de una palabra
            # partida por guion, que se lee como «-setting».
            post = [w for w in f["palabras"] if w["ini"] >= t
                    and not w["palabra"].strip().startswith("-")]
            return {"tipo": "a mitad de frase", "frase": i,
                    "palabra": post[0]["palabra"].strip() if post else None}
    # No cae dentro de ninguna frase: está en el hueco entre dos.
    prev = [f for f in frases if f["fin"] <= t]
    sig = [f for f in frases if f["ini"] >= t]
    hueco = (sig[0]["ini"] - prev[-1]["fin"]) if prev and sig else None
    return {"tipo": "en pausa", "frase": len(prev) - 1 if prev else -1,
            "palabra": None, "hueco": hueco}


def cruzar(frases, planos):
    """Cada frase con su plano, y cada corte con su sitio en el texto."""
    for f in frases:
        medio = (f["ini"] + f["fin"]) / 2
        p = plano_en(planos, medio)
        f["plano"] = p["n"] if p else None
        f["parte_plano"] = [q["n"] for q in planos
                            if q["ini"] < f["fin"] and q["fin"] > f["ini"]]

    for p in planos:
        p["frases"] = [i for i, f in enumerate(frases) if f["plano"] == p["n"]]
        p["corte"] = clasificar_corte(p["ini"], frases) if p["n"] > 1 else None
    return frases, planos


def texto_con_corte(frase, planos):
    """Inserta ‖ donde la imagen cambió a mitad de la frase.

    Solo se marcan los cortes de verdad interiores. Un corte pegado al punto
    final ya se describe como «en el punto» en la cabecera del plano; marcarlo
    además dentro del texto dejaba un ‖ colgando al final de la frase.
    """
    cortes = [p["ini"] for p in planos
              if p["n"] > 1
              and frase["ini"] + 0.15 < p["ini"] < frase["fin"] - CERCA_DEL_PUNTO]
    if not cortes:
        return frase["texto"]

    ws = frase["palabras"]
    posiciones = set()          # un conjunto: dos cortes seguidos no dan «‖ ‖»
    for c in cortes:
        i = 0
        while i < len(ws) and ws[i]["ini"] < c:
            i += 1
        # whisper parte «record-setting» en «record» + «-setting»; meter la
        # marca en medio deja un ‖-setting que no se puede leer.
        while 0 < i < len(ws) and ws[i]["palabra"].strip().startswith("-"):
            i += 1
        if 0 < i < len(ws):
            posiciones.add(i)

    salida = ""
    for i, w in enumerate(ws):
        if i in posiciones:
            salida += " " + MARCA
        salida += w["palabra"]
    return salida.strip()


# ──────────────────────────────────────────────────────────────────── OCR ──

def ocr_fotogramas(planos, carpeta: pathlib.Path, activo: bool):
    """Rótulos en pantalla.

    Sobre metraje granulado el OCR en crudo devuelve basura: un fotograma de
    1951 daba «oro 1s Sess elastin oa ee cle». Con la imagen en gris, al doble
    de tamaño y con el contraste estirado, el mismo rótulo pasa a leerse. Aun
    así se descarta todo lo que no venga con confianza alta y varias palabras,
    porque un rótulo inventado es peor que ningún rótulo.
    """
    if not activo:
        return {}
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError:
        log("    pytesseract no disponible: se omite el OCR")
        return {}
    log("  leyendo texto en pantalla (tesseract)…")
    rotulos = {}
    for p in planos:
        f = carpeta / pathlib.Path(p["fotograma"]).name
        if not f.exists():
            continue
        try:
            im = Image.open(f).convert("L")
            im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
            im = ImageOps.autocontrast(im, cutoff=2)
            d = pytesseract.image_to_data(im, config="--psm 6",
                                          output_type=pytesseract.Output.DICT)
        except Exception:
            continue
        ws = [(t.strip(), int(c)) for t, c in zip(d["text"], d["conf"])
              if t.strip() and int(c) >= 60 and len(t.strip()) >= 2]
        if len(ws) < 2:
            continue
        conf = sum(c for _, c in ws) / len(ws)
        txt = " ".join(t for t, _ in ws)
        txt = re.sub(r"[^\w\s.,:%€$&/'-]", "", txt).strip()
        if conf >= 70 and len(txt) >= 8:
            rotulos[p["n"]] = txt[:120]
    log(f"    rótulos legibles en {len(rotulos)} de {len(planos)} planos")
    return rotulos


# ────────────────────────────────────────────────────────────────── audio ──

def analizar_audio(video: pathlib.Path, frases, dur: float):
    """Voz / música / silencio, bin a bin.

    La voz no se adivina: se sabe por las marcas de whisper. Lo que queda se
    separa por energía: con nivel es música o ambiente, sin nivel es silencio.
    """
    import numpy as np
    log("  analizando audio…")
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-ac", "1",
                        "-ar", "16000", "-f", "s16le", "-"],
                       capture_output=True)
    if not r.stdout:
        return None
    x = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    sr, paso = 16000, 0.5
    n = int(sr * paso)
    bins = [x[i:i + n] for i in range(0, len(x) - n + 1, n)]
    rms = np.array([float(np.sqrt(np.mean(b ** 2)) + 1e-9) for b in bins])
    db = 20 * np.log10(rms)

    suelo = float(np.percentile(db, 5))
    umbral_silencio = suelo + 6.0

    habla = [(f["ini"], f["fin"]) for f in frases]

    def con_voz(t0, t1):
        return any(a < t1 and b > t0 for a, b in habla)

    clases = []
    for i in range(len(bins)):
        t0, t1 = i * paso, (i + 1) * paso
        if con_voz(t0, t1):
            clases.append("voz")
        elif db[i] < umbral_silencio:
            clases.append("silencio")
        else:
            clases.append("música")

    total = len(clases) * paso
    cuenta = {c: clases.count(c) * paso for c in ("voz", "música", "silencio")}

    tramos, ini = [], 0
    for i in range(1, len(clases) + 1):
        if i == len(clases) or clases[i] != clases[ini]:
            tramos.append((clases[ini], ini * paso, i * paso))
            ini = i
    return {"total": total, "cuenta": cuenta, "tramos": tramos,
            "db_medio": float(np.mean(db)), "suelo": suelo,
            "pico": float(np.max(db))}


# ───────────────────────────────────────────────────────────────── informes ──

def escribir_guion(dest, meta, frases, planos, rotulos, dur):
    """EL ENTREGABLE. Cada frase con la imagen que sonaba debajo."""
    L = []
    tit = meta.get("title") or dest.name
    L.append(f"# {tit} — guion reconstruido")
    L.append("")
    canal = meta.get("channel") or meta.get("uploader") or "—"
    L.append(f"**Referencia · {canal} · {tc(dur)} · "
             f"{len(planos)} planos · {len(frases)} frases**")
    L.append("")
    if meta.get("webpage_url"):
        L.append(f"Fuente: {meta['webpage_url']}")
        L.append("")
    L.append("Reconstruido automáticamente con `scripts/analizar-referencia.py`. "
             "Cada marca `>>` es un plano detectado y su fotograma; debajo van las "
             "frases que suenan mientras ese plano está en pantalla.")
    L.append("")
    L.append(f"Anotado según `docs/GRAMATICA-NARRATIVA.md`: `[mm:ss.d]` abre cada "
             f"frase, `{MARCA}` dentro del texto marca dónde cambió la imagen, y "
             "cada plano lleva si está **fijo**, **con movimiento** (se mueve la "
             "cámara) o con **movimiento interno** (se mueve lo de dentro). "
             "La nota bajo cada marca dice cómo entró el corte respecto al texto.")
    L.append("")
    L.append("---")
    L.append("")

    for p in planos:
        nf = len(p["frases"])
        cab = (f">> {p['fotograma']} — [{tc(p['ini'])} – {tc(p['fin'])}] · "
               f"{num(p['dur'])} s · {p.get('movimiento', '?')} · "
               f"{nf} {'frase' if nf == 1 else 'frases'}")
        if p["n"] in rotulos:
            cab += f" · rótulo: «{rotulos[p['n']]}»"
        L.append(cab)
        c = p.get("corte")
        if c:
            # Si la frase que parte el corte se imprime bajo OTRO plano, hay que
            # decirlo: si no, el lector busca aquí una frase que está más arriba.
            ajena = (0 <= c.get("frase", -1) < len(frases)
                     and frases[c["frase"]]["plano"] != p["n"])
            donde = "la frase anterior" if ajena else "frase"
            if c["tipo"] == "en pausa":
                h = c.get("hueco")
                extra = f" ({num(h, 2)} s de silencio)" if h else ""
                L.append(f"   corte en pausa{extra}")
            elif c["tipo"] == "a mitad de frase" and c["palabra"]:
                L.append(f"   corte a mitad de {donde}, justo antes de "
                         f"«{c['palabra']}»")
            elif c["tipo"] == "en la coma" and c["palabra"]:
                L.append(f"   corte en la coma, tras «{c['palabra']}»")
            else:
                L.append(f"   corte {c['tipo']}")
        L.append("")
        if not p["frases"]:
            # Puede no tener frase propia y aun así llevar voz encima: la frase
            # empezó antes y sigue sonando. Decir «sin narración» sería falso.
            solapan = [f for f in frases
                       if f["ini"] < p["fin"] and f["fin"] > p["ini"]]
            if solapan:
                f0 = solapan[0]
                verbo = "empieza aquí" if f0["ini"] >= p["ini"] else "sigue sonando"
                L.append(f"*({verbo} la frase del plano {f0['plano']})*")
            else:
                L.append("*(sin narración: solo imagen)*")
            L.append("")
        for i in p["frases"]:
            f = frases[i]
            L.append(f"[{tcd(f['ini'])}] {texto_con_corte(f, planos)}")
            L.append("")

    respiros = tramos_sin_voz(frases, planos, dur)
    if respiros:
        L.append("---")
        L.append("")
        L.append(f"## Respiros: tramos de más de {num(RESPIRO)} s sin voz")
        L.append("")
        L.append("Qué imagen sostiene el silencio es media lectura del montaje.")
        L.append("")
        L.append("| desde | hasta | dura | planos encima |")
        L.append("|---|---|---:|---|")
        for h in respiros:
            ps = ", ".join(str(x) for x in h["planos"][:6])
            L.append(f"| {tcd(h['ini'])} | {tcd(h['fin'])} | {num(h['dur'])} s | {ps} |")
        L.append("")

    (dest / "guion-reconstruido.md").write_text("\n".join(L))


def escribir_ritmo(dest, planos, frases, dur):
    ds = [p["dur"] for p in planos]
    L = ["# Ritmo de montaje", ""]
    L.append(f"- Planos: **{len(planos)}** en {tc(dur)}")
    L.append(f"- Cortes por minuto: **{num(len(planos) / (dur / 60))}**")
    L.append(f"- Duración media: **{num(statistics.mean(ds))} s**")
    L.append(f"- Mediana: **{num(statistics.median(ds))} s**")
    if len(ds) > 1:
        L.append(f"- Desviación típica: {num(statistics.stdev(ds))} s")
    L.append(f"- Más corto: {num(min(ds))} s · más largo: {num(max(ds))} s")
    L.append("")

    L.append("## Distribución")
    L.append("")
    tramos = [(0, 1), (1, 2), (2, 3), (3, 5), (5, 8), (8, 15), (15, 1e9)]
    L.append("| duración | planos | |")
    L.append("|---|---:|---|")
    for a, b in tramos:
        c = sum(1 for d in ds if a <= d < b)
        et = f"{a}–{b} s" if b < 1e9 else f"> {a} s"
        L.append(f"| {et} | {c} | {'█' * int(30 * c / len(ds))} |")
    L.append("")

    L.append("## Cómo varía a lo largo del vídeo")
    L.append("")
    N = min(6, max(2, len(planos) // 8))
    L.append("| bloque | planos | mediana | cortes/min |")
    L.append("|---|---:|---:|---:|")
    for k in range(N):
        a, b = dur * k / N, dur * (k + 1) / N
        gr = [p for p in planos if a <= p["ini"] < b]
        if not gr:
            continue
        md = statistics.median([p["dur"] for p in gr])
        L.append(f"| {tc(a)}–{tc(b)} | {len(gr)} | {num(md)} s | "
                 f"{num(len(gr) / ((b - a) / 60))} |")
    L.append("")

    # Lo que de verdad importa, también en cifras.
    tipos = {}
    for p in planos:
        if p.get("corte"):
            tipos[p["corte"]["tipo"]] = tipos.get(p["corte"]["tipo"], 0) + 1
    tot = sum(tipos.values()) or 1
    L.append("## Dónde caen los cortes respecto a la narración")
    L.append("")
    L.append("| posición | cortes | % |")
    L.append("|---|---:|---:|")
    for t, c in sorted(tipos.items(), key=lambda x: -x[1]):
        L.append(f"| {t} | {c} | {num(100 * c / tot)} % |")
    L.append("")

    nf = [len(p["frases"]) for p in planos]
    L.append(f"- Frases por plano: media **{num(statistics.mean(nf))}**, "
             f"máximo {max(nf)}")
    L.append(f"- Planos sin narración: {sum(1 for x in nf if x == 0)}")
    L.append("")
    (dest / "ritmo.md").write_text("\n".join(L))


def escribir_audio(dest, aud):
    if not aud:
        return
    L = ["# Audio", ""]
    t = aud["total"]
    L.append("| capa | tiempo | % |")
    L.append("|---|---:|---:|")
    for k in ("voz", "música", "silencio"):
        v = aud["cuenta"][k]
        L.append(f"| {k} | {num(v)} s | {num(100 * v / t)} % |")
    L.append("")
    L.append(f"- Nivel medio {num(aud['db_medio'])} dBFS · "
             f"pico {num(aud['pico'])} dBFS · suelo {num(aud['suelo'])} dBFS")
    L.append("")
    L.append("La voz sale de las marcas de whisper, no de un umbral de energía. "
             "Lo que no es voz se separa por nivel: con energía es música o "
             "ambiente, sin energía es silencio.")
    L.append("")
    largos = sorted([x for x in aud["tramos"] if x[0] == "silencio"],
                    key=lambda x: x[2] - x[1], reverse=True)[:8]
    if largos:
        L.append("## Silencios más largos")
        L.append("")
        for _, a, b in largos:
            L.append(f"- {tc(a)} → {tc(b)} ({num(b - a)} s)")
        L.append("")
    (dest / "audio.md").write_text("\n".join(L))


def escribir_planos_csv(dest, planos, frases):
    with open(dest / "planos.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["n", "inicio_s", "fin_s", "duracion_s", "inicio_tc",
                    "fotograma", "movimiento", "n_frases", "corte",
                    "detectado_por"])
        for p in planos:
            w.writerow([p["n"], f"{p['ini']:.3f}", f"{p['fin']:.3f}",
                        f"{p['dur']:.3f}", tc(p["ini"]), p.get("fotograma", ""),
                        p.get("movimiento", ""), len(p["frases"]),
                        (p["corte"] or {}).get("tipo", ""), p["origen"]])


def escribir_transcripcion(dest, frases):
    (dest / "transcripcion.txt").write_text(
        "\n".join(f"[{tc(f['ini'])}] {f['texto']}" for f in frases))
    (dest / "transcripcion.json").write_text(json.dumps([
        {"ini": round(f["ini"], 3), "fin": round(f["fin"], 3),
         "texto": f["texto"], "plano": f["plano"]} for f in frases
    ], ensure_ascii=False, indent=1))


def contactos(dest, planos, carpeta, por_hoja=20, cols=4):
    """Rejillas EN ORDEN y numeradas, para mirarlas leyendo el guion al lado."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        fuente = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 15)
    except OSError:
        fuente = ImageFont.load_default()

    hojas = 0
    for k in range(0, len(planos), por_hoja):
        grupo = planos[k:k + por_hoja]
        ims = []
        for p in grupo:
            f = carpeta / pathlib.Path(p["fotograma"]).name
            if not f.exists():
                continue
            im = Image.open(f).convert("RGB")
            im.thumbnail((320, 240))
            lienzo = Image.new("RGB", (320, 240), (16, 16, 16))
            lienzo.paste(im, ((320 - im.width) // 2, (240 - im.height) // 2))
            d = ImageDraw.Draw(lienzo)
            etq = f"{p['n']:03d}  {tc(p['ini'])}  {num(p['dur'])}s"
            d.rectangle([0, 0, 8 + 9 * len(etq), 21], fill=(0, 0, 0))
            d.text((5, 3), etq, fill=(255, 220, 0), font=fuente)
            ims.append(lienzo)
        if not ims:
            continue
        filas = (len(ims) + cols - 1) // cols
        hoja = Image.new("RGB", (cols * 324 + 4, filas * 244 + 4), (28, 28, 28))
        for i, im in enumerate(ims):
            hoja.paste(im, (4 + (i % cols) * 324, 4 + (i // cols) * 244))
        hojas += 1
        hoja.save(dest / f"contactos-{hojas:02d}.jpg", quality=86)
    return hojas


def escribir_informe(dest, meta, planos, frases, aud, dur, rotulos, hojas, idioma):
    ds = [p["dur"] for p in planos]
    tipos = {}
    for p in planos:
        if p.get("corte"):
            tipos[p["corte"]["tipo"]] = tipos.get(p["corte"]["tipo"], 0) + 1
    tot = sum(tipos.values()) or 1

    L = [f"# {meta.get('title') or dest.name}", ""]
    L.append(f"**{meta.get('channel') or meta.get('uploader') or '—'} · "
             f"{tc(dur)} · idioma {idioma}**")
    if meta.get("webpage_url"):
        L.append("")
        L.append(f"Fuente: {meta['webpage_url']}")
    L.append("")
    L.append("## Lo que hay que mirar")
    L.append("")
    L.append("1. **`guion-reconstruido.md`** — el vídeo en nuestro formato: cada "
             "frase con el fotograma que sonaba debajo. Es el documento principal.")
    L.append(f"2. **`contactos-NN.jpg`** ({hojas} hojas) — los planos en orden y "
             "numerados. Se miran leyendo el guion en paralelo.")
    L.append("3. `ritmo.md`, `audio.md`, `planos.csv` — las cifras, que son lo "
             "secundario.")
    L.append("")
    L.append("## De un vistazo")
    L.append("")
    L.append(f"- {len(planos)} planos · {len(frases)} frases · "
             f"{num(len(planos) / (dur / 60))} cortes/min")
    L.append(f"- Plano medio {num(statistics.mean(ds))} s "
             f"(mediana {num(statistics.median(ds))} s)")
    L.append(f"- Frases por plano: media "
             f"{num(statistics.mean([len(p['frases']) for p in planos]))}")
    if aud:
        c, t = aud["cuenta"], aud["total"]
        L.append(f"- Audio: {num(100 * c['voz'] / t)} % voz · "
                 f"{num(100 * c['música'] / t)} % música/ambiente · "
                 f"{num(100 * c['silencio'] / t)} % silencio")
    if rotulos:
        L.append(f"- Rótulos legibles en {len(rotulos)} planos")
    L.append("")
    L.append("## Dónde caen los cortes")
    L.append("")
    for t_, c in sorted(tipos.items(), key=lambda x: -x[1]):
        L.append(f"- **{t_}**: {c} ({num(100 * c / tot)} %)")
    L.append("")
    L.append("Un montaje que corta casi siempre en pausa o en el punto suena "
             "ordenado; uno que corta a mitad de frase empuja hacia delante. "
             "La proporción entre esas dos cosas es la firma de montaje del canal.")
    L.append("")
    (dest / "INFORME.md").write_text("\n".join(L))


# ─────────────────────────────────────────────────────────────────── main ──

def main():
    ap = argparse.ArgumentParser(
        description="Convierte un vídeo de referencia a nuestro formato de guion.")
    ap.add_argument("entrada", help="URL de YouTube o fichero de vídeo local")
    ap.add_argument("--slug", help="nombre de la carpeta en referencias/")
    ap.add_argument("--modelo", default="base.en",
                    help="modelo de faster-whisper (base.en por defecto)")
    ap.add_argument("--idioma", default=None, help="fuerza el idioma (en, es…)")
    ap.add_argument("--umbral", type=float, default=0.3,
                    help="umbral de escena de ffmpeg (0.3 por defecto)")
    ap.add_argument("--subs-youtube", action="store_true",
                    help="usa los subtítulos de YouTube si están puntuados")
    ap.add_argument("--sin-ocr", action="store_true", help="salta el OCR")
    args = ap.parse_args()

    local = pathlib.Path(args.entrada).expanduser().exists()
    # Un fichero mal escrito acababa yendo a yt-dlp, que respondía «is not a
    # valid URL» y mandaba a buscar el problema al sitio equivocado.
    if not local and not re.match(r"https?://", args.entrada):
        sys.exit(f"No existe el fichero «{args.entrada}», y no parece una URL.")

    if args.slug:
        slug = slugify(args.slug)
    elif local:
        slug = slugify(pathlib.Path(args.entrada).stem)
    else:
        ytdlp = buscar_ytdlp()
        if not ytdlp:
            sys.exit("No hay yt-dlp y la entrada no es un fichero. "
                     "Instálalo con `brew install yt-dlp`.")
        t = titulo_remoto(args.entrada, ytdlp)
        if not t:
            sys.exit("No se pudo leer el título del vídeo. "
                     "¿La URL es correcta? Puedes forzar la carpeta con --slug.")
        slug = slugify(t)

    dest = SALIDA / slug
    dest.mkdir(parents=True, exist_ok=True)
    video, meta = obtener_fuente(args.entrada, dest / "fuente", args.subs_youtube)
    log(f"→ {dest}")

    dur = duracion(video)

    palabras = subs_de_youtube(dest / "fuente") if args.subs_youtube else None
    brutos, idioma = [], args.idioma or "?"
    if not palabras:
        palabras, brutos, idioma = transcribir(video, args.modelo, args.idioma)
    frases = construir_frases(palabras, brutos)
    log(f"    {len(frases)} frases")

    gris = decodificar_gris(video)
    planos = detectar_planos(video, dur, args.umbral, gris)
    planos = extraer_fotogramas(video, planos, dest / "frames")
    analizar_movimiento(gris, planos)
    frases, planos = cruzar(frases, planos)

    rotulos = ocr_fotogramas(planos, dest / "frames", not args.sin_ocr)
    aud = analizar_audio(video, frases, dur)

    log("  escribiendo informes…")
    escribir_transcripcion(dest, frases)
    escribir_planos_csv(dest, planos, frases)
    escribir_guion(dest, meta, frases, planos, rotulos, dur)
    escribir_ritmo(dest, planos, frases, dur)
    escribir_audio(dest, aud)
    hojas = contactos(dest, planos, dest / "frames")
    escribir_informe(dest, meta, planos, frases, aud, dur, rotulos, hojas, idioma)

    log(f"\n✓ {dest}/guion-reconstruido.md")
    log(f"  {len(planos)} planos · {len(frases)} frases · "
        f"{hojas} {'hoja' if hojas == 1 else 'hojas'} de contactos")


if __name__ == "__main__":
    main()
