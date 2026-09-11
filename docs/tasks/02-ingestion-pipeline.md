# Tarefa 02: Pipeline de ingestão

Corresponde ao nó "Pipeline de ingestão" do diagrama em `docs/architecture.md`. Depende das
tarefas 00 e 01: **substitui a ingestão de uma linha da fatia vertical por um pipeline real.**

## Status
- [x] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery

Concluído no grilling de 2026-09-11. As quatro perguntas originais mais duas que surgiram na
própria rodada (falha de classificação, flag de recriar do zero):

1. **Deduplicação: `passage.id` (já estável, `sha1(url)`, da tarefa 01) + hash do texto para
   detectar conteúdo alterado na mesma URL.** A tarefa 01 já resolveu "é o mesmo item de novo?"
   com um id estável por URL. O que sobrava era decidir o que fazer se o conteúdo daquela URL
   mudar (matéria editada depois de publicada): comparar hash do texto novo com o já indexado, e
   só reembeddar/reindexar se divergir — barato (comparação de hash antes de gastar embedding) e
   evita servir conteúdo desatualizado em silêncio.
2. **Obsolescência: sem remoção ativa nesta tarefa.** O projeto já tem decaimento temporal
   (`timeDecay`) planejado para as tarefas 04/05 — peso menor pra passage antigo **na hora da
   busca**, não a remoção dele do índice. Esta tarefa só garante que `publishedAt` está correto e
   confiável (pré-requisito pro decaimento funcionar depois). Remoção ativa (índice não crescer
   sem limite) é decisão de política que ainda não tem informação suficiente pra tomar bem, e fica
   em aberto para quando isso virar problema de verdade.
3. **Cadência: CLI incremental, disparada manualmente — sem cron/automação real.** O projeto não
   tem servidor, é uso pessoal via CLI. Automação de verdade (cron, systemd timer, GitHub Action
   agendado) é infraestrutura adicional não justificada ainda; dá pra virar tarefa própria depois
   se fizer sentido deixar isso rodando sozinho.
4. **Tagueamento de time continua por regex** (`tagTeams`, da tarefa 01 — já testado e com um
   bug de falso-positivo corrigido na revisão dela; trocar por LLM reduziria robustez pra gastar
   dinheiro). **Classificação de `PassageType`** (`article`/`chronicle`/`matchReport`/`preview`,
   hoje sempre `"article"` — deixado explicitamente para esta tarefa pela spec aprovada da 01,
   seção 17) **via LLM**, `claude-haiku-4-5` — decidido no grilling de 2026-09-08 que tagueamento
   é classificação curta e de alto volume, cabe nessa classe de modelo (ver tabela em
   `docs/architecture.md`).
5. **Falha na classificação de `type`: cai em `"article"` (default seguro) com aviso, sem
   derrubar a ingestão.** Coerente com "no teto, o sistema responde, nunca falha" — e `"article"`
   já é o valor de hoje para tudo, então é degradação, não regressão.
6. **Mantém uma flag `--recreate`** como escape hatch pra reconstruir a coleção do zero (ex.
   mudança de schema do payload) — já aconteceu nas tarefas 00/01, é barato manter a opção.

Lembrar da regra de ouro, que não foi reaberta aqui: fatos exatos nunca entram no índice
vetorial. Dedup/obsolescência/cadência/tagueamento são todos do lado da narrativa
(`listPassages`/ingestão), nunca do lado dos fatos (`getFacts`).

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
