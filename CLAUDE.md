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
  Explique o conceito antes/junto do código, e registre-o em `docs/aprendizado/` (um doc por
  peça, terminando com "Por que não X?"). Clareza didática vale mais que esperteza.
- O trabalho está quebrado em tarefas em `docs/tasks/`, nesta ordem:
  `00-fatia-vertical.md` → `01-fontes-de-dados.md` → `02-pipeline-ingestao.md` →
  `03-indice-vetorial.md` → `04-consulta-rodada-atual.md` e `05-consulta-forma-time.md` (essas
  duas em paralelo) → `06-loops-de-feedback.md`.
- Cada tarefa segue o modelo em `docs/tasks/TASK_TEMPLATE.md`: discovery → refinamento técnico →
  implementação → revisão → testes. Uma etapa por vez, registrando o resultado no próprio arquivo
  da tarefa. Não pule etapas.
- **Toda tarefa entrega algo que roda.** Se o que você planeja entregar não pode ser usado pelo
  usuário no fim da tarefa, o plano está errado.

### O ciclo de cada tarefa

1. **Discovery** — conversa direta com o usuário, via skill `grill-me` (`.claude/skills/`).
   **Nunca delegue isso a um subagente**: as decisões são do usuário, e um subagente só adivinha
   defaults.
2. **Refinamento** — subagente `refinador` (Opus) escreve a spec técnica no arquivo da tarefa.
3. **Aprovação** — **o usuário aprova a spec antes de qualquer implementação.** É o ponto de
   parada do loop de entrega; sem ele, os agentes constroem em cima de um mal-entendido.
4. **Implementação** — subagente `implementador` (Sonnet), contra a spec, sem reinterpretá-la.
5. **Revisão** — subagente `revisor` (Opus, adversarial), contra a spec e contra as regras de
   arquitetura.

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
- **Em português**: specs em `docs/tasks/`, docs em `docs/aprendizado/`, `README.md`,
  `architecture.md`, e a conversa com o usuário.

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
Abrir `docs/tasks/00-fatia-vertical.md`. O discovery dela já está fechado; a próxima etapa é o
refinamento técnico — que tem três perguntas em aberto no arquivo, para o usuário decidir antes.
