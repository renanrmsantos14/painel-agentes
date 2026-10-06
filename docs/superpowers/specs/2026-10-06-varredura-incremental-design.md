# Varredura incremental: abrir na hora, vigiar arquivos, cache em disco

Data: 06/10/2026 · Projeto: Painel Agentes (Tauri 2 + Rust + TS)

## Problema

Medido em 06/10/2026 nesta máquina (cada processo `git` custa ~300 ms):

- Abertura fria: ~730 processos git. Os chats só aparecem depois de ~70 s; as pendências depois de 3–5 min. Até lá a tela mostra só o esqueleto.
- Repouso: a cada 45 s o app roda `git status` em ~60 pastas (~4 s de CPU), mesmo sem nada ter mudado.
- Trabalho duplicado: `git status` roda duas vezes por pasta (varredura de chats e varredura de pendências); `for-each-ref` idem por repositório.

## Objetivos

1. Abrir o app e ver o painel completo em < 1 s, com o último estado conhecido do Git, e cada linha se atualizando conforme o git responde.
2. Em repouso, custo próximo de zero: só rodar git onde um arquivo mudou.
3. Uma única leitura de `status` e de refs por pasta/repositório por ciclo, compartilhada entre chats e pendências.
4. Caches sobrevivem ao fechar/abrir o app.

Fora de escopo: trocar `git` por libgit2; mudar ações (abrir chat, pasta, VS Code, remover worktree); mudar o visual além do indicador "reverificando".

## Arquitetura

### Backend (Rust)

**`cache.rs` — caches em memória com persistência**

- `STATUS: HashMap<dir, Entry<String>>` — saída de `git status --porcelain` por pasta, com timestamp. Única fonte para `Ctx::dir().dirty` (chats) e `pending::dirty()` (pendências).
- `REFS: HashMap<repo, Entry<Refs>>` — saída do `for-each-ref` unificado (locais + remotas + origin/HEAD), usada pelos dois módulos.
- `GITINFO: HashMap<run_id, GitInfo>` — último `GitInfo` calculado por chat (já existe como `CACHE`, passa a ser por id e persistido).
- `PENDING: Option<(ts, Vec<Pending>)>` — último resultado (já existe), persistido.
- Validade de segurança: entradas de `STATUS`/`REFS` expiram em 10 min mesmo sem evento do vigia.
- Persistência: `estado.json` em `app_data_dir()` com `GITINFO` e `PENDING`; gravado ao fim de cada varredura completa (debounce 2 s), lido no `setup`. Formato versionado (`"v": 1`); versão diferente ou JSON inválido = ignora.

**`watch.rs` — vigia de arquivos**

- Crate `notify` (ReadDirectoryChangesW no Windows), `RecommendedWatcher`, recursivo, em cada raiz de repositório conhecida (`pending::repos()`), inclusive as pastas de worktree listadas por `git worktree list`.
- Filtro de eventos: ignora caminhos contendo `node_modules`, `target`, `dist`, `.git/objects`, `.git/logs`, `.git/*.lock`, `.memsearch`, `.worktrees` (raiz já vigiada à parte).
- Classificação:
  - dentro de `.git/` (`HEAD`, `index`, `refs/**`, `packed-refs`, `worktrees/**`, `ORIG_HEAD`) → invalida `REFS[repo]`, `STATUS[worktree]` e a branch atual (`LOCS`) da worktree afetada;
  - qualquer outro caminho → invalida `STATUS[worktree]` da worktree que contém o caminho.
- Mapeamento caminho → worktree: lista de raízes ordenada por tamanho decrescente; primeira que é prefixo do caminho (comparação sem distinção de maiúsculas, separadores normalizados).
- Debounce 1,5 s por worktree; depois emite `fs-changed { dir }` para o frontend.
- Novas raízes entram no vigia a cada varredura de pendências (repositórios novos descobertos).
- Falha ao vigiar uma raiz (permissão, pasta removida) é registrada e ignorada: o app continua funcionando com os caches e a validade de 10 min.

**`lib.rs` — varredura em duas fases**

- `list_runs(days, archived)` passa a devolver imediatamente: sementes (JSON do Claude + SQLite do Codex) com `git = GITINFO[id]` (ou `None`) e `stale: true` quando o cache não é válido para as pontas atuais ou não existe.
- Depois do retorno, um job em segundo plano calcula `git_info` para cada semente (workers = `min(16, cpus*2)`), usando `STATUS`/`REFS` do cache. A cada ~200 ms emite `run-git { items: [{ id, git }] }` com o que ficou pronto. Ao terminar, grava `estado.json`.
- Um job por vez: se outro `list_runs` chega durante o cálculo, o job atual é reaproveitado (as sementes novas entram na fila; `AtomicBool` de "em andamento" + fila protegida por mutex).
- `list_pending(fresh)`: mantém o cache de 2 min, mas a varredura passa a usar `STATUS`/`REFS` compartilhados e tarefas achatadas `(repo, worktree)` em até 8 workers.
- Watcher de avisos (15 min) continua usando `pending_cached`.

### Frontend (TS)

- `load()` renderiza assim que `list_runs` responde. Linhas com `stale` recebem a classe `stale` (badge ligeiramente apagado + título "reverificando"); o resumo mostra "reverificando N pastas" enquanto houver linhas stale.
- `listen('run-git')`: aplica cada `{ id, git }` em `runs` (por id), marca `stale = false`, e agenda `link() + render()` com debounce de 150 ms.
- `listen('fs-changed')`: se a janela está visível, agenda `load()` com debounce de 1 s (agrupa várias pastas mudando juntas).
- O intervalo de 45 s continua, mas agora só custa a leitura dos arquivos de sessão (sem git até o vigia invalidar algo).

## Fluxo

1. App abre → lê `estado.json` → inicia vigia nas raízes conhecidas → janela.
2. Frontend chama `list_runs` → recebe chats + último Git em < 1 s → renderiza.
3. Backend calcula git em segundo plano → `run-git` em lotes → linhas atualizam.
4. Em repouso: nenhum git. Arquivo muda → vigia invalida o cache da worktree → `fs-changed` → frontend recarrega → só aquela pasta roda `git status` de novo.
5. Commit/checkout → eventos em `.git/` → refs e branch invalidadas → mesma cadeia.

## Erros

- Git ausente ou pasta removida: `GitInfo = None`, linha sem Git (comportamento atual).
- `estado.json` corrompido: ignorado, cache começa vazio.
- Vigia indisponível: app funciona como hoje, com a validade de 10 min.
- Evento `run-git` para id que não está mais na lista (filtro mudou): ignorado.

## Testes

- Rust: mapeamento caminho → worktree; classificação de evento (`.git/` vs arquivo de trabalho); expiração do cache; leitura/gravação de `estado.json` inválido; `remove_worktree` existente continua passando.
- Medição: `painel-agentes.exe --dump` frio e quente; contagem de processos git com `GIT_TRACE2`.
- Navegador (mock): linhas stale → atualizadas via evento simulado; nenhum erro no console.
- App instalado (pelo usuário): tempo até ver o painel; editar um arquivo no VS Code e ver a linha mudar; commit e ver a contagem mudar.

## Riscos e mitigação

- Volume de eventos em repositórios grandes: filtros de pasta + debounce; se ainda alto, limitar a profundidade (`notify` não suporta; alternativa: vigiar só worktrees ativas + `.git`).
- Watcher não cobre pastas em rede/OneDrive de forma confiável: validade de 10 min cobre.
- Estado antigo na abertura pode estar errado por alguns segundos: linha marcada como stale até reverificar.
