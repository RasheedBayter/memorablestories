#!/usr/bin/env python3
"""
Compone los guiones de `scripts-out/` en una página web legible y publicable.

    python3 scripts/scripts-to-html.py

Hermano de `scripts-to-pdf.py`, con una diferencia que justifica que exista: el
papel no puede enseñar la fuente. Aquí cada superíndice es pulsable y despliega
la ficha de la fuente que sostiene esa frase —autor, año, publicación, DOI—
sacada del dossier real del episodio.

Eso no es un adorno: es la tesis del producto puesta en la propia página. Un
guion documental cuyas afirmaciones no se pueden rastrear hasta su fuente es
indistinguible de uno inventado, y la diferencia solo se ve si se puede mirar.

La maqueta trata el guion como lo que es, una partitura de dos pistas: lo que se
OYE en la columna de lectura, y lo que se VE en un carril alineado a su párrafo.
En pantalla estrecha el carril se pliega encima, porque a una sola columna la
alineación deja de significar nada.
"""

import html
import json
import pathlib
import re
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ENTRADA = RAIZ / 'scripts-out'
SALIDA = ENTRADA / 'guiones.html'
EPISODIOS = RAIZ / '.episodes'

WPM = 174
VOZ = 'George'

ANCLA = re.compile(r'\[((?:doi|isbn|url|s2|t):[^\]]+)\]')


def catalogo_fuentes() -> dict[str, dict]:
    """Metadatos de fuente por id, leídos de los dossieres reales."""
    cat: dict[str, dict] = {}
    if not EPISODIOS.exists():
        return cat
    for d in EPISODIOS.iterdir():
        f = d / 'research/dossier.json'
        if not f.exists():
            continue
        for fu in json.loads(f.read_text(encoding='utf-8')).get('fuentes', []):
            cat[fu['id']] = {
                'titulo': fu.get('titulo', ''),
                'autores': ', '.join(a.get('nombre', '') for a in fu.get('autores', [])[:3]),
                'anio': fu.get('anio'),
                'contenedor': fu.get('contenedor') or fu.get('editorial') or '',
                'url': fu.get('url', ''),
                'revisada': fu.get('revisadaPorPares'),
                'extractos': len(fu.get('extractos', [])),
            }
    return cat


def miles(n: int) -> str:
    """Separador de miles español.

    Se formatea AQUÍ y no con un `.replace(',', '.')` sobre el bloque entero:
    esa versión también convertía las comas de los nombres de autor, y dejaba
    "Sheuli Paul, Jane Doe" como "Sheuli Paul. Jane Doe".
    """
    return f'{n:,}'.replace(',', '.')


def inline(t: str) -> str:
    t = html.escape(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*]+?)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return t


def convertir(md: str, cat: dict, slug: str) -> tuple[str, str, list[str], int]:
    """Devuelve (titulo, html del cuerpo, ids de fuente en orden, palabras)."""
    orden: list[str] = []
    num: dict[str, int] = {}
    out: list[str] = []
    titulo = ''
    palabras = 0
    en_meta = True
    pendiente: list[str] = []      # pistas visuales esperando a su párrafo

    def volcar_visual() -> str:
        if not pendiente:
            return ''
        items = ''.join(f'<span>{html.escape(v)}</span>' for v in pendiente)
        pendiente.clear()
        return f'<aside class="ve">{items}</aside>'

    for linea in md.split('\n'):
        s = linea.strip()

        if s == '---':
            if en_meta:
                en_meta = False
            continue
        if not s:
            continue

        if s.startswith('#'):
            n = len(s) - len(s.lstrip('#'))
            txt = s.lstrip('# ').strip()
            if n == 1 and not titulo:
                titulo = txt
                continue
            if txt.lower().startswith('fuentes principales'):
                break          # la tabla de fuentes la rehace la propia página
            out.append(f'<h2 id="{slug}-{len(out)}">{inline(txt)}</h2>')
            continue

        if en_meta:
            continue

        if s.startswith('>> '):
            pendiente.append(s[3:])
            continue

        if s.startswith('|'):
            continue

        cuerpo = ANCLA.sub('', s).strip()
        palabras += len(cuerpo.split())

        marcas = []
        for m in ANCLA.finditer(s):
            sid = m.group(1)
            if sid not in num:
                orden.append(sid)
                num[sid] = len(orden)
            marcas.append((num[sid], sid))

        sup = ''
        for n_, sid in sorted(set(marcas)):
            sup += (f'<button class="cita" data-fuente="{html.escape(sid)}" '
                    f'aria-label="Fuente {n_}">{n_}</button>')

        out.append(f'<div class="beat">{volcar_visual()}'
                   f'<p>{inline(cuerpo)}{sup}</p></div>')

    return titulo, '\n'.join(out), orden, palabras


CSS = """
:root{
  --papel:#F3F4F1; --panel:#FFFFFF; --tinta:#15181A; --tenue:#5C6360;
  --debil:#8B9290; --linea:#DFE2DC; --patina:#2E6A5C; --patina-suave:#E4EDE9;
  --alerta:#8A5A1F;
}
@media (prefers-color-scheme:dark){
  :root{
    --papel:#111413; --panel:#181C1B; --tinta:#E8EBE7; --tenue:#9BA39F;
    --debil:#6E7674; --linea:#2A302E; --patina:#6FB5A1; --patina-suave:#1C2A26;
    --alerta:#C79A5C;
  }
}
:root[data-theme="dark"]{
  --papel:#111413; --panel:#181C1B; --tinta:#E8EBE7; --tenue:#9BA39F;
  --debil:#6E7674; --linea:#2A302E; --patina:#6FB5A1; --patina-suave:#1C2A26;
  --alerta:#C79A5C;
}
:root[data-theme="light"]{
  --papel:#F3F4F1; --panel:#FFFFFF; --tinta:#15181A; --tenue:#5C6360;
  --debil:#8B9290; --linea:#DFE2DC; --patina:#2E6A5C; --patina-suave:#E4EDE9;
  --alerta:#8A5A1F;
}

*{box-sizing:border-box}
body{
  margin:0;background:var(--papel);color:var(--tinta);
  font:400 18px/1.66 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  -webkit-font-smoothing:antialiased;
}
.sans{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif}
.mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}

/* ---- barra de comparación ---- */
header{
  position:sticky;top:0;z-index:20;background:var(--papel);
  border-bottom:1px solid var(--linea);
}
.barra{
  max-width:1180px;margin:0 auto;padding:14px 24px;
  display:flex;flex-wrap:wrap;gap:10px 28px;align-items:baseline;
}
.marca{
  font-family:-apple-system,sans-serif;font-size:11px;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;color:var(--patina);
  margin-right:auto;
}
.salto{
  font-family:-apple-system,sans-serif;font-size:13px;color:var(--tenue);
  text-decoration:none;padding:5px 11px;border:1px solid var(--linea);
  border-radius:100px;transition:.15s;
}
.salto:hover,.salto:focus-visible{color:var(--tinta);border-color:var(--patina)}

main{max-width:1180px;margin:0 auto;padding:0 24px 120px}

/* ---- portada ---- */
.intro{padding:76px 0 52px;border-bottom:1px solid var(--linea);max-width:660px}
.intro h1{
  font-family:-apple-system,sans-serif;font-size:clamp(34px,5vw,52px);
  line-height:1.04;letter-spacing:-.032em;font-weight:750;margin:0 0 18px;
  text-wrap:balance;
}
.intro p{color:var(--tenue);font-size:19px;margin:0 0 14px}

/* ---- cabecera de guion ---- */
.guion{padding-top:64px;scroll-margin-top:64px}
.guion h1{
  font-family:-apple-system,sans-serif;font-size:clamp(28px,4vw,42px);
  line-height:1.08;letter-spacing:-.028em;font-weight:750;margin:0 0 20px;
  text-wrap:balance;
}
.metricas{
  display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--linea);
  border-radius:8px;overflow:hidden;background:var(--panel);margin-bottom:8px;
}
.metrica{padding:13px 20px;border-right:1px solid var(--linea);flex:1 1 auto;min-width:118px}
.metrica:last-child{border-right:0}
.metrica dt{
  font-family:-apple-system,sans-serif;font-size:10px;font-weight:600;
  letter-spacing:.11em;text-transform:uppercase;color:var(--debil);margin:0 0 3px;
}
.metrica dd{
  margin:0;font-family:-apple-system,sans-serif;font-size:19px;font-weight:650;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em;
}
.metrica .sub{font-size:12px;font-weight:400;color:var(--tenue);margin-left:5px}
.ok{color:var(--patina)} .aviso{color:var(--alerta)}

/* ---- partitura de dos pistas ---- */
h2{
  font-family:-apple-system,sans-serif;font-size:11px;font-weight:700;
  letter-spacing:.15em;text-transform:uppercase;color:var(--patina);
  margin:56px 0 22px;padding-bottom:8px;border-bottom:1px solid var(--linea);
  scroll-margin-top:80px;
}
.beat{display:grid;grid-template-columns:210px 1fr;gap:32px;margin-bottom:20px}
.ve{
  font-family:-apple-system,sans-serif;font-size:12.5px;line-height:1.45;
  color:var(--debil);display:flex;flex-direction:column;gap:7px;
  padding-top:7px;text-align:right;
}
.ve span{display:block}
.ve span::before{content:"▸ ";color:var(--patina);opacity:.65}
.beat p{margin:0;max-width:33em}

/* ---- citas ---- */
.cita{
  font-family:-apple-system,sans-serif;font-size:10.5px;font-weight:700;
  color:var(--patina);background:var(--patina-suave);border:0;
  border-radius:4px;padding:1px 5px;margin-left:3px;cursor:pointer;
  vertical-align:.42em;line-height:1.5;transition:.13s;
}
.cita:hover,.cita:focus-visible{background:var(--patina);color:var(--papel)}
.cita[aria-expanded="true"]{background:var(--patina);color:var(--papel)}

.ficha{
  grid-column:2;margin:10px 0 4px;padding:15px 18px;background:var(--panel);
  border:1px solid var(--linea);border-left:3px solid var(--patina);
  border-radius:0 7px 7px 0;max-width:33em;
  font-family:-apple-system,sans-serif;font-size:14px;line-height:1.5;
}
.ficha .t{font-weight:640;display:block;margin-bottom:5px}
.ficha .m{color:var(--tenue);font-size:13px}
.ficha .id{
  font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--debil);
  display:block;margin-top:7px;word-break:break-all;
}
.ficha a{color:var(--patina)}

/* ---- bibliografía ---- */
.biblio{margin-top:60px;padding-top:26px;border-top:1px solid var(--linea)}
.biblio h3{
  font-family:-apple-system,sans-serif;font-size:11px;font-weight:700;
  letter-spacing:.15em;text-transform:uppercase;color:var(--debil);margin:0 0 18px;
}
.biblio ol{margin:0;padding:0;list-style:none;display:grid;gap:13px}
.biblio li{
  display:grid;grid-template-columns:26px 1fr;gap:12px;
  font-family:-apple-system,sans-serif;font-size:14px;line-height:1.48;
}
.biblio .n{
  font-weight:700;color:var(--patina);font-variant-numeric:tabular-nums;
  font-size:12px;padding-top:2px;
}
.biblio .m{color:var(--tenue);display:block;font-size:13px}
.biblio code{font-size:11.5px;color:var(--debil);font-family:ui-monospace,Menlo,monospace}

@media (max-width:860px){
  body{font-size:17px}
  .beat{grid-template-columns:1fr;gap:9px}
  .ve{text-align:left;padding-top:0;order:-1}
  .ficha{grid-column:1}
  .metrica{border-right:0;border-bottom:1px solid var(--linea)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
:focus-visible{outline:2px solid var(--patina);outline-offset:2px;border-radius:3px}
"""

JS = """
const CAT = __CAT__;
document.addEventListener('click', (e) => {
  const b = e.target.closest('.cita');
  if (!b) return;
  const beat = b.closest('.beat');
  const abierta = beat.querySelector('.ficha');
  const mismo = abierta && abierta.dataset.fuente === b.dataset.fuente;
  beat.querySelectorAll('.ficha').forEach(f => f.remove());
  beat.querySelectorAll('.cita').forEach(c => c.setAttribute('aria-expanded','false'));
  if (mismo) return;

  const f = CAT[b.dataset.fuente];
  const d = document.createElement('div');
  d.className = 'ficha';
  d.dataset.fuente = b.dataset.fuente;
  if (!f) {
    d.innerHTML = '<span class="t">Fuente no encontrada en el dossier</span>' +
      '<span class="id">' + b.dataset.fuente + '</span>';
  } else {
    const meta = [f.autores, f.anio, f.contenedor].filter(Boolean).join(' · ');
    d.innerHTML =
      '<span class="t">' + f.titulo + '</span>' +
      '<span class="m">' + meta + '</span>' +
      (f.extractos ? '<span class="m"> · ' + f.extractos + ' extracto' +
        (f.extractos === 1 ? '' : 's') + ' recuperado' + (f.extractos === 1 ? '' : 's') + '</span>' : '') +
      '<span class="id">' + b.dataset.fuente +
      (f.url ? ' — <a href="' + f.url + '" target="_blank" rel="noopener">abrir</a>' : '') +
      '</span>';
  }
  beat.appendChild(d);
  b.setAttribute('aria-expanded','true');
});
"""


def main() -> None:
    cat = catalogo_fuentes()
    ficheros = sorted(ENTRADA.glob('*.md'))
    if not ficheros:
        sys.exit(f'No hay guiones en {ENTRADA}')

    secciones, saltos, usadas = [], [], {}

    for i, f in enumerate(ficheros, 1):
        slug = f.stem
        titulo, cuerpo, orden, palabras = convertir(f.read_text(encoding='utf-8'), cat, slug)
        minutos = palabras / WPM
        dentro = 15 <= minutos <= 28
        for sid in orden:
            usadas[sid] = cat.get(sid)

        biblio = ''.join(
            f'<li><span class="n">{n}</span><span>'
            f'{html.escape((cat.get(sid) or {}).get("titulo") or sid)}'
            f'<span class="m">{html.escape(" · ".join(str(x) for x in [(cat.get(sid) or {}).get("autores"), (cat.get(sid) or {}).get("anio"), (cat.get(sid) or {}).get("contenedor")] if x))}</span>'
            f'<code>{html.escape(sid)}</code></span></li>'
            for n, sid in enumerate(orden, 1)
        )

        saltos.append(f'<a class="salto" href="#{slug}">{html.escape(titulo)}</a>')
        secciones.append(f"""
<section class="guion" id="{slug}">
  <h1>{html.escape(titulo)}</h1>
  <dl class="metricas">
    <div class="metrica"><dt>Duración con {VOZ}</dt>
      <dd class="{'ok' if dentro else 'aviso'}">{minutos:.1f}<span class="sub">min</span></dd></div>
    <div class="metrica"><dt>Palabras narradas</dt><dd>{miles(palabras)}</dd></div>
    <div class="metrica"><dt>Fuentes citadas</dt><dd>{len(orden)}</dd></div>
    <div class="metrica"><dt>Banda 15–28 min</dt>
      <dd class="{'ok' if dentro else 'aviso'}">{'Dentro' if dentro else 'Fuera'}</dd></div>
    <div class="metrica"><dt>Narración</dt><dd>${palabras * 6.15 * 0.0001:.2f}</dd></div>
  </dl>
  {cuerpo}
  <div class="biblio"><h3>Fuentes citadas en este guion</h3><ol>{biblio}</ol></div>
</section>""")

    doc = f"""<title>Dos guiones — Memorable Stories</title>
<style>{CSS}</style>
<header><div class="barra">
  <span class="marca">Memorable Stories · guiones</span>
  {''.join(saltos)}
</div></header>
<main>
  <div class="intro">
    <h1>Dos guiones para elegir</h1>
    <p>Documental histórico en inglés, narrado por {VOZ} a {WPM} palabras por minuto —
       un ritmo medido contra la API, no supuesto.</p>
    <p>Cada afirmación lleva el número de la fuente del dossier que la sostiene.
       <strong>Púlsalo</strong> y verás cuál es. Lo que se ve en pantalla va en el
       margen; lo que se oye, en la columna.</p>
  </div>
  {''.join(secciones)}
</main>
<script>{JS.replace('__CAT__', json.dumps(usadas, ensure_ascii=False))}</script>
"""
    SALIDA.write_text(doc, encoding='utf-8')
    print(f'{SALIDA}  ({SALIDA.stat().st_size // 1024} KB · {len(usadas)} fuentes)')


if __name__ == '__main__':
    main()
