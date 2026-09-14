# agent

O grafo do agente: extração de entidade → planner → busca (fatos + vetorial, com os dois loops
de feedback) → redator → crítico. Orquestração à mão — funções `async` comuns, sem framework.

`graph.ts` é o grafo; `nodes/` tem um arquivo por nó (`extract-entity`, `plan`, `grade`, `critic`);
`state.ts` define o estado que atravessa o grafo; `trace.ts` formata o traço impresso pelo CLI.

Implementação: ver `docs/tasks/00-vertical-slice.md` (o grafo original) e
`docs/tasks/06-feedback-loops.md` (grading de documentos + self-check da resposta).
