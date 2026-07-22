# Eval framework

## Por qué existe
Sin esto, cualquier ajuste al prompt/modelo/threshold es a ojo. Con esto, podés decir "subí precision 12% cambiando el prompt" con números reales.

## Workflow (primera vez, ~1.5h de trabajo manual)

### 1. Bootstrap: agarrar 40 jobs reales para clasificar

```bash
cd ~/jobs-agent
bun eval/bootstrap.ts 40
```

Crea `eval/golden.unlabeled.json` con 40 jobs (muestreados de varias companies, no todos de la misma).

### 2. Clasificar manualmente (~1-1.5h)

Abrí `eval/golden.unlabeled.json` en tu editor. Por cada job, completá:

```json
{
  "label": "yes",                    // yes / no / maybe
  "expectedScore": 8,                // 1-10, tu score honesto
  "expectedMatchType": "stretch",    // direct / stretch / reach / skip
  "reason": "Pide design eng + AI, mi sweet spot exacto aunque dice Software Engineer"
}
```

**Reglas de oro para labelear**:
- **yes**: aplicarías a esto. Vale tu tiempo.
- **no**: no aplicarías. Wrong stack, wrong tier, wrong location, etc.
- **maybe**: dudoso (probablemente lo skipearías en LinkedIn pero podría ser interesante).

No te preocupes por ser consistente al 100%. Tu intuición es la verdad para este eval.

Cuando termines, renombrá el archivo:
```bash
mv eval/golden.unlabeled.json eval/golden.json
```

### 3. Correr eval

```bash
bun eval/run.ts
```

Output (stderr):
```
========== METRICS ==========
Labeled: 40 (yes: 12, no: 26)

Triage (¿captura los buenos? ¿rechaza los malos?):
  Precision: 75.0% — cuando dijo "yes", acertó
  Recall:    83.3% — capturó los "yes" reales
  F1:        78.9%
  ⚠️  False negatives (perdidos): 2/12
  ⚠️  False positives (ruido): 4/26

Score MAE: 1.42
Match type accuracy: 67.5%

========== FAILURES ==========
Datadog / Senior Software Engineer
  Expected: yes (8/stretch)
  Got:      triage=5/direct — "Frontend role but mostly backend in description"
...
```

Resultados completos en `eval/results/{timestamp}.json`.

### 4. Iterar con data

Mirá los failures. Patrones típicos:
- **Muchos false negatives** (perdidos): el prompt es muy conservador. Ajustá la rubric.
- **Muchos false positives** (ruido): es muy permisivo. Endurecé criterios.
- **Score MAE > 2**: la calibración numérica está mal, no la decisión binaria.
- **Match type accuracy baja**: el modelo no distingue direct/stretch bien. Más ejemplos en el prompt.

Hacé un cambio, corré eval otra vez. Compará métricas. Si subió → keep. Si bajó → revertí.

## Workflow recurrente (mensual)

Cada mes, agregá 10-20 jobs nuevos al golden set con tus labels. Esto:
- Detecta drift (¿el agente sigue funcionando bien con jobs recientes?)
- Captura cambios en tu criterio (capaz ahora querés más AI roles, o menos hybrid)

## Comparar configuraciones

Si querés probar Sonnet en triage (en vez de Haiku):

1. Copiá agent.ts → agent-sonnet.ts, cambiá `models.triage`
2. Modificá eval/run.ts para importar de ahí
3. Corré con `bun eval/run.ts sonnet-triage`
4. Compará `eval/results/*-default.json` vs `eval/results/*-sonnet-triage.json`

Métricas a comparar: F1 (calidad), MAE (calibración), costo total estimado.

## Honest caveats

- 40 jobs es el mínimo. Con menos, ruido alto, métricas no confiables.
- Tu labeling tiene sesgo (cansancio, mood). Considera labelear en 2 sesiones.
- El golden set se desactualiza: companies cambian, mercado cambia, tu criterio cambia. Refrescá.
- Esto NO te dice "el modelo está aprendiendo" — Haiku no aprende. Te dice "esta config performa así contra tu criterio".
