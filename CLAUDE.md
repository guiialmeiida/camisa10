# CLAUDE.md

Contexto para o Claude Code continuar este projeto.

## O que é este projeto
RAG sobre futebol, **feito para o usuário aprender RAG**. Um índice vetorial único consultado por
um agente multi-etapa, atendendo dois casos de uso:
1. **Rodada atual** — perguntas sobre a rodada em andamento de um campeonato.
2. **Forma do time** — perguntas sobre a fase recente de um time, com peso maior para os jogos
   mais recentes (decaimento temporal).

Arquitetura, tabela de modelos por etapa e o registro das decisões: `docs/architecture.md`.

## Como trabalhar neste repo

- O setup inicial (package.json, estrutura de pastas, config de ambiente, teste de fumaça) já
  está pronto. **Não reimplemente isso.**
- **Implementar ensinando.** O objetivo do usuário é aprender RAG, não receber código pronto.
  Explique o conceito antes/junto do código, e registre-o em `docs/learning/` (um doc por
  peça, terminando com "Por que não X?"). Clareza didática vale mais que esperteza.
- O trabalho está quebrado em tarefas em `docs/tasks/`, nesta ordem:
  `00-vertical-slice.md` → `01-data-sources.md` → `02-ingestion-pipeline.md` →
  `03-vector-index.md` → `04-current-matchweek-query.md` e `05-team-form-query.md` (essas
  duas em paralelo) → `06-feedback-loops.md`.
- Cada tarefa segue o modelo em `docs/tasks/TASK_TEMPLATE.md`: discovery → refinamento técnico →
  implementação → revisão → testes. Uma etapa por vez, registrando o resultado no próprio arquivo
  da tarefa. Não pule etapas.
- **Toda tarefa entrega algo que roda.** Se o que você planeja entregar não pode ser usado pelo
  usuário no fim da tarefa, o plano está errado.

### O ciclo de cada tarefa

O usuário só é acionado em dois pontos: quando o `refinador` deixa uma decisão em aberto, e para
revisar o PR já pronto no final. Entre esses dois pontos o ciclo roda sem parar para aprovação.

1. **Discovery** — conversa direta com o usuário, via skill `grill-me` (`.claude/skills/`).
   **Nunca delegue isso a um subagente**: as decisões são do usuário, e um subagente só adivinha
   defaults.
2. **Refinamento** — subagente `refinador` (Opus) escreve a spec técnica no arquivo da tarefa.
   **Se ele reportar decisão em aberto que depende do usuário, pare aqui e pergunte** — é o único
   ponto de parada antes do PR. Se a spec sair fechada, sem pendência, siga direto para a
   implementação, sem pedir aprovação explícita da spec.
3. **Implementação** — subagente `implementador` (Sonnet) é acionado automaticamente assim que a
   spec estiver fechada, contra a spec, sem reinterpretá-la. Depois que ele termina, você commita
   as mudanças localmente, em commit(s) coeso(s) — **sem** abrir PR ainda.
4. **Revisão local** — subagente `revisor` (Opus, adversarial) roda automaticamente sobre a
   working tree/branch local — **antes de existir PR**, sem `gh pr diff`/`gh pr review`. Relata
   achados a você, não comenta em nada público.
5. **Correção** — se houver achado, o `implementador` é reacionado com o relatório do `revisor`
   e corrige; você commita a correção como novo commit coeso na mesma branch. Depois o `revisor`
   roda de novo para confirmar. Repita até não haver mais achado, com um teto de **3 rodadas** —
   no teto, pare e leve o que ficou pendente para o usuário em vez de insistir sozinho.
6. **Abertura do PR** — só depois que a revisão local não tem mais achado (ou o teto da etapa 5
   foi atingido): `git push` e `gh pr create`. É o segundo e último ponto onde o usuário entra —
   para ler e aprovar o PR.

As tarefas 04 e 05 são independentes e é onde vale rodar agentes em paralelo.

## Regras de arquitetura

- **Regra de ouro: fatos exatos (placar, tabela) sempre vêm de chamada direta à API, nunca do
  índice vetorial/RAG.** O RAG é só para contexto e narrativa. Isso está no contrato das
  ferramentas do agente e é verificado em runtime pelo crítico (tarefa 06).
- Toda resposta gerada cita a fonte de onde a informação veio.
- Orquestração **à mão** — funções `async`, estado num objeto, `Promise.all` no paralelismo.
  Sem LangGraph/Mastra: framework esconde justamente o que o usuário quer ver.
- Nos loops de feedback, **no teto de tentativas o sistema responde, nunca falha** — com aviso
  de baixa confiança dizendo o que não foi encontrado.

## Convenções

### Git: branch e PR por tarefa
Cada tarefa de `docs/tasks/` vive numa branch própria e vira um PR. Nada vai direto para a `main`.

- **Branch**: `feat/NN-short-name` em inglês, derivada da tarefa — `feat/00-vertical-slice`,
  `feat/01-data-sources`. Correção fora de tarefa usa `fix/short-name`.
- **Vários commits por tarefa**, cada um coeso. Não amontoe a tarefa inteira num commit só.
- **O `revisor` roda em local, antes do PR existir**, sobre a branch/working tree — não usa
  `gh pr diff`/`gh pr review`. Achado dele vira correção do `implementador` como novo commit
  coeso na mesma branch; o teto dessa volta é 3 rodadas (ver "O ciclo de cada tarefa").
- **O PR só abre depois que a revisão local não tem mais achado** (ou o teto de rodadas foi
  atingido). Título no mesmo formato Conventional Commits do commit; descrição em inglês, ligando
  à tarefa (`docs/tasks/NN-....md`) e dizendo o que mudou e como verificar.
- **A partir daqui o veredito é do usuário.** Se o usuário pedir mudança na revisão do PR, ela
  também vem como novo commit — nunca `--amend` em commit já publicado: force-push num PR aberto
  apaga o contexto dos comentários existentes.
- **Merge só com o `npm test` verde e com o usuário aprovando.**

### Git: Conventional Commits, em inglês
Mensagem de commit, título de PR e descrição de PR são **em inglês** e seguem
[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`.

- Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `perf`.
- Escopo é a peça tocada, quando houver: `sources`, `vectorstore`, `retrieval`, `generation`,
  `agent`, `ingestion`, `config`, `eval`.
- Assunto no imperativo e em minúscula, sem ponto final: `feat(agent): add entity extraction node`.
- Corpo explica **por quê**, não o quê — o diff já diz o quê.
- Uma tarefa de `docs/tasks/` costuma render vários commits; não junte tudo num só.

### Idioma: código em inglês, prosa em português
**Regra sem exceção.** Tudo que é identificador é em inglês; tudo que é explicação é em português.

- **Em inglês**: nomes de função, método, variável, classe, arquivo e diretório; campos de
  schema e chaves de JSON; nomes de teste (`describe`/`it`); mensagens de erro e de log;
  comentários no código.
- **Em português**: o *conteúdo* das specs em `docs/tasks/`, dos docs em `docs/learning/`, do
  `README.md` e do `architecture.md`, e a conversa com o usuário.

**Atenção:** nome de arquivo e de diretório é identificador, então é inglês **mesmo quando o
conteúdo é português** — `docs/tasks/00-vertical-slice.md` contém prosa em português e tem nome
em inglês. Nome de branch segue a mesma regra.

Um schema é código: `{ homeTeam, awayTeam, score }`, não `{ time_casa, time_fora, placar }`.
Termos de domínio traduzem — `trecho` → `passage`, `rodada` → `matchweek`, `fatos` → `facts`,
`nó` → `node`. Quando a tradução for ambígua, fixe-a no glossário de `docs/architecture.md`
em vez de decidir de novo a cada arquivo.

- **Node.js >= 22.18, TypeScript, ESM** (`"type": "module"`). Sem build step: o Node executa
  `.ts` direto por type stripping nativo. Consequências que o `tsconfig.json` já impõe:
  - só sintaxe apagável (`erasableSyntaxOnly`) — **sem `enum`, sem `namespace`**, sem parameter
    properties;
  - `import type` obrigatório para importar tipo (`verbatimModuleSyntax`);
  - **import relativo usa a extensão `.ts` real** (`from "./config/env.ts"`), não `.js`.
- **Verificação de tipo é passo separado**: `npm run typecheck` (`tsc --noEmit`), e `npm test`
  roda o typecheck antes do vitest. O Node apaga os tipos sem checá-los — sem esse passo,
  TypeScript não te protege de nada.
- **`zod` nas fronteiras, tipos comuns por dentro.** Onde o dado vem de fora (env, resposta da
  API, carga de fixture) o schema é `zod` e o tipo sai de `z.infer` — uma definição só, sem
  divergência possível. Entre os nós do agente, `interface`/`type` comuns: validar de novo um
  objeto que você acabou de construir é cerimônia. Tipo é promessa de compilação; validação é
  verificação em runtime, e só dado externo precisa da segunda.
- Variável de ambiente nova entra no schema de `src/config/env.ts` **e** no `.env.example`.
- Testes com `vitest`, um arquivo de teste por módulo em `tests/`.
- Modelos por etapa centralizados em `src/config/models.js` (criado na tarefa 00), uma linha por
  etapa, para serem trocados e medidos.

## Próximo passo sugerido
As 7 tarefas do plano (`00-vertical-slice` a `06-feedback-loops`) estão implementadas e
mergeadas. Não há próxima tarefa planejada em `docs/tasks/` — próximo passo é o que o usuário
decidir (dívida técnica registrada nas tarefas, feature nova, ou revisão geral).
