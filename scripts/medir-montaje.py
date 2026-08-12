#!/usr/bin/env python3
"""
Mide la GRAMÁTICA de un montaje ya renderizado: no cuánto dura un plano, sino
dónde cae el corte respecto a la frase, qué imagen sostiene una cifra, cuánto
silencio hay y qué planos vuelven.

    python3 scripts/medir-montaje.py scripts-out/03-motorola

Rellena la columna «nosotros» de la ficha de docs/GRAMATICA-NARRATIVA.md.

Espera encontrar dentro del episodio:
  montaje/timeline.json      lista de planos: acto, t (FILM/GEN/PHOTO/BLACK), start, dur
  montaje/alineacion.json    {acto: {segments: [{i,start,end,words,text}]}}
  voz/narracion/<acto>.txt   un párrafo por línea, en el mismo orden
  montaje/palabras-*.json    (opcional) [{w,s,e}] alineación palabra a palabra
"""
import json, os, re, sys, statistics as st
from collections import Counter, defaultdict

EP = sys.argv[1] if len(sys.argv) > 1 else 'scripts-out/03-motorola'
M = os.path.join(EP, 'montaje')

tl = json.load(open(os.path.join(M, 'timeline.json'), encoding='utf8'))
al = json.load(open(os.path.join(M, 'alineacion.json'), encoding='utf8'))
partes = list(al.keys())
total = sum(s['dur'] for s in tl)

def parrafos(p):
    f = os.path.join(EP, 'voz', 'narracion', f'{p}.txt')
    if not os.path.exists(f):
        return [s['text'] for s in al[p]['segments']]
    return [l.strip() for l in open(f, encoding='utf8').read().split('\n') if l.strip()]

def h(t):
    print(f'\n{"="*66}\n{t}\n{"="*66}')

# ---------------------------------------------------------------- suelo
h('SUELO — duración, ritmo, reparto')
vis = [s for s in tl if s['t'] != 'BLACK']
d = [s['dur'] for s in vis]
print(f'  {total/60:.2f} min · {len(tl)} planos ({len(vis)} visibles)')
print(f'  media {st.mean(d):.2f} s · mediana {st.median(d):.2f} s · {len(vis)/(total/60):.2f} cortes/min')
tipos = defaultdict(lambda: [0, 0.0])
for s in tl:
    tipos[s['t']][0] += 1
    tipos[s['t']][1] += s['dur']
for t_, (n, s_) in sorted(tipos.items(), key=lambda x: -x[1][1]):
    print(f'    {t_:<6} {n:>3} planos {s_:8.1f} s  {100*s_/total:5.1f}%')

pal = sum(s['words'] for p in partes for s in al[p]['segments'])
print(f'  {pal} palabras · {60*pal/total:.1f} ppm · '
      f'{sum(len(al[p]["segments"]) for p in partes)} párrafos')

# ------------------------------------------------- L1 posición del corte
h('L1 — dónde cae el corte respecto al límite de párrafo')
clas = Counter()
sueltos = []
for p in partes:
    segs = al[p]['segments']
    bounds = sorted({x['start'] for x in segs} | {x['end'] for x in segs})
    for s in [x for x in tl if x['acto'] == p and x['start'] > 0]:
        dist = min(abs(s['start'] - b) for b in bounds)
        cur = next((x for x in segs if x['start'] <= s['start'] < x['end']), None)
        rel = (s['start']-cur['start'])/max(cur['end']-cur['start'], 1e-6) if cur else None
        if dist < 0.06:
            clas['en el límite (cierra)'] += 1
        elif dist < 0.35:
            clas['junto al límite'] += 1
        else:
            clas['dentro del párrafo'] += 1
            sueltos.append((p, s['t'], s['start'], dist, rel))
n = sum(clas.values())
for k, v in clas.most_common():
    print(f'  {k:<24} {v:>3}  ({100*v/n:.0f}%)')
if sueltos:
    print('  los que caen dentro del párrafo:')
    for p, t_, s_, dist, rel in sueltos:
        r = f'{100*rel:.0f}% del párrafo' if rel is not None else ''
        print(f'    {p[:16]:<16} t={s_:7.2f} {t_:<5} a {dist:.2f} s del límite · {r}')
print('  ⚠ un reparto de 100 % «en el límite» significa que ninguna posición '
      'de corte fue elegida: la genera la regla del render.')

# palabra a palabra, si existe
for f in sorted(os.listdir(M)):
    if not f.startswith('palabras-'):
        continue
    acto = f[len('palabras-'):-len('.json')]
    p = next((x for x in partes if x.endswith(acto) or acto in x), None)
    if not p:
        continue
    pw = json.load(open(os.path.join(M, f), encoding='utf8'))
    print(f'\n  {f} — corte contra puntuación:')
    c = Counter()
    for s in [x for x in tl if x['acto'] == p and x['t'] != 'BLACK' and x['start'] > 0]:
        antes = [w for w in pw if w['e'] <= s['start']+0.05]
        desp = [w for w in pw if w['s'] >= s['start']-0.05]
        if not antes or not desp:
            continue
        tok = antes[-1]['w']
        k = ('tras PUNTO (cierra)' if tok.endswith(('.', '!', '?', '"'))
             else 'tras COMA (suspende)' if tok.endswith((',', ';', ':', '—', '-'))
             else 'MITAD de sintagma (tensión)')
        c[k] += 1
    for k, v in c.most_common():
        print(f'    {k:<30} {v}')

# ----------------------------------------------------- L3 respiraciones
h('L3 — respiración: imagen sin voz')
neg = [s for s in tl if s['t'] == 'BLACK']
if neg:
    print(f'  negros: {len(neg)} · {sum(s["dur"] for s in neg):.1f} s '
          f'({100*sum(s["dur"] for s in neg)/total:.1f}%) · '
          f'duraciones {sorted({round(s["dur"],2) for s in neg})}')
    con_voz = 0
    for p in partes:
        segs = al[p]['segments']
        for s in [x for x in tl if x['acto'] == p and x['t'] == 'BLACK']:
            if any(x['start'] < s['start']+s['dur'] and x['end'] > s['start'] for x in segs):
                con_voz += 1
    print(f'  negros CON narración encima: {con_voz} de {len(neg)}'
          + ('   ⚠ el negro es fondo, no silencio' if con_voz == len(neg) else ''))
mx = 0.0
tot_pausa = 0.0
for f in sorted(os.listdir(M)):
    if not f.startswith('palabras-'):
        continue
    pw = json.load(open(os.path.join(M, f), encoding='utf8'))
    g = [pw[i+1]['s']-pw[i]['e'] for i in range(len(pw)-1)]
    g = [x for x in g if x > 0.25]
    if g:
        mx = max(mx, max(g))
        tot_pausa += sum(g)
        print(f'  {f}: {len(g)} pausas >250 ms · media {st.mean(g):.2f} s · máx {max(g):.2f} s')
if mx:
    print(f'  pausa más larga de todo el episodio medido: {mx:.2f} s'
          + ('   ⚠ ningún silencio narrativo' if mx < 1.5 else ''))

# --------------------------------------------- L2 imagen bajo una cifra
h('L2 — qué imagen sostiene una cifra')
NUM = re.compile(r'\b\d[\d.,]*\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|'
                 r'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|'
                 r'million|billion|percent|dollars)\b', re.I)
con, sin = Counter(), Counter()
dcon, dsin = [], []
for p in partes:
    lin = parrafos(p)
    segs = al[p]['segments']
    shots = [x for x in tl if x['acto'] == p]
    for i, sg in enumerate(segs):
        txt = lin[i] if i < len(lin) else sg['text']
        hits = len(NUM.findall(txt))
        cov = Counter()
        for s in shots:
            ov = min(s['start']+s['dur'], sg['end']) - max(s['start'], sg['start'])
            if ov > 0:
                cov[s['t']] += ov
        if not cov:
            continue
        dom = cov.most_common(1)[0][0]
        durs = [s['dur'] for s in shots
                if s['t'] != 'BLACK' and s['start'] < sg['end'] and s['start']+s['dur'] > sg['start']]
        if hits >= 2:
            con[dom] += 1
            dcon += durs
        elif hits == 0:
            sin[dom] += 1
            dsin += durs
for lab, c_, ds in (('CON cifra', con, dcon), ('SIN cifra', sin, dsin)):
    n_ = sum(c_.values())
    print(f'  párrafos {lab} ({n_}): ' + ' · '.join(f'{k} {100*v/n_:.0f}%' for k, v in c_.most_common()))
    if ds:
        print(f'    duración media del plano debajo: {st.mean(ds):.2f} s')
if dcon and dsin and abs(st.mean(dcon)-st.mean(dsin)) < 1.0:
    print('  ⚠ no distinguimos: la cifra y el juicio reciben el mismo tratamiento visual.')

# ---------------------------------------------- L4 siembra y recogida
h('L4 — rimas visuales (mismo plano que vuelve)')
pos = defaultdict(list)
off = 0.0
for p in partes:
    for s in tl:
        if s['acto'] == p and s['a']:
            pos[s['a']].append(off + s['start'])
    off += sum(x['dur'] for x in tl if x['acto'] == p)
largos = 0
for k, v in sorted(pos.items(), key=lambda x: -(max(x[1])-min(x[1]))):
    if len(v) < 2:
        continue
    span = max(v)-min(v)
    marca = '  ← RIMA DE LARGO ALCANCE' if span > 120 else ''
    if span > 120:
        largos += 1
    print(f'  x{len(v)} {os.path.basename(k)[:46]:<46} {span/60:5.1f} min de separación{marca}')
print(f'  arcos de más de 2 min: {largos}   (por debajo de 2 min no es recogida, '
      'es que se acabó el material)')

# ------------------------------------------------------ L5 digresiones
h('L5 — entradas de digresión (salto en el tiempo)')
SALTO = re.compile(r'^(In \d{4}|By \d{4}|That year|Then the war|On the |In (January|February|'
                   r'March|April|May|June|July|August|September|October|November|December))')
n_salto = 0
n_par = 0
for p in partes:
    lin = parrafos(p)
    n_par += len(lin)
    for i, l in enumerate(lin):
        if SALTO.match(l):
            n_salto += 1
            t_ = al[p]['segments'][i]['start'] if i < len(al[p]['segments']) else -1
            print(f'  {p[:16]:<16} t={t_:7.1f}  {l[:74]}')
print(f'  {n_salto} de {n_par} párrafos abren con salto temporal por corte seco de fecha.')
preg = sum(1 for p in partes for l in parrafos(p) if '?' in l)
print(f'  entradas por pregunta en todo el episodio: {preg}')

# --------------------------------------------------------- L7 rótulos
h('L7 — estados visuales dentro del plano')
tip = os.path.join(M, 'tipografia')
if os.path.isdir(tip):
    n_t = len([f for f in os.listdir(tip) if not f.startswith('.')])
    print(f'  tarjetas tipográficas: {n_t} · una cada {total/max(n_t,1):.0f} s '
          f'({60*n_t/total:.1f} por minuto)')
else:
    print('  sin directorio montaje/tipografia: 0 rótulos')
print('\n  → rellena con esto la ficha de docs/GRAMATICA-NARRATIVA.md §3\n')
