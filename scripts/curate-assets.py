#!/usr/bin/env python3
"""
Descarga los assets del episodio desde las imágenes de artículos de Wikipedia.

    python3 scripts/curate-assets.py

Tres intentos hicieron falta y los dos primeros enseñan algo:

1. `discoverAssets` (búsqueda de texto en Commons). De 59 assets aceptados, nueve
   eran láminas de "Lectures on Coal Tar Colours" y dos eran marineros de la US
   Navy fregando mamparos, de la pista visual "hands scrubbing". El retrato de
   "Johann Klein", jefe de Semmelweis, resultó ser Johann Adam Klein, pintor de
   Núremberg. La búsqueda encuentra palabras, no temas.

2. Categorías de Commons. Mejor curadas, pero demasiado amplias:
   `Category:Louis Pasteur` incluye el ayuntamiento de Melun y
   `Category:Rudolf Virchow` un busto en un parque de Manila. Una categoría
   agrupa todo lo RELACIONADO, no lo que ilustra un momento del guion.

3. Las imágenes del ARTÍCULO de Wikipedia. Un editor humano decidió que esa
   imagen ilustra ese tema, que es exactamente el juicio que hace falta.

Sobre resolución: NO hay umbral de descarte. Un retrato del XIX escaneado a
1.200 px es el único que existe, y tirarlo por no llegar a 2.500 deja el plano
sin imagen. La regla del umbral 2x no dice "descarta", dice cuánto puedes
ampliar: `maxSafeZoom` en `src/lib/assets/resolution.ts`. Aquí se anota el
tamaño real y el render decide el movimiento — imagen grande, Ken Burns; imagen
pequeña, plano fijo.
"""

import json
import pathlib
import re
import time
import urllib.parse
import urllib.error
import urllib.request

WIKI = 'https://en.wikipedia.org/w/api.php'
UA = 'MemorableStories/0.1 (documental histórico; contacto vía repositorio)'
DESTINO = pathlib.Path('scripts-out/01-semmelweis/assets')
PAUSA_S = 2.5
# Reintento con espera creciente. Wikimedia responde 429 y, una vez que te
# limita, seguir pidiendo al mismo ritmo mantiene el castigo indefinidamente: la
# única salida es esperar más en cada intento. Sin esto, una corrida perdió 33 de
# 36 planos y la siguiente 11 de 21.
REINTENTOS = 5
ESPERA_429 = [5, 15, 40, 90, 180]


def _con_reintento(fn, etiqueta: str):
    for intento in range(REINTENTOS):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            if e.code != 429 or intento == REINTENTOS - 1:
                raise
            espera = ESPERA_429[intento]
            print(f'      {etiqueta}: 429, espero {espera}s '
                  f'(intento {intento + 2}/{REINTENTOS})', flush=True)
            time.sleep(espera)
    raise RuntimeError('inalcanzable')

# (artículo de Wikipedia, cuántas imágenes coger, para qué sirven en el guion)
ARTICULOS: list[tuple[str, int, str]] = [
    ('Ignaz Semmelweis',              6, 'el protagonista, su libro, su tumba'),
    ('Puerperal fever',               4, 'la enfermedad'),
    ('Vienna General Hospital',       3, 'el hospital'),
    ('History of Vienna',             3, 'la ciudad'),
    ('Midwifery',                     3, 'las comadronas'),
    ('History of obstetrics',         3, 'obstetricia de época'),
    ('Bloodletting',                  3, 'sangría y purgas'),
    ('Miasma theory',                 3, 'la teoría del miasma'),
    ('Anatomical theatre',            3, 'la sala de autopsias'),
    ('Autopsy',                       2, 'la autopsia'),
    ('Carl Braun von Fernwald',       2, 'el opositor'),
    ('Ferdinand Ritter von Hebra',    2, 'quien publicó por él'),
    ('Josef Škoda',                   2, 'quien habló por él'),
    ('Rudolf Virchow',                2, 'el rechazo'),
    ('Louis Pasteur',                 4, 'la vindicación'),
    ('Robert Koch',                   3, 'bacteriología'),
    ('Streptococcus pyogenes',        2, 'el patógeno'),
    ('Optical microscope',            2, 'el microscopio'),
    ('Hand washing',                  3, 'el lavado, hoy'),
    ('Budapest',                      2, 'Budapest'),
    ('Lunatic asylum',                3, 'el manicomio'),
]

# Iconos de interfaz, banderas, logos y mapas de localización que Wikipedia
# incrusta en cada artículo. Sin este filtro, un tercio de lo descargado son
# escudos y flechas.
RUIDO = re.compile(
    r'(commons-logo|wikidata|wiktionary|edit-|ambox|question_book|'
    r'^flag_|_flag|coat_of_arms|location_map|locator|blue_pog|red_pog|'
    r'\.svg$|icon|symbol|barnstar|padlock|stub|disambig)', re.I)


def pedir(params: dict) -> dict:
    url = f'{WIKI}?{urllib.parse.urlencode({**params, "format": "json"})}'

    def _hacer():
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.load(r)

    d = _con_reintento(_hacer, 'api')
    time.sleep(PAUSA_S)
    return d


def imagenes_de(articulo: str) -> list[dict]:
    """Imágenes que un editor puso EN el artículo, con tamaño y licencia."""
    d = pedir({
        'action': 'query', 'titles': articulo,
        'generator': 'images', 'gimlimit': 40,
        'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata|mime',
    })
    out = []
    for p in (d.get('query', {}).get('pages') or {}).values():
        titulo = p.get('title', '').removeprefix('File:')
        if RUIDO.search(titulo):
            continue
        ii = (p.get('imageinfo') or [{}])[0]
        if not ii.get('url') or ii.get('mime') not in ('image/jpeg', 'image/png'):
            continue
        em = ii.get('extmetadata', {})
        out.append({
            'titulo': titulo,
            'url': ii['url'],
            'ancho': ii.get('width', 0),
            'alto': ii.get('height', 0),
            'px': ii.get('width', 0) * ii.get('height', 0),
            'licencia': (em.get('LicenseShortName', {}) or {}).get('value', '?'),
            'autor': re.sub(r'<[^>]+>', '', (em.get('Artist', {}) or {}).get('value', '') or '')[:80],
            'pagina': ii.get('descriptionurl', ''),
        })
    return sorted(out, key=lambda c: -c['px'])


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    catalogo, vistos = [], set()

    for articulo, cuantas, para in ARTICULOS:
        try:
            cands = imagenes_de(articulo)
        except Exception as e:                        # noqa: BLE001
            print(f'  ✗ {articulo[:34]:36} {e}')
            continue
        if not cands:
            print(f'  ✗ {articulo[:34]:36} sin imágenes utilizables')
            continue

        n = 0
        for c in cands:
            if n >= cuantas:
                break
            if c['titulo'] in vistos:
                continue
            vistos.add(c['titulo'])

            slug = re.sub(r'[^a-z0-9]+', '-', c['titulo'].lower())[:52].strip('-')
            ext = pathlib.Path(c['titulo']).suffix.lower() or '.jpg'
            ruta = DESTINO / f'{slug}{ext}'
            # Reanudable: una corrida interrumpida por 429 no vuelve a pagar
            # las descargas que sí salieron.
            if ruta.exists() and ruta.stat().st_size > 4096:
                catalogo.append({
                    'fichero': str(ruta), 'articulo': articulo, 'para': para,
                    'titulo': c['titulo'], 'ancho': c['ancho'], 'alto': c['alto'],
                    'licencia': c['licencia'], 'autor': c['autor'], 'pagina': c['pagina'],
                })
                n += 1
                print(f'  = {c["ancho"]:>5}x{c["alto"]:<5} {c["titulo"][:56]} (ya estaba)')
                continue
            try:
                def _bajar(u=c['url'], destino=ruta):
                    req = urllib.request.Request(u, headers={'User-Agent': UA})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        destino.write_bytes(r.read())
                _con_reintento(_bajar, c['titulo'][:26])
                time.sleep(PAUSA_S)
            except Exception as e:                    # noqa: BLE001
                print(f'    ✗ {c["titulo"][:44]:46} {str(e)[:40]}')
                continue

            catalogo.append({
                'fichero': str(ruta), 'articulo': articulo, 'para': para,
                'titulo': c['titulo'], 'ancho': c['ancho'], 'alto': c['alto'],
                'licencia': c['licencia'], 'autor': c['autor'], 'pagina': c['pagina'],
            })
            n += 1
            print(f'  ✓ {c["ancho"]:>5}x{c["alto"]:<5} {c["titulo"][:56]}')

        print(f'    {DESTINO.name}: {n} de «{articulo}» — {para}')

    salida = DESTINO.parent / 'assets-curados.json'
    salida.write_text(json.dumps(catalogo, indent=2, ensure_ascii=False), encoding='utf-8')
    grandes = sum(1 for c in catalogo if max(c['ancho'], c['alto']) >= 2500)
    print(f'\n  {len(catalogo)} imágenes  ·  {grandes} admiten Ken Burns completo '
          f'(≥2500px)  ·  {len(catalogo) - grandes} irán con movimiento reducido')
    print(f'  → {salida}')


if __name__ == '__main__':
    main()
