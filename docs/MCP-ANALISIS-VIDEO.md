# Análisis de vídeo con el conector MCP de Higgsfield — pruebas reales

Fecha de la prueba: 2026-08-07. Saldo inicial: 2306 créditos (plan Ultra). Presupuesto autorizado: 30 créditos. **Gasto real total: 5.42 créditos** (ver desglose por herramienta).

Metodología: cada herramienta se invocó de verdad contra la API de Higgsfield (no se leyó documentación), comprobando `balance` y `transactions` antes/después de cada llamada para medir el coste real, porque ninguna de estas herramientas expone un parámetro `get_cost`.

---

## 1. `video_analysis_create` + `video_analysis_status` — ES LA HERRAMIENTA QUE SIRVE

**Qué acepta de entrada:** exactamente uno de dos campos — `youtube_url` (link de youtube.com/youtu.be) **o** `video_input_id` (UUID de un vídeo subido previamente con `media_upload`+`media_confirm`). No acepta un ID de generación de Higgsfield directamente para esta llamada (aunque `virality_predictor`, más abajo, sí lo hace).

Probado con **ambas** vías:

### a) Con URL de YouTube (vídeo de 19s, "Me at the zoo")

Llamada:
```json
{"youtube_url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}
```
Respuesta inmediata (encolado):
```json
{"result":{"id":"6858fb71-e314-4c6d-85b2-04be660567d1","video_input_id":null,"youtube_url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","status":"queued","fail_reason":null,"video_s3_url":null,"scenes":null,"created_at":"2026-08-07T21:38:18.931420Z","updated_at":"2026-08-07T21:38:18.931426Z"}}
```
Tras ~14s, `video_analysis_status` con `status:"completed"` — **forma real de la respuesta**:
```json
{"result":{"id":"6858fb71-e314-4c6d-85b2-04be660567d1","video_input_id":null,"youtube_url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","status":"completed","fail_reason":null,"video_s3_url":null,"scenes":[
  {
    "audio":"All right, so here we are in front of the elephants. The cool thing about these guys is that they have really, really, really...",
    "label":"Opening Hook",
    "visual":"A young man in his early twenties with short, dark brown hair and a light complexion stands outdoors at a zoo. He is wearing a navy blue t-shirt and a loose-fitting red and grey jacket. He is positioned in the center of the frame, facing the camera. Behind him is an elephant enclosure featuring large grey rock walls and a metal fence. Two African elephants are visible in the background, standing on a dirt surface with some hay. The camera is handheld, exhibiting a subtle natural shake. The lighting is soft and natural, typical of an overcast day. The man looks directly into the lens and begins to speak.",
    "shot_type":"Medium Close-Up",
    "scene_number":1,
    "timestamp_end":"0:09",
    "timestamp_start":"0:00"
  },
  {
    "audio":"...long trunks. And that's, that's cool. And that's pretty much all there is to say.",
    "label":"Usage Scenarios",
    "visual":"The same man continues speaking to the camera. He gestures with his right hand, lifting it to waist height with palm open. He briefly turns his head over his left shoulder to look back at the elephants in the background before returning his gaze to the camera. The handheld camera movement persists as he concludes his statement and maintains a slight smile.",
    "shot_type":"Medium Close-Up",
    "scene_number":2,
    "timestamp_end":"0:19",
    "timestamp_start":"0:09"
  }
],"created_at":"2026-08-07T21:38:18.931420Z","updated_at":"2026-08-07T21:38:32.319498Z"}}
```

### b) Con vídeo propio subido (`finn-B-pausa.mp4`, 938 KB, de `scripts-out/03-motorola/montaje/`)

Flujo: `media_upload` (devuelve `upload_url` presignada) → `curl -X PUT` con los bytes del fichero → `media_confirm` → `video_analysis_create` con `video_input_id`. Funcionó igual de bien, ~15s para completar:
```json
{"result":{"id":"db0ae26a-963c-4e69-aaf5-d1b14fe0e194","video_input_id":"55268f14-0141-435a-a6b6-728fc10e1b31","youtube_url":null,"status":"completed","fail_reason":null,"video_s3_url":"https://d2ol7oe51mr4n9.cloudfront.net/user_.../55268f14-....mp4","scenes":[
  {"audio":"Upbeat, low-fidelity hip hop instrumental plays at a low volume. A professional, clear male voiceover speaks...","label":"Opening Hook","visual":"A Caucasian male in his late 20s with short, wavy strawberry-blonde hair...sits at a dark wood grain desk, gesturing with his hands...","shot_type":"Medium Close-Up","scene_number":1,"timestamp_end":"0:03","timestamp_start":"0:00"},
  {"audio":"The instrumental music continues. The male voiceover says...","label":"Usage Scenarios","visual":"The camera executes a smooth tracking pan to the right combined with a slow zoom...","shot_type":"Medium Shot","scene_number":2,"timestamp_end":"0:06","timestamp_start":"0:03"}
],"created_at":"2026-08-07T21:41:10.075168Z","updated_at":"2026-08-07T21:41:25.431027Z"}}
```

**Qué devuelve exactamente:** ni transcripción plana ni un resumen — un **array de "scenes"** (planos), cada uno con:
- `scene_number`, `timestamp_start` / `timestamp_end`
- `shot_type` (p. ej. "Medium Close-Up", "Medium Shot" — vocabulario de plano cinematográfico real)
- `visual`: descripción muy detallada del encuadre, sujeto, vestuario, iluminación, paleta de color, movimiento de cámara
- `audio`: lo que se dice/oye en ese tramo (funciona como transcripción por segmento, no palabra por palabra con timestamps finos, pero suficiente para saber el guion de cada plano)
- `label`: una etiqueta de función narrativa (p. ej. "Opening Hook", "Usage Scenarios") — Higgsfield está aplicando una plantilla de vídeo-marketing/UGC a la estructura, útil incluso para documental porque identifica arranque vs. desarrollo.

**Coste medido: 0 créditos** en ambas pruebas (ni `balance` ni `transactions` mostraron cargo). Está incluido gratis en el plan Ultra (o al menos no factura aparte).

**Veredicto: SÍ sirve, y es la vía directa que se pedía.** Con solo pegar la URL de YouTube de un vídeo de referencia se obtiene una lista de planos con tipo de encuadre, descripción visual y lo que se dice — exactamente el "vocabulario" para extraer estilo de un vídeo de referencia. Limitación real declarada por la propia herramienta: cuanto más largo el vídeo, menos fiable el desglose por planos ("short clips give the most reliable results") — para un episodio de referencia largo habría que trocearlo antes o aceptar un resumen menos fino.

---

## 2. `personal_clipper_create` + `personal_clipper_status` — funciona, pero NO es una vía de análisis

**Qué acepta:** de verdad URLs de YouTube (`urls: [...]`, hasta 100), más `clips_num`, `clip_aspect` (9:16/1:1/16:9) y `subtitle_font`. No hay opción de analizar-sin-generar: siempre produce clips de vídeo montados (con subtítulos), no texto/metadatos.

### Prueba a) vídeo de 19s ("Me at the zoo"), `clips_num:1`
Encolado, cargo inmediato de **1.54 créditos**. A los ~20s terminó con:
```json
{"result":{"row_id":"024af6c4-280d-43f6-8cda-46f16fe556c7","url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","status":"done","progress_status":"Created clips","video_id":"jNQXAC9IVRw","clip_aspect":"9:16","subtitle_font":"inter","clips_num":1,"clips_expected":0,"clips_created":0,"clips":null,"error":null}}
```
`clips_expected` bajó a 0 y no se generó ningún clip (vídeo demasiado corto/sin "momento clipeable"). Los 1.54 créditos se **reembolsaron automáticamente**:
```json
{"display_name":"Clipify","credits":1.54,"action":"refund","created_at":"2026-08-07T21:40:26.425022Z"}
```

### Prueba b) segundo vídeo de YouTube (~3 min, con voz/narrativa), `clips_num:1`
Cargo inmediato de **5.42 créditos**. Estuvo en `status:"processing"` / `progress_status:"Creating clips"` durante varios minutos (coherente con el aviso propio de la herramienta de que puede tardar **hasta 30+ minutos**) y finalmente terminó con `status:"done"` y **1 clip real generado**, con **2.01 créditos reembolsados** (coste neto: 3.41 créditos). Forma real de la respuesta final:
```json
{"result":{"row_id":"75928ce9-...","status":"done","progress_status":"Created clips","clips_expected":1,"clips_created":1,"clips":[{
  "clip_index":0,
  "status":"done",
  "title":"The Blade That Shed Innocent Blood",
  "hook":"this blade has a dark past",
  "why":"Dark weapon lore, immediate danger, a dragon quest, and a lonely-hunter confession make this the strongest scroll-stop in an otherwise music-heavy transcript.",
  "score":8.1,
  "clip_type":["Cinematic Hook","Mystery Hook","Stakes Hook"],
  "context_risk":"low",
  "start_seconds":106.2,
  "end_seconds":154.8,
  "duration_seconds":48.6,
  "byte_size":8459435,
  "subtitled":true,
  "cdn_url":"https://d8j0ntlcm91z4.cloudfront.net/clipify/user_.../clips/clip_01.mp4"
}],"error":null}}
```

**Coste medido: 1.54–5.42 créditos cobrados al encolar por vídeo**, con reembolso automático parcial o total según cuántos clips realmente produce (coste neto real: 0 créditos si no encuentra nada clipeable, ~3.41 créditos por el clip de esta prueba).

**Veredicto: NO es la herramienta para "convertir un vídeo en información analizable" en el sentido de plano-a-plano, pero da un dato que `video_analysis_create` no da.** Su output principal sigue siendo vídeo montado en vertical con subtítulos (contenido para republicar). Pero de propina, cada clip trae metadatos de tipo "por qué funciona": `hook` (frase de gancho), `why` (justificación editorial), `score` (0-10), `clip_type` (etiquetas de género de gancho) y `context_risk`. Es vocabulario aprovechable para analizar qué momento de un vídeo de referencia "engancha", pero solo aparece si el vídeo tiene un momento recortable — para eso hay que esperar minutos y pagar créditos reales, y sigue sin describir planos/encuadres como sí hace `video_analysis_create`.

---

## 3. `virality_predictor` — sirve como complemento cuantitativo, no como analizador de planos

**Qué acepta:** `medias: [{role:"video", id: <media_id confirmado o job_id de generación completada>}]`. Se probó con un vídeo importado vía `media_import_url` (ver más abajo) — el `media_id` devuelto por el import sirvió directamente sin pasos adicionales de confirmación.

Llamada:
```json
{"action":"create","params":{"model":"virality_predictor","medias":[{"role":"video","id":"dcb28248-a2a5-4fd8-93e7-ea3bd98446f1"}]}}
```
→ `{"job_id":"3461fe31-...","model":"virality_predictor","poll_interval":1.5}`

Tras ~15s, `job_status` con `sync:true` devolvió (recortado a lo relevante, **forma real**):
```json
{"generation":{"id":"3461fe31-...","status":"completed","model":"brain_activity","params":{
  "video_meta":{"duration":5.055,"frame_rate":29.97,"frames_count":150},
  "analysis":{
    "scores":{"sustain":100,"hook_score":39,"peak_score":0.562515,"peak_second":5,"overall_score":55,"viral_potential":54,"brain_engagement":50,"peak_frame_index":5},
    "regions":[
      {"id":"visual_occipital","title":"Visual Cortex","mean_score":0.489695,"peak_score":0.526595,"peak_second":0,"values_by_frame":[0.526595,0.516137,0.485338,0.46732,0.469027,0.473752]},
      {"id":"auditory_temporal","title":"Auditory / Temporal","mean_score":0.451573,"peak_score":0.54929,"peak_second":5},
      {"id":"language_frontotemporal","title":"Language Network","mean_score":0.466472,"peak_score":0.50337,"peak_second":5},
      {"id":"frontoparietal_attention","title":"Frontoparietal / Attention","mean_score":0.558567,"peak_score":0.648777,"peak_second":5},
      {"id":"default_mode","title":"Default Mode","mean_score":0.581821,"peak_score":0.637983,"peak_second":2,"lower_better":true}
    ],
    "score_details":{"disclaimer":"Predictive proxy metrics, not guaranteed performance or clinical measures.","normalization":"scores are normalized prediction proxies in range 0..100","hook_window_seconds":[0,3]}
  }
},"results":{"rawUrl":"https://.../hf_..._3461fe31-....html"}}}
```

**Qué devuelve:** métricas numéricas (`hook_score`, `overall_score`, `viral_potential`, `sustain`, `peak_second`) más un desglose por "regiones cerebrales" simuladas (visual, auditiva, lenguaje, atención, default-mode) con series por frame — es un dashboard visual estilo "actividad cerebral", con el propio disclaimer de que son **proxies predictivos, no medición real ni garantía de rendimiento**. También entrega una URL HTML con el dashboard interactivo.

**Coste medido: 0 créditos** en esta prueba (sin cargo en `balance`/`transactions`).

**Veredicto: útil como complemento, no como sustituto.** Da vocabulario cuantitativo (gancho 0-100, segundo de pico de atención, "sustain") que sí se puede aplicar a guiones, pero no describe planos ni contenido — hay que combinarlo con `video_analysis_create` para tener tanto el qué (planos/encuadres) como el cuánto (score de gancho/retención).

---

## 4. `media_import_url` — utilidad de soporte, no de análisis

Importa una URL de fichero de vídeo/imagen/audio directo (no una página de YouTube) a storage de Higgsfield y devuelve un `media_id` listo para usar en otras herramientas (incluida `virality_predictor`). Probado con un mp4 de muestra:
```json
{"media_id":"dcb28248-a2a5-4fd8-93e7-ea3bd98446f1","type":"video","content_type":"video/mp4","source_url":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"}
```
**Coste: 0 créditos.** No analiza nada por sí sola — es el paso previo para poder darle un vídeo externo a `virality_predictor` (que exige `media_id`, no URL directa). No acepta URLs de páginas de YouTube, solo enlaces directos a un fichero de medio.

---

## Coste total medido

| Herramienta | Prueba | Coste bruto | Coste neto |
|---|---|---|---|
| `video_analysis_create` (YouTube) | vídeo 19s | 0 créditos | 0 |
| `video_analysis_create` (subida propia) | `finn-B-pausa.mp4` | 0 créditos | 0 |
| `personal_clipper_create` | vídeo 19s, 1 clip pedido, 0 producidos | 1.54 | 0 (reembolso total) |
| `personal_clipper_create` | vídeo ~3min, 1 clip pedido, 1 producido | 5.42 | 3.41 (reembolso parcial 2.01) |
| `virality_predictor` | vídeo de 5s importado | 0 créditos | 0 |
| `media_import_url` | import de mp4 externo | 0 créditos | 0 |
| **Total neto gastado** | | | **3.41 créditos** (de 30 autorizados) |

Saldo verificado: 2306.00 → 2302.59 créditos (con dos reembolsos intermedios de Clipify registrados en `transactions`).

## Recomendación

**Usar `video_analysis_create` como vía principal para analizar un vídeo de referencia de YouTube.** Acepta la URL directamente, es gratis, tarda segundos-minutos y devuelve exactamente lo necesario para extraer estilo: plano por plano, con `shot_type`, descripción visual detallada y lo dicho en el audio. Para vídeos de referencia largos, trocear primero (o pasar solo el tramo relevante) porque la propia herramienta pierde precisión cuanto más dura el vídeo.

**Añadir `virality_predictor` como capa opcional** cuando se quiera cuantificar gancho/retención de un vídeo de referencia (o de nuestro propio corte) — gratis en esta prueba y da métricas 0-100 aplicables a guion, aunque son "proxies" declarados, no datos de audiencia real.

**Descartar `personal_clipper_create` para este caso de uso.** No es una herramienta de análisis: produce clips de vídeo verticales con subtítulos, tarda minutos-a-30 min, cuesta créditos reales (1.5-5.5+ por vídeo) y no aporta ningún dato estructurado sobre el vídeo. Solo tendría sentido si el objetivo fuera trocear un vídeo en clips para reutilizar como metraje, no para analizarlo.

`media_import_url` es solo un paso de apoyo (gratis) para poder pasarle un vídeo externo (no-YouTube) a `virality_predictor`.
