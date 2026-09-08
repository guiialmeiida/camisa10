# Tarefa 06: Loops de feedback

Fecha os dois loops descritos em `docs/architecture.md` § "Os dois loops de feedback". Depende
das tarefas 04 e 05 — os loops precisam de respostas reais para corrigir.

Até esta tarefa, o sistema responde **sem rede de proteção contra alucinação de placar**: a regra
de ouro vale por convenção e pelo contrato das ferramentas, mas nada a verifica em runtime.

## Status
- [x] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery

Concluído no grilling de 2026-09-08 (decisões 2 e 7 em `docs/architecture.md`).

O que está decidido:

- **Loop 1 — grading de documentos (*Corrective RAG*)**: um grader (`claude-haiku-4-5`) julga
  cada trecho recuperado, em paralelo, antes da geração. Se sobrar pouco, a query é reescrita e
  a busca refeita. **Teto: 2 reescritas.**
- **Loop 2 — self-check da resposta**: um crítico (`claude-opus-5`, effort `medium`) confere
  cada número da resposta contra os fatos vindos da API. **Teto: 1 refação.**
- **No teto, responder — nunca falhar.** A resposta sai marcada como baixa confiança, dizendo o
  que não foi encontrado.
- **Feedback humano persistido está fora de escopo.** Exige armazenar avaliações e um mecanismo
  para usar esse sinal; é projeto próprio.

Perguntas em aberto para o refinamento:

- Qual o critério de "sobrou pouco" que dispara a reescrita — número absoluto de trechos
  aprovados, ou proporção?
- A query reescrita é gerada por qual modelo, e vê o motivo da reprovação do grader?
- Como o crítico distingue um número que veio da API de um que o redator inventou — comparação
  literal, ou julgamento do modelo?
- O traço da CLI mostra as tentativas descartadas? (para aprendizado, provavelmente sim)

## Refinamento técnico
_A preencher._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
