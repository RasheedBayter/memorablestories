#!/usr/bin/env python3
"""
Compone los guiones de `scripts-out/` en un PDF legible.

    python3 scripts/scripts-to-pdf.py

No es un renderizador de markdown de propósito general: sabe leer el formato
concreto de estos guiones, y ese conocimiento es justo lo que lo hace legible.

Tres decisiones que cambian la experiencia de lectura:

  - Las anclas `[doi:10.7759/cureus.71689]` se convierten en superíndices
    numerados con su leyenda al final de cada guion. En el markdown el DOI
    inline es lo correcto —es lo que verifica `verify.ts`—, pero leyendo se
    come la frase.
  - Las pistas visuales (`>>`) van a un carril lateral en gris. Son
    instrucciones de producción, no narración: mezcladas en el cuerpo obligan a
    filtrarlas mentalmente en cada párrafo.
  - La narración va en serif y con medida de lectura corta. Es un texto para
    decir en voz alta; se juzga leyéndolo despacio.

Cada guion abre en página nueva y lleva su medición real (palabras, minutos con
la voz elegida), porque la duración es el criterio con el que se van a comparar.
"""

import html
import pathlib
import re
import subprocess
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ENTRADA = RAIZ / 'scripts-out'
SALIDA = RAIZ / 'scripts-out' / 'guiones.pdf'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

# Ritmo MEDIDO de George contra la API el 29/07/2026. Ver MEASURED_WPM.
WPM = 174
VOZ = 'George'

ANCLA = re.compile(r'\[((?:doi|isbn|url|s2|film|t):[^\]]+)\]')


def marcado_inline(texto: str) -> str:
    """Solo negrita, cursiva y código. El resto se escapa."""
    t = html.escape(texto)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*]+?)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return t


def convertir(md: str) -> tuple[str, dict[str, int], int]:
    """Devuelve (html, fuentes numeradas, palabras narradas)."""
    fuentes: dict[str, int] = {}
    out: list[str] = []
    palabras = 0
    en_tabla = False
    en_meta = True   # cabecera del fichero, hasta el primer `---`

    for linea in md.split('\n'):
        s = linea.strip()

        if s == '---':
            if en_meta:
                en_meta = False
                continue
            out.append('<hr>')
            continue

        if not s:
            if en_tabla:
                out.append('</tbody></table>')
                en_tabla = False
            continue

        if s.startswith('#'):
            n = len(s) - len(s.lstrip('#'))
            txt = s.lstrip('# ').strip()
            out.append(f'<h{min(n, 4)}>{marcado_inline(txt)}</h{min(n, 4)}>')
            continue

        if en_meta and s.startswith('**'):
            out.append(f'<p class="meta">{marcado_inline(s)}</p>')
            continue
        if en_meta:
            continue

        if s.startswith('>> '):
            out.append(f'<p class="visual">{html.escape(s[3:])}</p>')
            continue

        if s.startswith('|'):
            celdas = [c.strip() for c in s.strip('|').split('|')]
            if set(''.join(celdas)) <= set('-: '):
                continue
            if not en_tabla:
                out.append('<table><thead><tr>' +
                           ''.join(f'<th>{marcado_inline(c)}</th>' for c in celdas) +
                           '</tr></thead><tbody>')
                en_tabla = True
            else:
                out.append('<tr>' + ''.join(f'<td>{marcado_inline(c)}</td>' for c in celdas) + '</tr>')
            continue

        # Párrafo narrado: las anclas salen del cuerpo y se numeran.
        cuerpo = ANCLA.sub('', s).strip()
        palabras += len(cuerpo.split())

        sups = []
        for m in ANCLA.finditer(s):
            sid = m.group(1)
            if sid not in fuentes:
                fuentes[sid] = len(fuentes) + 1
            sups.append(fuentes[sid])

        marca = ''
        if sups:
            marca = '<sup>' + ','.join(str(n) for n in sorted(set(sups))) + '</sup>'
        out.append(f'<p>{marcado_inline(cuerpo)}{marca}</p>')

    if en_tabla:
        out.append('</tbody></table>')
    return '\n'.join(out), fuentes, palabras


CSS = """
@page { size: A4; margin: 20mm 18mm 18mm 18mm; }
* { box-sizing: border-box; }
body {
  font: 11.5pt/1.62 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  color: #1a1a1a; margin: 0;
}
.guion { page-break-after: always; }
.guion:last-child { page-break-after: auto; }

h1 {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 26pt; line-height: 1.15; letter-spacing: -0.02em;
  margin: 0 0 4pt; font-weight: 700;
}
h2 {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 9pt; letter-spacing: 0.13em; text-transform: uppercase;
  color: #8a5a00; font-weight: 700;
  margin: 26pt 0 9pt; padding-bottom: 4pt; border-bottom: 1px solid #e0d8c8;
  page-break-after: avoid;
}
h3, h4 { font-family: -apple-system, sans-serif; font-size: 11pt; margin: 16pt 0 6pt; }

p { margin: 0 0 9pt; text-align: justify; hyphens: auto; }
p.meta {
  font-family: -apple-system, sans-serif; font-size: 8.5pt; color: #666;
  text-align: left; margin: 0 0 3pt;
}

/* Pistas visuales: carril lateral, no narración. */
p.visual {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 8pt; line-height: 1.4; color: #7a7a7a;
  border-left: 2px solid #d8d8d8; padding: 1pt 0 1pt 8pt;
  margin: 11pt 0 7pt; text-align: left; hyphens: none;
  page-break-inside: avoid;
}

sup {
  font-family: -apple-system, sans-serif; font-size: 6.5pt;
  color: #8a5a00; vertical-align: super; line-height: 0;
  margin-left: 1.5pt; font-weight: 600;
}

hr { border: 0; border-top: 1px solid #e8e8e8; margin: 18pt 0; }

table {
  width: 100%; border-collapse: collapse; font-size: 8pt;
  font-family: -apple-system, sans-serif; margin: 10pt 0;
  page-break-inside: avoid;
}
th {
  text-align: left; font-weight: 600; font-size: 7pt;
  text-transform: uppercase; letter-spacing: 0.06em; color: #666;
  border-bottom: 1px solid #ccc; padding: 4pt 6pt 3pt 0;
}
td { padding: 3pt 6pt 3pt 0; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
code {
  font-family: ui-monospace,'SF Mono',Menlo,monospace; font-size: 8pt;
  background: #f4f4f2; padding: 0.5pt 3pt; border-radius: 2px;
}

.ficha {
  font-family: -apple-system, sans-serif; font-size: 8.5pt; color: #444;
  background: #faf8f4; border: 1px solid #ece6da; border-radius: 4px;
  padding: 9pt 11pt; margin: 12pt 0 22pt;
}
.ficha b { color: #1a1a1a; }
.ficha .sep { color: #c9bfae; margin: 0 7pt; }

.notas {
  margin-top: 22pt; padding-top: 11pt; border-top: 1px solid #ddd;
  font-family: -apple-system, sans-serif; font-size: 7.5pt;
  line-height: 1.55; color: #555; column-count: 2; column-gap: 16pt;
}
.notas div { break-inside: avoid; margin-bottom: 3pt; }
.notas b { color: #8a5a00; }

.portada { page-break-after: always; padding-top: 55mm; }
.portada h1 { font-size: 34pt; }
.portada .sub {
  font-family: -apple-system, sans-serif; font-size: 10pt; color: #666;
  margin-top: 10pt; line-height: 1.7;
}
"""


def main() -> None:
    ficheros = sorted(ENTRADA.glob('*.md'))
    if not ficheros:
        sys.exit(f'No hay guiones en {ENTRADA}')

    partes = [
        '<div class="portada">'
        '<h1>Memorable Stories</h1>'
        '<div class="sub">Dos guiones para elegir<br>'
        f'Documental histórico · inglés · voz {VOZ} ({WPM} wpm medidos)<br>'
        'Cada afirmación anclada a su fuente del dossier</div></div>'
    ]

    for f in ficheros:
        cuerpo, fuentes, palabras = convertir(f.read_text(encoding='utf-8'))
        minutos = palabras / WPM
        banda = '✓ dentro de la banda 15–28 min' if 15 <= minutos <= 28 else '⚠ fuera de la banda 15–28 min'
        ficha = (
            f'<div class="ficha"><b>{palabras:,} palabras narradas</b><span class="sep">·</span>'
            f'<b>{minutos:.1f} min</b> con {VOZ}<span class="sep">·</span>'
            f'{len(fuentes)} fuentes citadas<span class="sep">·</span>{banda}</div>'
        ).replace(',', '.')

        # La ficha va justo detrás del <h1> del guion.
        cuerpo = cuerpo.replace('</h1>', '</h1>' + ficha, 1)

        notas = ''.join(
            f'<div><b>{n}</b>&nbsp; {html.escape(sid)}</div>'
            for sid, n in sorted(fuentes.items(), key=lambda kv: kv[1])
        )
        partes.append(
            f'<div class="guion">{cuerpo}'
            f'<div class="notas"><div style="column-span:all;font-weight:600;color:#1a1a1a;'
            f'margin-bottom:6pt">Fuentes citadas</div>{notas}</div></div>'
        )

    doc = (f'<!doctype html><html lang="es"><head><meta charset="utf-8">'
           f'<title>Guiones — Memorable Stories</title><style>{CSS}</style></head>'
           f'<body>{"".join(partes)}</body></html>')

    tmp = ENTRADA / '.guiones.html'
    tmp.write_text(doc, encoding='utf-8')

    subprocess.run(
        [CHROME, '--headless', '--disable-gpu', '--no-pdf-header-footer',
         f'--print-to-pdf={SALIDA}', tmp.as_uri()],
        check=True, capture_output=True, timeout=180,
    )
    tmp.unlink()
    print(f'{SALIDA}  ({SALIDA.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
