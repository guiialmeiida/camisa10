# Tarefa 01: Fontes de dados

Corresponde ao nó "Fontes de dados" do diagrama em `docs/architecture.md`. Depende da tarefa 00:
**substitui o fixture JSON da fatia vertical pela fonte real**, com o conjunto de avaliação da 00
servindo de rede.

## Status
- [ ] Discovery
- [ ] Refinamento técnico
- [ ] Implementação
- [ ] Revisão
- [ ] Testes

## Discovery
- Qual API usar: API Futebol (gratuita, focada em campeonatos brasileiros, endpoints `/ao-vivo`
  e `/campeonatos/{id}/tabela`) ou Sportmonks (paga, mais completa, cobre ligas internacionais)?
- Quais competições cobrir no MVP — só Brasileirão, ou também ligas europeias?
- Além da API estruturada, quais fontes de texto usar para notícias/súmulas (RSS, scraping,
  outra API)?
- Qual a frequência de consulta viável dentro do rate limit do plano escolhido?

Ainda em aberto — o usuário não decidiu no grilling de 2026-09-08. O `.env.example` já traz
`API_FUTEBOL_TOKEN`, o que sugere a API Futebol como inclinação inicial, mas isso não é decisão
registrada em lugar nenhum.

Lembrar da separação que a arquitetura exige: esta tarefa entrega **duas** coisas de natureza
diferente — a API estruturada, que alimenta `buscar_fatos_api` (números exatos), e as fontes de
texto, que alimentam o índice vetorial (narrativa). Elas não se misturam.

## Refinamento técnico
_A preencher após o discovery._

## Implementação
_A preencher._

## Revisão
_A preencher._

## Testes
_A preencher._
