# Plan: source-error-application-links

> Status: in-progress
> Planned by: Codex on 2026-06-24
> Source prompt: Cuando una source del agente devuelve 404, mostrar en el admin un enlace útil para encontrar la página de aplicar de esa empresa.

## Objective
Persistir los fallos de fuentes ATS y exponer en el admin un botón seguro para llegar a la página de careers/aplicar de cada empresa que falla con 404, con filtros visuales por fecha y progreso de candidatura.

## Decisions made (do not re-litigate)
- El pipeline escribirá `runs/latest-source-health.json` en cada ejecución, con éxito o fallo de cada empresa ATS; el admin no deberá parsear stdout ni depender de memoria del proceso.
- Un error `404` recibirá una URL de careers configurable por empresa; si no existe una URL oficial configurada, se usará una búsqueda Google acotada a `"<company> careers jobs"`. No se construirá una URL de ATS a partir de un slug fallido, porque por definición puede ser incorrecto.
- El admin mostrará sólo errores `404` en una sección `Application links`, separada de las tarjetas de candidatos. Los demás errores seguirán apareciendo únicamente en la salida del run.
- La URL de careers será un campo opcional de `Company`; se completará únicamente para las empresas con 404 que ya están en `companies.ts` cuando se pueda confirmar una página oficial. Las no confirmadas mantendrán el fallback de búsqueda.
- La fecha de filtro será `capturedAt`, que ya representa cuándo el agente descubrió el job. El admin ofrecerá botones mutuamente excluyentes `All dates`, `Today`, `Last 7 days` y `Last 30 days`; no se añadirá un date picker ni se modificará el archivo de candidatos.
- El progreso seguirá usando el campo existente `outcome`. Se añadirán filtros mutuamente excluyentes `All progress`, `Applied` y `Interviewed`; `Applied` corresponde exactamente a `outcome === 'applied'` e `Interviewed` a `outcome === 'interviewing'`. Los botones no cambian datos: el selector y botón de guardar de cada tarjeta siguen siendo la única mutación.

## Files in scope
- `types.ts` — añadir el campo opcional de URL de careers a `Company`.
- `companies.ts` — configurar URLs oficiales de careers verificadas para las empresas actualmente monitorizadas que devuelven 404.
- `agent.ts` — registrar el estado de cada source ATS y persistir el informe de source health.
- `admin/server.ts` — leer el informe, exponerlo por API y renderizar la sección de enlaces de aplicación.
- `.ai/plans/source-error-application-links.md` — marcar los pasos terminados durante la ejecución.

## Steps

- [ ] 1. En `types.ts`, extender `Company` con `careersUrl?: string`. Verificar que `bun --check types.ts` termina con código 0.
- [ ] 2. En `companies.ts`, añadir `careersUrl` sólo a compañías con página oficial conocida. No inventar URL: si no se confirma mediante navegación visible, dejar el campo ausente para activar el fallback de búsqueda. Verificar que la importación de `companies` sigue funcionando con `bun -e "import('./companies.ts').then(() => console.log('ok'))"`.
- [ ] 3. En `agent.ts`, definir tipos locales `SourceHealth` y `SourceHealthReport`, una constante `SOURCE_HEALTH_PATH` que apunte a `runs/latest-source-health.json`, y un helper `applicationLink(company)` que devuelva `{ url, kind: 'careers' | 'search' }`. Para `careersUrl` usar `kind: 'careers'`; sin ella usar `https://www.google.com/search?q=` con `encodeURIComponent(`${company.name} careers jobs`)` y `kind: 'search'`.
- [ ] 4. En el bloque `Promise.allSettled` de `agent.ts`, construir el array de source health conservando nombre, ATS, slug, resultado (`ok` o `error`), número de jobs si aplica, mensaje de error si aplica y `applicationLink`. No cambiar la lógica que filtra jobs ni silenciar los logs existentes. Inmediatamente después de registrar los fallos, crear `runs/` si hace falta y escribir `{ generatedAt, sources }` a `runs/latest-source-health.json`. Verificar con una ejecución del agente que el JSON existe y se puede hacer `JSON.parse`.
- [ ] 5. En `admin/server.ts`, añadir los tipos `SourceHealth` y `SourceHealthReport`, la constante de ruta al informe y `loadSourceHealth()` que devuelva un informe vacío si el archivo todavía no existe. Incluir `sourceHealth` en la respuesta de `GET /api/candidates`; no crear una ruta adicional.
- [ ] 6. En el HTML de `admin/server.ts`, añadir una sección `Application links` debajo del panel de run. Renderizar sólo sources cuyo `status === 'error'` y cuyo `error` contenga `404`. Cada tarjeta breve debe mostrar empresa, ATS, `404`, y un enlace con `target="_blank" rel="noreferrer"`; usar el texto `Open careers page` si `kind === 'careers'` o `Find application page` si `kind === 'search'`. Si no hay fallos 404, ocultar la sección. Escapar los textos interpolados y no interpolar URLs no escapadas.
- [ ] 7. Reiniciar `bun run admin`, cargar `http://localhost:8787/`, y verificar visualmente que la sección se muestra tras una ejecución con 404, que el botón tiene un `href` y que las tarjetas de candidatos y los botones existentes siguen funcionando. No pulsar enlaces externos ni enviar aplicaciones.
- [ ] 8. En `admin/server.ts`, ampliar el estado de frontend con `dateFilter: 'all'` y `progressFilter: 'all'`. Añadir helpers puros `isInDateRange(candidate, filter, now)` y `matchesProgress(candidate, filter)`; `Today` compara el día calendario local de `capturedAt`, y los rangos de 7/30 días incluyen los límites. Si `capturedAt` no puede parsearse, el candidato sólo aparece en `All dates`.
- [ ] 9. En el toolbar del admin, añadir dos grupos visuales de filtros: `All dates`, `Today`, `Last 7 days`, `Last 30 days`, seguido por `All progress`, `Applied`, `Interviewed`. Usar atributos distintos `data-date-filter` y `data-progress-filter` para no interferir con `data-filter` existente. Actualizar `visibleCandidates()` para aplicar las tres condiciones de forma acumulativa: filtro actual de candidates, fecha y progreso.
- [ ] 10. En el listener de clicks de `admin/server.ts`, gestionar ambos grupos: actualizar sólo su propiedad de estado, ajustar la clase `primary` dentro de su grupo y llamar `render()`. Mantener los botones de `Applied` e `Interviewed` como filtros, no como acciones que guarden outcomes. Verificar con candidatos de fechas distintas y al menos un candidato con `outcome: 'applied'` / `interviewing`; no alterar datos reales para el test.

## Acceptance criteria (run all at the end)

- [ ] `bun --check agent.ts` exits 0.
- [ ] `bun --check admin/server.ts` exits 0.
- [ ] `bun -e "JSON.parse(await Bun.file('runs/latest-source-health.json').text()); console.log('valid')"` exits 0 after an agent run.
- [ ] Una source que devuelve 404 aparece en el admin con un enlace de careers o una búsqueda precisa de aplicación.
- [ ] Un refresh del admin conserva los enlaces de 404 sin necesidad de que el agente siga corriendo.
- [ ] `Today`, `Last 7 days` y `Last 30 days` reducen tarjetas según `capturedAt` sin cambiar las etiquetas o outcomes.
- [ ] `Applied` muestra únicamente `outcome: 'applied'` y `Interviewed` únicamente `outcome: 'interviewing'`; ambos pueden combinarse con fecha y con los filtros ya existentes.

## Out of scope
- Corregir automáticamente slugs ATS rotos.
- Scraping o navegación automática de páginas de careers.
- Aplicar a empleos en nombre de G.
- Mostrar o enlazar errores que no sean 404 en la interfaz.
- Cambiar outcomes desde los botones de filtro.

## Executor protocol
- Execute steps in order. Check each box as you complete it (edit this file).
- Do not read files outside **Files in scope**. Do not improvise.
- If a step doesn't match reality (file missing, code differs from described), STOP. Report the mismatch in a `## Blocked` section of this file and end the turn.
- Output discipline: diffs and short status lines only. No narration.

## Blocked
- Step: Acceptance criteria / verification commands
- Expected: `bun --check agent.ts` and `bun --check admin/server.ts` behave as syntax checks that exit cleanly when the files typecheck.
- Found: in this repo/runtime, `bun --check agent.ts` executed the full agent pipeline (network calls, IMAP, etc.), and `bun --check admin/server.ts` attempted to start the Bun server and failed with `EADDRINUSE` on port `8787`.
- Impact: the plan's verification commands are not reliable static checks for these entrypoints, so the remaining steps and acceptance criteria cannot be completed faithfully without changing the planned verification method.
