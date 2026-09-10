# Tarefa 01: Fontes de dados

Corresponde ao nó "Fontes de dados" do diagrama em `docs/architecture.md`. Depende da tarefa 00:
**substitui o fixture JSON da fatia vertical pela fonte real**, com o conjunto de avaliação da 00
servindo de rede.

## Status
- [x] Discovery
- [x] Refinamento técnico  ← spec aprovada pelo usuário em 2026-09-10, ver nota no início da seção
- [x] Implementação  ← ver seção "Implementação". Pendência: `FOOTBALL_DATA_TOKEN` real (usuário)
- [ ] Revisão
- [x] Testes  ← unidade 76/76; integração: vectorstore 3/3, recall@5 = 0.929, regra de ouro 3/3;
      `live-sources.test.ts` não verificado (token pendente) — ver "Implementação" e "Testes"

## Discovery

Concluído no grilling de 2026-09-10. As quatro perguntas originais (API estruturada, escopo de
competições, fonte de texto, cadência) mais duas que surgiram na pesquisa (apelido de time,
orquestração do dado ao vivo) foram decididas nesta ordem:

1. **Escopo do MVP: só Brasileirão Série A.** Ampliar competições depois é mudança barata (mais
   configuração, não redesenho); ampliar agora misturaria "trocar fixture por API real" com
   "cobrir mais coisa" — dois riscos ao mesmo tempo. `API_FUTEBOL_TOKEN`, que já estava no
   `.env.example` como inclinação inicial não confirmada, **não é mais a decisão** — ver item 2.

2. **API estruturada de fatos exatos (placar, tabela, rodada): `football-data.org`.**
   Pesquisado e confirmado ao vivo (não só relatório de terceiro): tier gratuito **pra sempre**,
   cobre Brasileirão Série A (código de competição `BSA`), 10 requisições/min, autenticação por
   token simples. A alternativa inicial (API Futebol) acabou descartada: não é gratuita pra uso
   contínuo (só trial), e não consegui confirmar preço/limite real na doc oficial (fetch
   bloqueado). Sportmonks também descartado: Brasileirão só entra a partir do tier pago
   (~€99/mês); free cobre só 2 ligas.

   Endpoint de partidas filtra por rodada via `?matchday=N` (confirmado na doc oficial). O
   objeto de time tem `shortName`/`tla`, mas **não** tem apelido popular (Verdão, Timão) — ver
   item 4.

3. **API estruturada de fatos exatos, só para jogo em andamento: `API-Football`
   (api-sports.io/dashboard.api-football.com), como segunda fonte.** O tier gratuito do
   football-data.org não garante placar atualizado em tempo real pra jogo em andamento
   (`IN_PLAY`) — isso é addon pago (€12/mês) lá. Testado ao vivo com uma chave real do usuário
   (plano Free, 100 req/dia): `/fixtures?live=all` funciona sem paywall, devolve minuto
   decorrido, placar parcial e eventos (gol) sem atraso aparente. Liga do Brasileirão nessa API:
   `league.id = 71`.

   **Orquestração decidida**: regra determinística, não decisão do LLM. `getFacts` sempre
   consulta o football-data.org primeiro; só quando o `status` retornado já é `IN_PLAY`, uma
   segunda chamada à API-Football busca o placar preciso daquele jogo específico. Mantém as duas
   APIs, cada uma no que comprovadamente faz melhor, em vez de consolidar tudo numa API só (a
   API-Football parece cobrir tudo, mas sua cota de 100/dia é bem mais apertada que os ~14.400/dia
   teóricos do football-data.org, e não foi confirmado se o endpoint de tabela dela tem a mesma
   qualidade).

4. **Apelidos de time (alviverde → Palmeiras, Timão → Corinthians): lista curada à mão no
   repo.** Nenhuma API tem esse campo — é dado editorial/popular. O Brasileirão tem ~20 times, é
   finito e estável; a tarefa 00 já validou esse padrão no fixture (campo `teams.nicknames`).
   Evita depender de mais uma fonte externa só pra isso.

5. **Fonte de texto/narrativa (notícias/crônicas pro índice vetorial): `gazetaesportiva.com`,
   via RSS.** Testado ao vivo: feed RSS 2.0 válido (geral e um específico de times do Brasil),
   itens recentes. `robots.txt` tem um bloco `# AI Crawlers` que **libera explicitamente**
   `GPTBot`/`ClaudeBot`/`Google-Extended`/etc. com `Allow: /` — permissão declarada, não ausência
   de bloqueio.

   Descartados no caminho: **Globo Esporte** (`ge.globo.com`) — `robots.txt` desautoriza
   `GPTBot`/`Google-Extended`/`CCBot` explicitamente. **Flashscore** — sem RSS, conteúdo é
   placar/estatística estruturada (não a crônica/matéria em prosa que o caso de uso precisa),
   `robots.txt` bloqueia por nome vários crawlers de dados/IA, ToS proíbe scraping com previsão
   de ação legal. **LANCE!**, **UAI/SuperEsportes**, **futebolinterior.com.br**,
   **colunadofla.com**, **placar.com.br**: sem RSS funcional confirmado ao vivo, ou robots.txt
   bloqueando o próprio path do feed. `meutimao.com.br` (blog do Corinthians) também tem RSS
   funcional e robots.txt neutro sobre IA — fica como candidato secundário pra somar depois, fora
   do escopo desta tarefa por ora.

6. **Cadência/cache de consulta: fica pra tarefa 02.** `fetch_facts_api` chama a API direto a
   cada pergunta por enquanto — dentro do rate limit pro volume de um projeto de aprendizado, e
   cache é otimização prematura numa tarefa que já está trocando a fonte inteira.

Lembrar da separação que a arquitetura exige e que não foi reaberta aqui: a API estruturada
alimenta `fetch_facts_api` (números exatos), as fontes de texto alimentam o índice vetorial
(narrativa). Elas não se misturam — a API-Football também entra só pelo lado de fatos, nunca
pelo lado de texto.

## Refinamento técnico

> **Spec aprovada pelo usuário em 2026-09-10.** Os 5 pontos em aberto da seção 18 foram
> decididos:
>
> 1. **URL do segundo feed RSS: adiada.** A tarefa começa só com o feed geral
>    (`https://www.gazetaesportiva.com/feed/`, seção 9). Acrescentar um segundo feed (ex. o de
>    times do Brasil) fica pra depois, sem bloquear esta tarefa.
> 2. **Item de feed fora do tema (vôlei, F1, etc.), sem nenhum time reconhecido: descartado**, como
>    a spec já propunha.
> 3. **`teams.json`: dados estruturais (`footballDataId`, `name`) são levantados contra a API
>    real durante a implementação; os apelidos (`nicknames`) são revisados/completados pelo
>    usuário** — são eles que resolvem "alviverde" → `palmeiras`, e isso é curadoria editorial,
>    não fato extraível de API nenhuma.
> 4. **`standings` (tabela) fica fora do escopo desta tarefa**, como a spec propunha — muda
>    writer, trace e o teste da regra de ouro por um campo que hoje ninguém consome.
> 5. **`API_FOOTBALL_KEY` é opcional**, como a spec propunha — é fonte secundária de
>    enriquecimento (discovery, item 3); o sistema responde sem ela com o placar do
>    football-data.org.
>
> **Nota técnica para o implementador, fora dos 5 pontos**: o `fdMatchSchema` (seção 6) exige um
> campo `season` dentro de cada objeto de partida, mas o exemplo de payload logo abaixo não o
> mostra, e `mapMatches` nunca o usa (só `fetchCompetition` precisa de `season`/`currentMatchday`,
> e isso vem da resposta de `/v4/competitions/BSA`, não da de `/matches`). **Confirmar contra a
> API real antes de travar o schema assim** — se o campo não existir na resposta de `/matches`,
> `z.object({...})` sem `.optional()`/`.nullish()` ali quebra a primeira chamada real.

Spec fechada em 2026-09-10 a partir do discovery acima. Nada aqui reabre decisão do discovery.

### 0. O que esta tarefa é, em uma frase

Trocar a implementação por trás de `src/sources/index.ts`: o fixture JSON sai, entram
`football-data.org` (fatos), `API-Football` (fatos, só jogo ao vivo) e o RSS da
`gazetaesportiva.com` (narrativa). **A fronteira pública muda o mínimo possível**, porque
`src/agent/`, `src/generation/`, `src/ingestion/` e os testes de avaliação dependem dela.

O fixture não é apagado: vira **dublê de teste** em `tests/fixtures/` (seção 12). É a única forma
de manter a armadilha do p07 e, com ela, o teste executável da regra de ouro.

### 1. O que continua exatamente igual

```ts
export async function getFacts(filter?: FactsFilter): Promise<Facts>;
export async function listPassages(): Promise<Passage[]>;
```

Mesma assinatura, mesma semântica de ausência (**filtro sem resultado devolve `matches: []`, não
lança**), mesmos nomes de campo em `Facts`, `FactsFilter`, `Team`, `Competition`. Nenhum módulo
fora de `src/sources/` importa outra coisa que não `src/sources/index.ts`.

E a regra de ouro continua sendo a espinha do desenho, agora com uma consequência literal de
código: **`getFacts` só fala com as duas APIs estruturadas; `listPassages` só fala com o RSS.**
Não há caminho em que um número chegue à resposta vindo do RSS — e isso vira teste (seção 15).

### 2. O que muda no contrato público, e por quê

Seis mudanças, todas forçadas pelo dado real. Nenhuma é cosmética.

| Mudança | Por quê |
|---|---|
| `MatchStatus` ganha `"postponed"` | `POSTPONED`/`SUSPENDED`/`CANCELLED` acontecem toda temporada no Brasileirão (Libertadores, Copa do Brasil). Mapear isso para `"scheduled"` seria mentir sobre um fato. |
| variante `live` ganha `minute: number \| null` | É o único ganho real da segunda API (discovery, item 3). "Jogo em andamento" sem o minuto é meia informação. |
| `Match.venue` vira `string \| null` | O tier gratuito do football-data.org não garante `venue` na resposta de partidas. |
| `Passage.matchId` vira `string \| null` | Um item de RSS não vem preso a um jogo. Ligar notícia a partida é trabalho da tarefa 02. |
| `Match`, `Passage`, `Team`, `Score` saem de `fixture-schema.ts` e viram **tipos comuns** em `src/sources/types.ts` | Eles deixam de ser inferidos de um JSON e passam a ser construídos pelos nossos mappers a partir de dado já validado. `zod` fica na fronteira de verdade (resposta HTTP, XML, arquivo curado); o tipo de domínio é `type` comum, como manda o `CLAUDE.md`. |
| `src/sources/index.ts` **acrescenta** `listTeams()` e `COMPETITION` | Hoje `extractEntity` chama `getFacts({})` só para montar a lista de times do prompt. Com API real isso custaria **duas chamadas de rede por pergunta** (uma no `extractEntity`, outra no fan-out) para buscar uma lista de 20 times que é local e estática. Adição, não quebra. |

`Match` e `Passage` continuam sendo exportados de `src/sources/index.ts` com o mesmo nome — quem
importa não muda uma linha, exceto onde o compilador cobrar o `"postponed"` (writer e trace,
seção 11).

#### `src/sources/types.ts` (novo conteúdo, substitui o atual)

```ts
export interface Competition {
  id: string;
  name: string;
  season: number;
}

export interface Team {
  id: string;          // slug: "palmeiras"
  name: string;        // "Palmeiras"
  nicknames: string[]; // ["Verdão", "alviverde"] — só o prompt do extractEntity usa
}

export interface Score {
  home: number;
  away: number;
}

export type MatchStatus = "finished" | "live" | "scheduled" | "postponed";

interface MatchBase {
  id: string;          // id da partida no football-data.org, como string
  matchweek: number;
  date: string;        // ISO com offset -03:00 (ver seção 10)
  homeTeam: string;    // team id (slug)
  awayTeam: string;
  venue: string | null;
}

export type Match =
  | (MatchBase & { status: "finished"; score: Score })
  | (MatchBase & { status: "live"; score: Score; minute: number | null })
  | (MatchBase & { status: "scheduled"; score: null })
  | (MatchBase & { status: "postponed"; score: null });

export type PassageType = "article" | "chronicle" | "matchReport" | "preview";

export interface Passage {
  id: string;              // ver a nota da seção 9: precisa casar /^[a-zA-Z0-9]+$/
  matchId: string | null;
  teams: string[];         // team ids; pode ser [] (ver ponto em aberto 2)
  type: PassageType;
  title: string;
  source: string;          // "Gazeta Esportiva"
  url: string;
  publishedAt: string;     // ISO com offset -03:00
  text: string;
}

export interface Facts {
  competition: Competition;
  matchweek: number;
  matches: Match[];
  teams: Team[];
  source: "fixture" | "api";
}

export interface FactsFilter {
  competition?: string | undefined;
  matchweek?: number | undefined;
  team?: string | undefined;
}
```

`source: "fixture" | "api"` fica como está: a implementação real devolve sempre `"api"`, inclusive
quando a API-Football enriqueceu o placar. Distinguir as duas APIs no `Facts` seria informação que
ninguém consome — o trace já mostra `source: api`, e o enriquecimento aparece no `minute`.

#### `src/sources/index.ts` (a fronteira, depois desta tarefa)

```ts
export { getFacts } from "./facts.ts";
export { listPassages } from "./passages.ts";
export { listTeams } from "./teams.ts";
export { COMPETITION } from "./competition.ts";
export type {
  Competition, Facts, FactsFilter, Match, MatchStatus, Passage, PassageType, Score, Team,
} from "./types.ts";
```

### 3. Mapa dos módulos de `src/sources/`

```
index.ts          a fronteira (só reexporta)
types.ts          tipos de domínio, sem zod
competition.ts    a constante da única competição do MVP
teams.ts          lista curada: schema, listTeams(), resolveTeamId(), teamIdFromFootballData()
teams.json        os ~20 times do Brasileirão, à mão (discovery, item 4)
http.ts           fetchJson() com timeout e erro legível — compartilhado pelos 3 clientes
time.ts           toSaoPauloIso() — a conversão de fuso que evita errar o dia do jogo
football-data.ts  cliente + schema zod da resposta + mapper puro
api-football.ts   cliente + schema zod da resposta + mapper puro (só jogo ao vivo)
rss.ts            fetch do feed + parseFeed() puro + stripHtml()
feeds.ts          a lista de feeds RSS
facts.ts          getFacts(): orquestra football-data (+ API-Football condicional)
passages.ts       listPassages(): orquestra os feeds RSS
```

**Por que cliente e mapper separados em cada fonte**: o mapper é função pura sobre o JSON/XML já
validado, então ele é testável sem rede, contra um payload real gravado em disco
(`tests/fixtures/http/`). É a costura que faz esta tarefa ter testes de verdade em vez de só um
smoke test contra a internet.

**Sem factory, sem injeção de dependência, sem classe de interface** — a restrição do discovery da
tarefa 00 continua valendo. Onde o teste precisa trocar a fonte, ele usa `vi.mock` no módulo
`src/sources/index.ts` (seção 12), que é troca no ponto de importação, não abstração no código de
produção.

### 4. Variáveis de ambiente

`src/config/env.ts` passa a ser:

```ts
const schema = z.object({
  FOOTBALL_DATA_TOKEN: z.string().min(1, "set FOOTBALL_DATA_TOKEN in .env"),
  API_FOOTBALL_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().min(1, "set VOYAGE_API_KEY in .env"),
  ANTHROPIC_API_KEY: z.string().min(1, "set ANTHROPIC_API_KEY in .env"),
  QDRANT_URL: z.url("QDRANT_URL must be a valid URL"),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().min(1).default("camisa10"),
});
```

- **`API_FUTEBOL_TOKEN` é removido** de `src/config/env.ts`, do `.env.example` e de
  `tests/setup.test.ts`. O discovery (item 1) descartou a API Futebol; manter a variável só
  ensinaria errado a quem lesse o `.env.example`.
- **`FOOTBALL_DATA_TOKEN` é obrigatório**: sem ele não há fato exato, e sem fato exato o sistema
  não tem o que garantir. Vai no header `X-Auth-Token`.
- **`API_FOOTBALL_KEY` é opcional** — é fonte secundária de enriquecimento. Ausente, `getFacts`
  devolve o placar do football-data.org e registra um `console.warn` uma vez por processo. Header
  `x-apisports-key` (uso direto de `v3.football.api-sports.io`, não via RapidAPI). Ver ponto em
  aberto 5.
- Nada de URL base em env: são constantes nos módulos de cliente. URL de API não é configuração de
  ambiente, é parte do código do cliente.

`.env.example` correspondente:

```bash
# Fatos exatos: placar, tabela, rodada (football-data.org, competição BSA)
# Token gratuito em https://www.football-data.org/client/register
FOOTBALL_DATA_TOKEN=

# Fatos exatos SÓ de jogo em andamento (api-sports.io, league 71). Opcional:
# sem ela, o placar de jogo ao vivo é o do football-data.org, que pode atrasar.
API_FOOTBALL_KEY=
```

### 5. `src/sources/teams.ts` + `teams.json` — a lista curada

Decisão 4 do discovery. É a única fonte de apelido, e também o **dicionário que traduz os nomes
das duas APIs para o nosso slug**.

```ts
export const teamRecordSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  nicknames: z.array(z.string().min(1)),
  aliases: z.array(z.string().min(1)),
  footballDataId: z.number().int().positive(),
});

export type TeamRecord = z.infer<typeof teamRecordSchema>;

/** Times conhecidos, sem os campos de mapeamento de fonte. É o que vai em `Facts.teams`. */
export async function listTeams(): Promise<Team[]>;

/** "SE Palmeiras" | "Palmeiras SP" | "palmeiras" -> "palmeiras". Desconhecido -> null. */
export async function resolveTeamId(name: string): Promise<string | null>;

/** Mapeia o id numérico do football-data.org para o nosso slug. */
export async function teamIdFromFootballData(id: number, fallbackName: string): Promise<string>;

/** Times cujo nome/alias aparece no texto. Usado para taguear passage de RSS. */
export async function tagTeams(text: string): Promise<string[]>;
```

Exemplo literal de `src/sources/teams.json` (o arquivo tem uma entrada por time da Série A):

```json
[
  {
    "id": "palmeiras",
    "name": "Palmeiras",
    "nicknames": ["Verdão", "alviverde", "Porco"],
    "aliases": ["SE Palmeiras", "Palmeiras SP", "Sociedade Esportiva Palmeiras"],
    "footballDataId": 1769
  },
  {
    "id": "atletico-mg",
    "name": "Atlético Mineiro",
    "nicknames": ["Galo"],
    "aliases": ["CA Mineiro", "Atlético-MG", "Atletico Mineiro", "Clube Atlético Mineiro"],
    "footballDataId": 1766
  }
]
```

Regras que a implementação precisa respeitar:

- **Normalização**: minúsculas, `NFD` + remoção de diacrítico, colapso de espaço. `"Atlético-MG"`,
  `"atletico mg"` e `"ATLETICO-MG"` caem na mesma chave.
- **`resolveTeamId` usa `name` + `aliases`, nunca `nicknames`.** "Tricolor" pertence a quatro
  times; "Timão" a um. Apelido serve para o LLM desambiguar com o contexto da pergunta, não para
  um `Map` decidir sozinho. Os nicknames continuam indo no prompt do `extractEntity` — que é
  exatamente onde a desambiguação por contexto acontece hoje.
- **Colisão de chave normalizada entre times diferentes lança no carregamento**, com os dois ids
  na mensagem. É erro de dado curado, e falhar cedo e alto é melhor que taguear errado em
  silêncio.
- **`teamIdFromFootballData` com id desconhecido não lança**: emite `console.warn`, devolve um
  slug derivado do `fallbackName` (minúsculas, sem acento, hífen no lugar de espaço) e o jogo
  continua aparecendo. Time promovido que ninguém acrescentou ao arquivo degrada o apelido, não
  derruba a rodada inteira. Esse slug sintético entra em `Facts.teams` com `nicknames: []`.
- **`listTeams()` devolve só `{ id, name, nicknames }`**: `footballDataId` e `aliases` são detalhe
  de fonte e não vazam para o domínio nem para o prompt.
- `tagTeams` casa `name` e `aliases` no texto normalizado com fronteira de palavra (`\b`), nunca
  substring solta — senão "Bahia" casa dentro de "baiano".

### 6. `src/sources/football-data.ts` — a fonte primária de fatos

Base: `https://api.football-data.org/v4`. Header: `X-Auth-Token: <FOOTBALL_DATA_TOKEN>`.
Competição: `BSA` (discovery, item 2).

Duas chamadas, ambas com schema `zod` porque são fronteira:

```ts
/** GET /v4/competitions/BSA — nome, temporada e rodada corrente. */
export async function fetchCompetition(): Promise<CompetitionInfo>;

/** GET /v4/competitions/BSA/matches?matchday=N */
export async function fetchMatchweek(matchweek: number): Promise<unknown>;

/** Puro: resposta validada -> Match[]. Testado contra payload gravado, sem rede. */
export async function mapMatches(raw: FootballDataMatches): Promise<Match[]>;

export interface CompetitionInfo {
  name: string;
  season: number;          // ano de currentSeason.startDate
  currentMatchday: number;
}
```

Schemas (permissivos com campo extra, estritos com o que a gente usa — `z.object` do zod v4 já
descarta chave desconhecida, e é isso que se quer numa API de terceiro que acrescenta campo sem
avisar):

```ts
const fdScoreSchema = z.object({
  fullTime: z.object({
    home: z.number().int().nullable(),
    away: z.number().int().nullable(),
  }),
});

const fdTeamSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shortName: z.string().nullish(),
  tla: z.string().nullish(),
});

const fdMatchSchema = z.object({
  id: z.number().int(),
  utcDate: z.string(),
  status: z.string(),
  matchday: z.number().int(),
  venue: z.string().nullish(),
  season: z.object({ startDate: z.string(), currentMatchday: z.number().int().nullable() }),
  homeTeam: fdTeamSchema,
  awayTeam: fdTeamSchema,
  score: fdScoreSchema,
});

export const footballDataMatchesSchema = z.object({
  competition: z.object({ id: z.number().int(), name: z.string(), code: z.string() }),
  matches: z.array(fdMatchSchema),
});

export const footballDataCompetitionSchema = z.object({
  name: z.string(),
  code: z.string(),
  currentSeason: z.object({ startDate: z.string(), currentMatchday: z.number().int().nullable() }),
});
```

Exemplo literal do que a API devolve em `/v4/competitions/BSA/matches?matchday=12` (recortado
para os campos que usamos; o payload real inteiro vai gravado em
`tests/fixtures/http/football-data-matchweek.json`):

```json
{
  "competition": { "id": 2013, "name": "Campeonato Brasileiro Série A", "code": "BSA" },
  "matches": [
    {
      "id": 545231,
      "utcDate": "2026-09-06T00:30:00Z",
      "status": "FINISHED",
      "matchday": 12,
      "venue": "Allianz Parque",
      "season": { "startDate": "2026-04-11", "currentMatchday": 12 },
      "homeTeam": { "id": 1769, "name": "SE Palmeiras", "shortName": "Palmeiras", "tla": "PAL" },
      "awayTeam": { "id": 1765, "name": "Fluminense FC", "shortName": "Fluminense", "tla": "FLU" },
      "score": { "fullTime": { "home": 1, "away": 3 } }
    }
  ]
}
```

que `mapMatches` transforma em:

```json
{
  "id": "545231",
  "matchweek": 12,
  "date": "2026-09-05T21:30:00-03:00",
  "status": "finished",
  "homeTeam": "palmeiras",
  "awayTeam": "fluminense",
  "score": { "home": 1, "away": 3 },
  "venue": "Allianz Parque"
}
```

**Repare no `date`**: `00:30Z` do dia 6 é `21:30` do dia **5** em São Paulo. Sem a conversão da
seção 10, todo jogo noturno apareceria no dia seguinte — e o dia é um número que entra na
resposta e no teste da regra de ouro.

Tabela de status (a única tradução permitida; string desconhecida → `console.warn` e o jogo é
descartado da lista):

| football-data.org | nosso `MatchStatus` |
|---|---|
| `FINISHED`, `AWARDED` | `finished` |
| `IN_PLAY`, `PAUSED` | `live` |
| `SCHEDULED`, `TIMED` | `scheduled` |
| `POSTPONED`, `SUSPENDED`, `CANCELLED` | `postponed` |

**Jogo `FINISHED`/`IN_PLAY` com `fullTime.home` ou `away` em `null`**: o jogo é descartado da
lista, com `console.warn` nomeando o `id`. Não se inventa `0 x 0` — um placar fabricado é
exatamente o tipo de número sem lastro que a regra de ouro existe para impedir, e o pior lugar
para ele nascer é dentro da própria fonte de fatos. `live` mapeia com `minute: null`; quem
preenche o minuto é a seção 7.

Erros:

| situação | comportamento |
|---|---|
| HTTP 429 | lança `Error("football-data.org rate limit reached (10 req/min); retry in Ns")`, com o `X-RequestCounter-Reset` quando presente |
| HTTP 403 | lança `Error("football-data.org rejected the token (403) — check FOOTBALL_DATA_TOKEN")` |
| outro HTTP não-2xx | lança com status, método e caminho (nunca com o token) |
| timeout (10s) | lança `Error("football-data.org timed out after 10000ms")` |
| corpo fora do schema | lança com `z.prettifyError`, como `loadEnv` já faz |

Todas essas exceções sobem por `getFacts` e param no `Promise.allSettled` do fan-out
(`src/agent/graph.ts`), que já as transforma em `facts: null` + erro no trace + resposta de baixa
confiança. **`getFacts` não engole erro de fonte primária**: "não consegui falar com a API" e "a
API disse que não há jogo" são coisas diferentes, e só a segunda é `matches: []`.

### 7. `src/sources/api-football.ts` — fatos, só jogo em andamento

Regra determinística do discovery (item 3), não decisão do LLM: **só é chamada quando o
football-data.org já devolveu pelo menos um jogo `live`** no conjunto filtrado.

Base: `https://v3.football.api-sports.io`. Header: `x-apisports-key`. Endpoint:
`GET /fixtures?live=all`, com filtro **do lado do cliente** por `league.id === 71` — é a chamada
que o discovery confirmou funcionando no plano gratuito; combinar `live` com `league` no
query-string não foi verificado e não é hora de descobrir isso em produção.

```ts
export interface LiveMatch {
  homeTeam: string;        // team id (slug) já resolvido
  awayTeam: string;
  score: Score;
  minute: number | null;
}

/** [] quando a chave falta, a API falha ou não há jogo ao vivo. Nunca lança. */
export async function fetchLiveMatches(): Promise<LiveMatch[]>;

/** Puro. Sobrescreve score/minute dos matches `live` que casarem por par de times. */
export function applyLiveScores(matches: Match[], live: LiveMatch[]): Match[];
```

Exemplo literal da resposta (recorte; payload inteiro em
`tests/fixtures/http/api-football-live.json`):

```json
{
  "errors": [],
  "results": 1,
  "response": [
    {
      "fixture": {
        "id": 1198432,
        "date": "2026-09-10T22:00:00+00:00",
        "status": { "long": "Second Half", "short": "2H", "elapsed": 67 }
      },
      "league": { "id": 71, "name": "Serie A", "country": "Brazil", "round": "Regular Season - 12" },
      "teams": { "home": { "id": 121, "name": "Palmeiras" }, "away": { "id": 124, "name": "Fluminense" } },
      "goals": { "home": 1, "away": 0 }
    }
  ]
}
```

Detalhes que a implementação não pode ignorar:

- **`errors` da api-sports vem como `[]` no sucesso e como objeto no erro** (`{"token": "..."}`).
  Schema: `z.union([z.array(z.string()), z.record(z.string(), z.string())])`; qualquer conteúdo
  não vazio é tratado como falha → `console.warn` + `[]`.
- **O casamento com o jogo do football-data.org é por par de times**, via `resolveTeamId` sobre
  `teams.home.name`/`teams.away.name`. Se qualquer um dos dois não resolver, ou se o par não
  casar com nenhum `Match` `live`, o enriquecimento daquele jogo é ignorado com `console.warn`.
  Nada de casar por horário: dois jogos do Brasileirão começam no mesmo minuto o tempo todo.
- **`fetchLiveMatches` nunca lança.** Ela é enriquecimento: se a fonte secundária cair, a resposta
  ainda tem o placar do football-data.org, que é a fonte primária. Deixar a secundária derrubar a
  primária inverteria a hierarquia decidida no discovery.
- `minute` = `fixture.status.elapsed` (pode ser `null` no intervalo).
- Nenhum uso desta API fora de jogo ao vivo, e **nenhum uso dela do lado de texto** — o discovery
  fecha essa porta explicitamente.

### 8. `src/sources/facts.ts` — a orquestração de `getFacts`

```ts
export async function getFacts(filter?: FactsFilter): Promise<Facts>;
```

Sequência, sem LLM e sem ramo escondido:

1. `const info = await fetchCompetition()` — dá `name`, `season` e `currentMatchday`.
2. `const teams = await listTeams()` (local, sem rede).
3. Se `filter.competition` está definido e é diferente de `COMPETITION.id`, devolve
   `{ competition, matchweek: filter.matchweek ?? info.currentMatchday, matches: [], teams,
   source: "api" }`. Mesma semântica do fixture: competição desconhecida é ausência de dado, não
   erro.
4. `const matchweek = filter.matchweek ?? info.currentMatchday`.
5. `const matches = await mapMatches(await fetchMatchweek(matchweek))`.
6. Filtra por `filter.team` **do lado do cliente** (`homeTeam === team || awayTeam === team`).
   São ~10 jogos por rodada; um endpoint a mais gastaria cota do rate limit para fazer o que um
   `.filter()` faz.
7. Se sobrou algum jogo `live` **e** `API_FOOTBALL_KEY` existe: `applyLiveScores(matches, await
   fetchLiveMatches())`.
8. Devolve `Facts` com `source: "api"`.

Custo por pergunta: **2 requisições** ao football-data.org (limite de 10/min), mais 1 à
API-Football só quando há jogo em andamento. O `extractEntity` deixa de fazer a terceira (seção
11). Cache e cadência são da tarefa 02, por decisão do discovery (item 6) — o único cache aqui é
a memória do processo para `fetchCompetition`, que morre junto com a CLI.

`getFacts` devolve `matches: []` e **não lança** quando: time desconhecido, competição diferente,
rodada sem jogo (ex.: `matchweek: 99`). Lança quando a fonte primária falha (seção 6).

### 9. `src/sources/rss.ts`, `feeds.ts` e `passages.ts` — a narrativa

`src/sources/feeds.ts`:

```ts
export interface Feed {
  name: string;   // vira Passage.source
  url: string;
}

export const RSS_FEEDS: Feed[] = [
  { name: "Gazeta Esportiva", url: "https://www.gazetaesportiva.com/feed/" },
  // segundo feed (times do Brasil) — ver ponto em aberto 1
];
```

Lista versionada no repo, não em env: feed não é segredo e a reprodutibilidade do índice depende
de saber de onde ele veio.

`src/sources/rss.ts`:

```ts
/** Puro: XML cru -> passages. Testado contra um feed gravado, sem rede. */
export function parseFeed(xml: string, feed: Feed): Passage[];

/** GET do feed + parseFeed. Lança em erro de rede/HTTP/XML inválido. */
export async function fetchFeed(feed: Feed): Promise<Passage[]>;

/** Remove script/style, tags e entidades HTML; colapsa espaço. */
export function stripHtml(html: string): string;
```

`src/sources/passages.ts`:

```ts
export async function listPassages(): Promise<Passage[]>;
```

- `Promise.allSettled` sobre `RSS_FEEDS`. Feed que falha vira `console.warn` e a ingestão segue
  com os outros.
- **Se todos os feeds falharem, lança.** Isso é deliberado: `indexPassages()` recria a coleção
  destrutivamente, e uma lista vazia por erro de rede apagaria o índice inteiro em silêncio.
- Deduplicação por `passage.id` (o mesmo artigo aparece nos dois feeds). Isto é dedup **de uma
  chamada só**, um `Map`; a deduplicação da tarefa 02 é outra coisa (entre execuções, por
  conteúdo, persistente) e não está sendo antecipada aqui.
- Ordena por `publishedAt` decrescente.

Mapeamento de um `<item>` RSS 2.0 para `Passage`:

| campo do item | campo do `Passage` |
|---|---|
| `<title>` | `title` |
| `<link>` | `url` |
| `<pubDate>` (RFC-822) | `publishedAt`, convertido para `-03:00` (seção 10) |
| `<content:encoded>`, senão `<description>` | `text`, passado por `stripHtml` |
| — | `source`: o `feed.name` |
| — | `type`: **sempre `"article"`** nesta tarefa |
| — | `matchId`: **sempre `null`** |
| — | `teams`: `await tagTeams(title + " " + text)` |
| — | `id`: `createHash("sha1").update(url).digest("hex").slice(0, 12)` |

Exemplo literal do resultado:

```json
{
  "id": "9f2c41ab77de",
  "matchId": null,
  "teams": ["palmeiras", "fluminense"],
  "type": "article",
  "title": "Palmeiras perde para o Fluminense no Allianz e vê pressão aumentar",
  "source": "Gazeta Esportiva",
  "url": "https://www.gazetaesportiva.com/palmeiras/palmeiras-perde-para-o-fluminense/",
  "publishedAt": "2026-09-05T23:47:00-03:00",
  "text": "O técnico deixou o gramado vaiado. A torcida cobrou o elenco no fim da partida e..."
}
```

**A nota mais fácil de errar e a mais cara**: `extractCitations` em `src/generation/writer.ts` casa
citações com `/\[([a-zA-Z0-9]+)\]/`. Um id com hífen ou barra — slug de URL, por exemplo —
**nunca** seria reconhecido, e toda citação do sistema sumiria em silêncio, sem nenhum teste
quebrar. Por isso o id é hash hexadecimal: estável para a mesma URL (o que a tarefa 02 vai querer
para dedup) e alfanumérico por construção. Um teste amarra isso (seção 15).

Outras regras:

- Item cujo texto fica vazio depois do `stripHtml` é descartado.
- `parseFeed` precisa forçar `item` a ser array: um canal com um único `<item>` faz o
  `fast-xml-parser` devolver objeto, não array — e a diferença só aparece num feed magro, em
  produção, num domingo.
- **Nenhum campo numérico de placar entra em `Passage`.** O tipo não tem onde guardá-lo e o
  `passagePayloadSchema` (`z.strictObject`) rejeita no caminho para o Qdrant. Continua sendo a
  regra de ouro expressa no tipo *e* no schema.
- Não há busca do corpo completo da matéria na página do artigo. O feed dá o que dá; texto curto
  é limitação conhecida e é assunto da tarefa 02.

### 10. `src/sources/time.ts` — a conversão de fuso

```ts
/** "2026-09-06T00:30:00Z" | "Sat, 05 Sep 2026 23:47:00 +0000" -> "2026-09-05T21:30:00-03:00" */
export function toSaoPauloIso(input: string): string;
```

As duas APIs falam UTC e o RSS fala RFC-822. `src/generation/match-format.ts` lê dia, mês e hora
**direto dos dígitos da string ISO** (correção da revisão da tarefa 00, feita justamente para o
resultado não depender do fuso da máquina). Então a string que sai de `src/sources/` precisa já
estar no fuso de Brasília, ou todo jogo depois das 21h aparece no dia seguinte — e o dia é um
número que a resposta cita e que o teste da regra de ouro confere.

Implementação: aritmética de offset fixo (`-3h`, formatado como `-03:00`). O Brasil não tem
horário de verão desde 2019, então não há regra sazonal a acertar; um comentário no arquivo
registra essa premissa. `Intl.DateTimeFormat` resolveria o caso geral, mas para um offset fixo é
maquinaria a mais para o usuário entender. Entrada inválida lança.

### 11. Mudanças fora de `src/sources/`

| arquivo | mudança | por quê |
|---|---|---|
| `src/agent/nodes/extract-entity.ts` | usa `listTeams()` + `COMPETITION` no lugar de `getFacts({})` | tira uma ida à rede por pergunta; a lista de times é local |
| `src/generation/writer.ts` | `formatMatchLine` trata `"postponed"` e imprime o minuto do jogo `live` | o compilador **vai** cobrar: hoje é `if (scheduled) … else score.home` |
| `src/agent/trace.ts` | `formatMatchSummary` idem | mesma união, mesmo motivo |
| `src/vectorstore/types.ts` | `matchId: z.string().min(1).nullable()` | passage de RSS não tem jogo. Retrocompatível: ponto já indexado com string continua parseando |
| `src/ingestion/indexer.ts` | `matchweek` do payload vem de `facts.matchweek`, não de `passage.matchId`; e **lança se `passages.length === 0` antes de `ensureCollection({ recreate: true })`** | sem o guard, um dia de feed fora do ar apaga o índice |
| `src/config/env.ts`, `.env.example`, `tests/setup.test.ts` | seção 4 | — |
| `package.json` | dependência `fast-xml-parser`; script `sources` | seção 14 |
| `README.md` | como obter as duas chaves; o que `npm run sources` mostra | a tarefa entrega algo que roda |
| `docs/learning/02-data-sources.md` (novo) | o conceito: por que fato e narrativa vêm de fontes separadas, por que duas APIs, o que o RSS pode e não pode alimentar, e o "Por que não X?" | `CLAUDE.md` § "Implementar ensinando" |

Sobre o `fast-xml-parser`: é dependência nova e é a única que esta tarefa acrescenta. A
alternativa era extrair `<item>` com regex — e RSS real tem CDATA, entidade HTML e namespace
(`content:encoded`), que é onde regex vira bug intermitente. Um parser de XML de 1 dependência,
sem dependências transitivas, é mais simples de entender do que o nosso próprio parser meio
correto.

Como o payload do Qdrant muda (`matchId` nulável) e a fonte muda inteira, **`npm run index`
precisa ser rodado de novo** depois desta tarefa. A ingestão já é destrutiva (`recreate: true`),
então não há migração a fazer.

### 12. O fixture vira dublê de teste — e a avaliação continua de pé

A spec da tarefa 00 dizia "a tarefa 01 apaga o diretório inteiro". **Não apaga: move.** O motivo é
o teste da regra de ouro. Ele depende de um trecho (p07) que afirma, por extenso, um placar que
**contradiz** o que a API devolve. Com dado real isso não pode ser construído: não há como pedir à
Gazeta Esportiva uma crônica com o placar errado. Sem o fixture, o único teste executável do
invariante do projeto morre nesta tarefa.

Então:

```
src/sources/fixture.ts                                   -> tests/fixtures/fixture-source.ts
src/sources/fixture-schema.ts                            -> tests/fixtures/fixture-schema.ts
src/sources/fixtures/brasileirao-2026-matchweek-12.json  -> tests/fixtures/brasileirao-2026-matchweek-12.json
```

- `tests/fixtures/fixture-source.ts` exporta `getFacts`, `listPassages`, `listTeams` e
  `COMPETITION` — a mesma superfície de `src/sources/index.ts`, para servir de dublê completo.
- `tests/fixtures/fixture-schema.ts` continua com os schemas `zod` (é JSON lido do disco, é
  fronteira) e ganha uma checagem de compilação de que `z.infer<typeof matchSchema> satisfies
  Match` e `z.infer<typeof passageSchema> satisfies Passage` — se o tipo de domínio e o dublê
  divergirem, o `tsc` reclama, em vez de o teste passar contra uma forma que a produção não usa
  mais. O fixture ganha `venue` e `matchId` como estão (não-nulos), o que continua satisfazendo os
  tipos nulávies.
- Os testes que precisam do dublê usam `vi.mock("../../src/sources/index.ts", ...)` apontando para
  ele. Nenhuma abstração entra no código de produção por causa de teste.

**Decisão sobre o conjunto de avaliação** (o ponto que esta tarefa precisava fechar):

1. **O `recall@5` sobre o fixture fica como teste de regressão, com o limiar `>= 0.8` e a linha de
   base de `0.929` medida na tarefa 00.** Ele mede *retrieval*, e retrieval só se mede contra
   ground truth. O fixture é o único lugar do projeto onde o trecho certo de cada pergunta é
   conhecido de graça — dado real exigiria rotular à mão, de novo, a cada rodada, e as etiquetas
   apodreceriam em uma semana. Como o fixture e o modelo de embedding não mudam nesta tarefa,
   **o número não pode mudar**: se mudar, é regressão de retrieval, que é exatamente o que um
   teste de regressão existe para pegar.
2. **`tests/integration/recall.test.ts` e `golden-rule.test.ts` passam a indexar o fixture eles
   mesmos**, num `beforeAll`, numa coleção própria (`QDRANT_COLLECTION = "camisa10-eval"`, trocada
   via `process.env` — `getCollectionName()` relê o env a cada chamada, como a revisão da tarefa
   00 registrou). Hoje eles dependem de um `npm run index` prévio; depois desta tarefa esse
   comando indexa notícia real, e a avaliação não pode depender do que estava na coleção.
3. **Dado real ganha um smoke test estrutural, não um `recall`**:
   `tests/integration/live-sources.test.ts` afirma forma e invariante (schema parseia, rodada
   entre 1 e 38, todo `homeTeam`/`awayTeam` existe em `facts.teams`, toda data termina em
   `-03:00`, todo passage tem id alfanumérico e texto não vazio). Relevância de dado vivo não tem
   gabarito, então não vira nota.
4. **`tests/eval/questions.json` não muda** nesta tarefa. Um conjunto de perguntas sobre dado real
   é assunto das tarefas 03/04/05, que é quando alguém vai querer comparar duas estratégias de
   retrieval sobre o índice real.

### 13. Tratamento de erro, em uma tabela

| onde | situação | comportamento |
|---|---|---|
| `getFacts` | football-data.org fora do ar / 4xx / 5xx / timeout / corpo inválido | **lança** → `allSettled` do graph → `facts: null` → resposta de baixa confiança dizendo que não houve fatos |
| `getFacts` | filtro sem resultado (time, competição ou rodada inexistente) | `matches: []`, **não lança** |
| `getFacts` | API-Football falha, sem chave, ou não casa o jogo | `console.warn` e segue com o placar do football-data.org. **Nunca lança** |
| `listPassages` | um feed falha | `console.warn`, segue com os outros |
| `listPassages` | todos os feeds falham | **lança** — melhor falhar a ingestão que recriar a coleção vazia |
| `listPassages` | item sem texto útil | descartado |
| `teams.ts` | `teams.json` fora do schema, ou colisão de alias | **lança** no carregamento, com `z.prettifyError` |
| `teams.ts` | time da API fora do arquivo curado | `console.warn` + slug sintético; o jogo continua |
| `mapMatches` | status desconhecido, ou placar `null` em jogo encerrado | `console.warn` + jogo descartado. **Nunca inventa placar** |

A regra do projeto ("no teto, o sistema responde, nunca falha") continua morando no fan-out do
graph, não aqui. `src/sources/` distingue com clareza **"a fonte não respondeu"** (exceção) de
**"a fonte respondeu que não há"** (`matches: []`) — colapsar as duas em lista vazia seria
esconder queda de API atrás de "não achei nada", que é a mentira mais cara que uma fonte de dados
pode contar.

### 14. `npm run sources` — o que esta tarefa entrega de rodável

`src/cli/sources.ts`, ligado como `"sources": "node src/cli/sources.ts"`:

```
$ npm run sources
competition: Campeonato Brasileiro Série A (brasileirao-serie-a), season 2026
current matchweek: 12   (source: api)

matches
  Palmeiras 1 x 3 Fluminense            finished    05/09 21:30   Allianz Parque
  Corinthians 0 x 0 Bahia               finished    06/09 16:00   Neo Química Arena
  Cruzeiro x Grêmio                     scheduled   09/09 19:00   Mineirão
  Vasco x Santos                        postponed   —             —

passages (2 feeds, 31 items)
  9f2c41ab77de  05/09 23:47  [palmeiras, fluminense]  Palmeiras perde para o Fluminense…
  1b70de4a90c2  05/09 22:10  [corinthians]            Timão empata e segue sem vencer…
```

Serve para o usuário ver a fonte real funcionando **sem gastar um token de LLM nem subir o
Qdrant** — e para diagnosticar, quando uma resposta sair estranha, se o problema é a fonte ou o
agente. `npm run ask` e `npm run index` continuam sendo a porta principal, agora sobre dado real.

### 15. Casos de teste

Unidade (`npm test`, sem rede — `fetch` mockado, payloads gravados em `tests/fixtures/http/`):

`tests/sources/teams.test.ts`
- `teams.json` parseia; `id` e `footballDataId` são únicos.
- Duas entradas com o mesmo alias normalizado fazem o carregamento lançar.
- `resolveTeamId` casa `"SE Palmeiras"`, `"palmeiras"`, `"PALMEIRAS SP"` → `"palmeiras"`;
  `"Real Madrid"` → `null`.
- `resolveTeamId("Tricolor")` → `null` (apelido não resolve; é ambíguo de propósito).
- `listTeams()` devolve objetos com exatamente as chaves `id`, `name`, `nicknames` — nenhum campo
  de mapeamento de fonte vaza para `Facts.teams`.
- `teamIdFromFootballData(999999, "Novo Time FC")` devolve slug sintético e avisa, sem lançar.
- `tagTeams("O baiano falou sobre o clássico")` **não** devolve `"bahia"` (fronteira de palavra).

`tests/sources/football-data.test.ts` (mapper puro sobre payload gravado)
- Mapeia o payload real para `Match[]` com slug, status e placar corretos.
- `"2026-09-06T00:30:00Z"` vira `"2026-09-05T21:30:00-03:00"` — **o dia muda, e é isso que se
  está testando.**
- `POSTPONED` → `{ status: "postponed", score: null }`.
- `IN_PLAY` → `{ status: "live", minute: null }` antes do enriquecimento.
- `FINISHED` com `fullTime: { home: null, away: null }` é descartado, e **nenhum `0` aparece** no
  resultado.
- Status desconhecido (`"WEIRD"`) é descartado sem derrubar os outros jogos.

`tests/sources/api-football.test.ts`
- Mapeia o payload gravado ignorando fixture de `league.id !== 71`.
- `applyLiveScores` sobrescreve `score` e `minute` do jogo que casou, e **não toca** nos jogos
  `finished`/`scheduled`.
- Par de times que não casa deixa o `Match` intacto.
- `errors` não vazio → `[]`, sem lançar.

`tests/sources/rss.test.ts`
- `parseFeed` sobre o XML gravado produz N passages com `title`, `url`, `text` sem tag HTML e
  `publishedAt` em `-03:00`.
- Feed com **um** `<item>` só produz array de 1, não quebra.
- `content:encoded` tem precedência sobre `description`.
- Item com texto vazio depois do `stripHtml` é descartado.
- `id` casa `/^[a-zA-Z0-9]+$/` e é o mesmo para a mesma URL em duas execuções — **o invariante da
  citação**: `extractCitations` só reconhece `[a-zA-Z0-9]+`.
- `Object.keys(passage)` é exatamente o conjunto de chaves de `Passage` — nenhum campo numérico de
  placar, a regra de ouro no lado do texto.

`tests/sources/facts.test.ts` (`fetch` global mockado)
- Sem `matchweek`, usa `currentMatchday` da competição.
- `getFacts({ team })` filtra do lado do cliente; time desconhecido devolve `matches: []` e **não
  lança**; competição diferente devolve `matches: []`.
- 429 do football-data.org **lança**, com a mensagem citando o rate limit.
- Sem jogo `live`, **a API-Football não é chamada** (nenhuma requisição para o host dela).
- Com jogo `live` e a API-Football devolvendo 500, `getFacts` **resolve** com o placar do
  football-data.org.
- **Isolamento de fonte (regra de ouro na fronteira)**: `getFacts` só faz requisição para
  `api.football-data.org` e `v3.football.api-sports.io`; `listPassages` só para o host do feed.
  Nenhuma das duas cruza para o outro lado.

`tests/sources/time.test.ts`
- `toSaoPauloIso` sobre `Z`, sobre `+00:00` e sobre `pubDate` RFC-822 dá o mesmo instante em
  `-03:00`.
- Entrada inválida lança.

`tests/ingestion/indexer.test.ts` (novo, com sources e vectorstore mockados)
- Fonte devolvendo `[]` faz `indexPassages` **lançar antes** de chamar `ensureCollection` — o
  índice não é apagado.
- `matchweek` do payload vem de `facts.matchweek`; `matchId: null` passa pelo
  `passagePayloadSchema`.

`tests/setup.test.ts` (alterado)
- `FOOTBALL_DATA_TOKEN` ausente faz `loadEnv()` lançar; `API_FOOTBALL_KEY` ausente **não** lança.
- `API_FUTEBOL_TOKEN` não existe mais no tipo `Env` (asserção de compilação com
  `@ts-expect-error`, no estilo já usado em `tests/models.test.ts`).

Integração (`npm run test:integration`)
- `tests/integration/recall.test.ts` — indexa o fixture na coleção de avaliação e mede
  `recall@5 >= 0.8`; o relatório `perQuestion` continua sendo impresso. Referência: `0.929`.
- `tests/integration/golden-rule.test.ts` — igual à tarefa 00 (3 execuções, p07 recuperado, placar
  da API presente, placar do p07 ausente em toda grafia, nenhum número órfão), agora com o dublê
  mockado e a coleção própria. Dois ajustes: `findOrphanNumbers` passa a aceitar `match.minute`
  como número com lastro, e troca `new Date(...).getDate()` por `isoDateParts` de
  `src/generation/match-format.ts` — o teste ainda carrega o bug de fuso que a revisão corrigiu no
  código de produção.
- `tests/integration/live-sources.test.ts` (novo, rede real, `skipIf(LLM_CASSETTE === "replay")`) —
  só invariantes estruturais, conforme a seção 12, item 3.

O `LLM_CASSETTE` **não** é estendido para os hosts das APIs de futebol e do RSS: o determinismo
dessa parte vem dos payloads gravados em `tests/fixtures/http/`, que são mais legíveis e vivem
junto dos testes que os usam. Os cassettes existentes precisam ser **regravados** ao fim da
tarefa, porque o prompt do `extractEntity` muda (seção 11).

### 16. Arquivos a criar ou alterar

**Criar**
```
src/sources/competition.ts
src/sources/teams.ts
src/sources/teams.json
src/sources/http.ts
src/sources/time.ts
src/sources/football-data.ts
src/sources/api-football.ts
src/sources/feeds.ts
src/sources/rss.ts
src/sources/facts.ts
src/sources/passages.ts
src/cli/sources.ts
tests/fixtures/fixture-source.ts                 (movido de src/sources/fixture.ts)
tests/fixtures/fixture-schema.ts                 (movido de src/sources/fixture-schema.ts)
tests/fixtures/brasileirao-2026-matchweek-12.json (movido de src/sources/fixtures/)
tests/fixtures/http/football-data-competition.json
tests/fixtures/http/football-data-matchweek.json
tests/fixtures/http/api-football-live.json
tests/fixtures/http/gazeta-feed.xml
tests/sources/teams.test.ts
tests/sources/football-data.test.ts
tests/sources/api-football.test.ts
tests/sources/rss.test.ts
tests/sources/facts.test.ts
tests/sources/time.test.ts
tests/ingestion/indexer.test.ts
tests/integration/live-sources.test.ts
docs/learning/02-data-sources.md
```

**Alterar**
```
src/sources/index.ts            passa a reexportar facts/passages/teams/competition
src/sources/types.ts            tipos de domínio (Match, Passage, Team, Score) sem zod
src/vectorstore/types.ts        matchId nulável
src/ingestion/indexer.ts        matchweek de facts; guard de lista vazia
src/agent/nodes/extract-entity.ts  listTeams() + COMPETITION no lugar de getFacts({})
src/generation/writer.ts        "postponed" e minuto do jogo live
src/agent/trace.ts              idem
src/config/env.ts               FOOTBALL_DATA_TOKEN, API_FOOTBALL_KEY; sai API_FUTEBOL_TOKEN
.env.example                    idem
package.json                    dependência fast-xml-parser; script "sources"
README.md                       chaves das duas APIs, npm run sources
tests/setup.test.ts             novas variáveis
tests/sources.test.ts           vira tests/fixtures-source.test.ts (o dublê continua testado)
tests/integration/recall.test.ts      indexa o fixture; coleção própria
tests/integration/golden-rule.test.ts idem, + minute e isoDateParts
tests/integration/__cassettes__/llm-calls.json  regravado
```

**Apagar**: `src/sources/fixture.ts`, `src/sources/fixture-schema.ts`,
`src/sources/fixtures/` (os três viraram os arquivos movidos acima).

### 17. Fora de escopo desta tarefa

- **Cadência, cache e agendamento** de qualquer chamada — decisão 6 do discovery, explicitamente
  adiada para a tarefa 02. O único cache é a memória do processo em `fetchCompetition`.
- **Deduplicação entre execuções, obsolescência, tagueamento por LLM e classificação de
  `PassageType`** — tarefa 02. Aqui `type` é sempre `"article"` e o `teams` sai de casamento
  literal contra a lista curada.
- **Tabela de classificação (`standings`)**. `/v4/competitions/BSA/standings` existe e entraria
  como campo novo em `Facts` — mas isso puxa writer, trace, prompt e o conjunto de números com
  lastro do teste da regra de ouro. Ver ponto em aberto 4.
- **Buscar o corpo completo da matéria** na página do artigo (o feed dá o que dá), **scraping** de
  qualquer tipo, e feeds além dos decididos no discovery (`meutimao.com.br` fica de fora).
- **Outras competições.** Escopo é Série A (discovery, item 1). `COMPETITION` é uma constante, não
  uma lista — quando virar lista, é mudança de configuração.
- **Rate limiter global, fila de requisições, retry com backoff.** 2 requisições por pergunta
  contra um limite de 10/min não justifica a maquinaria; 429 vira erro legível.
- **Chunking, peso de metadado, decaimento temporal, loops de feedback** — tarefas 03 a 06.
- **Mexer no `tsconfig.json`.** Segue sendo pré-condição.

### 18. Pontos em aberto para o usuário

Cinco decisões que não são minhas. A implementação não começa antes delas.

1. **A URL exata do segundo feed RSS.** O discovery registra "feed geral e um específico de times
   do Brasil", testados ao vivo, mas não guardou os endereços. Só posso confirmar o padrão do
   feed geral (`https://www.gazetaesportiva.com/feed/`). Preciso da URL do segundo — ou da
   confirmação de que a tarefa começa só com o geral.

2. **Item de feed sem time reconhecido: indexar ou descartar?** O feed geral da Gazeta traz
   vôlei, F1 e basquete. Descartar quem tem `teams: []` é uma linha e mantém o índice limpo;
   manter tudo é mais fiel a "a tarefa 01 busca, a tarefa 02 decide o que fica". Minha inclinação
   é **descartar já**, porque índice poluído estraga o `npm run ask` desta mesma tarefa — mas é
   decisão editorial, e o filtro de relevância roça o território da tarefa 02.

3. **Quem preenche `teams.json`, e com quais apelidos.** São ~20 times, cada um com `name`,
   `aliases`, `nicknames` e o `footballDataId`. Os ids eu não tenho como levantar sem a sua chave.
   Duas saídas: (a) o implementador roda com a sua chave, lê `/v4/competitions/BSA/teams` e
   preenche; (b) eu especifico um `npm run sources -- --teams` que imprime a lista da API para
   você colar e revisar. Os **apelidos** são editoriais e valem a sua revisão de qualquer forma —
   são eles que fazem "o alviverde" virar `palmeiras`.

4. **`standings` entra agora ou depois?** O discovery cita "tabela" ao escolher o
   football-data.org, mas o contrato `Facts` da tarefa 00 não tem esse campo e nada no sistema o
   consome hoje. Acrescentá-lo é uma chamada a mais e mudanças em writer, trace e no teste da
   regra de ouro. Deixei **fora**; se a intenção era ter tabela já nesta tarefa, é um adendo de
   umas 3 seções.

5. **`API_FOOTBALL_KEY` opcional ou obrigatória?** Especifiquei **opcional** (fonte secundária de
   enriquecimento, e o sistema responde sem ela com o placar do football-data.org). O custo é que
   dá para rodar sem perceber que o placar ao vivo está atrasado. Obrigatória torna o
   comportamento sempre igual, ao preço de exigir duas chaves para o projeto subir.

## Implementação

Implementado em 2026-09-10 contra a spec da seção "Refinamento técnico", sem reabri-la.

### O que foi criado

Todos os arquivos da seção 16 ("Criar") existem: `src/sources/{competition,teams,http,time,
football-data,api-football,feeds,rss,facts,passages}.ts` + `src/sources/teams.json`;
`src/cli/sources.ts`; o dublê de teste movido para `tests/fixtures/{fixture-source.ts,
fixture-schema.ts,brasileirao-2026-matchweek-12.json}`; os payloads gravados em
`tests/fixtures/http/{football-data-competition.json,football-data-matchweek.json,
api-football-live.json,gazeta-feed.xml}`; os testes de unidade
`tests/sources/{teams,football-data,api-football,rss,facts,time}.test.ts` e
`tests/ingestion/indexer.test.ts`; o teste de integração `tests/integration/live-sources.test.ts`;
e `docs/learning/02-data-sources.md`.

### O que foi alterado

`src/sources/{index,types}.ts` (fronteira e tipos de domínio, sem `zod`); `src/vectorstore/
types.ts` (`matchId` nulável); `src/ingestion/indexer.ts` (matchweek de `facts`, guard de lista
vazia); `src/agent/nodes/extract-entity.ts` (`listTeams()` + `COMPETITION` no lugar de
`getFacts({})`); `src/generation/writer.ts` e `src/agent/trace.ts` (`"postponed"` e minuto do
jogo `live`); `src/config/env.ts`, `.env.example` (`FOOTBALL_DATA_TOKEN`, `API_FOOTBALL_KEY`,
saída de `API_FUTEBOL_TOKEN`); `package.json` (`fast-xml-parser`, script `"sources"`);
`README.md` e `docs/learning/README.md`; `tests/setup.test.ts`, `tests/graph.test.ts` (novas
variáveis); `tests/fixtures-source.test.ts` (renomeado de `tests/sources.test.ts`);
`tests/integration/{recall,golden-rule}.test.ts` (indexam o fixture eles mesmos, coleção própria
`camisa10-eval`); `tests/integration/__cassettes__/llm-calls.json` (regravado).

**Apagados**: `src/sources/fixture.ts`, `src/sources/fixture-schema.ts`, `src/sources/fixtures/`
— movidos para `tests/fixtures/`, não apagados de fato (seção 12 da spec).

### Pendência que bloqueou parte do trabalho: `FOOTBALL_DATA_TOKEN` ausente

O `.env` do usuário não tinha `FOOTBALL_DATA_TOKEN` (só `API_FOOTBAL_KEY`, com o typo que a
tarefa pedia para corrigir, e `API_FUTEBOL_TOKEN`, da API descartada no discovery). Confirmado
ao vivo: `curl` sem token contra `/v4/competitions/BSA` devolve `403`. Seguindo a instrução
explícita de quem me chamou para este caso exato, **parei só a etapa de levantamento de
`teams.json` contra a API real** e segui implementando o resto contra o schema e payloads
gravados — não bloqueei a tarefa inteira por uma chave faltando. Duas consequências práticas:

1. **`.env` do usuário**: corrigi `API_FOOTBAL_KEY` → `API_FOOTBALL_KEY` (o valor da chave real
   do API-Football não mudou) e adicionei `FOOTBALL_DATA_TOKEN=PLACEHOLDER_NEEDS_REAL_TOKEN` —
   um valor **não-real**, só para `loadEnv()` não lançar e travar tudo (CLI, testes de unidade
   que usam `fakeEnv`, os dois testes de integração que mockam a fonte). Está marcado em
   comentário no próprio `.env` como pendência. **O usuário precisa registrar uma chave real em
   https://www.football-data.org/client/register e substituir esse valor.**
2. **`tests/fixtures/http/football-data-{competition,matchweek}.json`**: não puderam ser
   gravados contra a API real. Em vez de inventar um formato adivinhado (proibido pela
   instrução), usei o payload **literal do exemplo já confirmado na spec aprovada** (seção 6,
   que registra "confirmado ao vivo" durante o discovery/refinamento), estendido com mais jogos
   para cobrir os casos de teste da seção 15 (`POSTPONED`, `IN_PLAY`, placar nulo em jogo
   encerrado, status desconhecido). Isso está documentado dentro do próprio JSON (campo
   `_fixtureNote`, descartado pelo `z.object` não-estrito no parse). `api-football-live.json` é
   diferente: **gravado ao vivo de verdade**, com a chave real do usuário (`API_FOOTBALL_KEY`
   funciona) — só a entrada `league.id: 71` (Brasileirão) foi escrita à mão porque não havia
   jogo do Brasileirão ao vivo no momento da gravação; o formato inteiro (todos os outros campos)
   é o confirmado pela chamada real.
3. **`tests/integration/live-sources.test.ts`**: escrito conforme a spec, mas **não pôde ser
   confirmado passando** — `getFacts({})` falha com `football-data.org request failed: 400` (o
   token placeholder é rejeitado). O segundo teste do arquivo (`listPassages`) passa, porque fala
   só com o RSS, que é real e não depende do token. Isso não é um bug: é o comportamento correto
   e legível da tabela de erro da seção 6 diante de um token inválido.

### `teams.json`: dados estruturais sem a API real — pendência explícita de revisão

Sem `FOOTBALL_DATA_TOKEN`, não consegui rodar `GET /v4/competitions/BSA/teams` para levantar
`footballDataId` real. O arquivo tem os ~20 times mais tradicionais da Série A (conhecimento
geral, não a lista oficial confirmada da temporada 2026 — que depende do resultado do
rebaixamento/acesso de 2025, fora do meu conhecimento confiável). Para cada time:

- **`id` (slug), `name`, `nicknames`, `aliases`**: preenchidos com conhecimento geral de domínio
  público (apelidos populares de times brasileiros), como a instrução autorizou.
- **`footballDataId`**: só dois valores são reais, porque vieram **literalmente da spec aprovada**
  (seção 5, que registra tê-los confirmado ao vivo no discovery): Palmeiras `1769` e Atlético
  Mineiro `1766`. Fluminense `1765` também é real — não veio da seção 5, mas do exemplo literal
  da seção 6 (mesma origem: discovery testado ao vivo). **Os outros 17 times têm
  `footballDataId` placeholder, na faixa 900001–900020**, deliberadamente fora do intervalo real
  da API (que fica na casa dos milhares) para não serem confundidos com um id de verdade.

**Isso precisa de revisão do usuário antes de ser considerado definitivo** — tanto a lista de
apelidos/aliases (curadoria editorial, não minha) quanto, mais importante, os 17
`footballDataId` placeholder (sem os quais o enriquecimento ao vivo e a resolução de nome por id
não funcionam para esses times: `teamIdFromFootballData` cai no slug sintético com
`console.warn`, o que é degradação graciosa, não erro, mas não é o comportamento final
pretendido). Depois de obter `FOOTBALL_DATA_TOKEN`, rodar:

```bash
curl -H "X-Auth-Token: $FOOTBALL_DATA_TOKEN" https://api.football-data.org/v4/competitions/BSA/teams
```

e substituir os 17 valores placeholder pelos `id` reais da resposta.

### Decisões tomadas dentro do espaço que a spec deixou em aberto

- **`season` em `fdMatchSchema` virou opcional**, exatamente como a nota técnica da aprovação da
  spec pediu para eu verificar. Sem `FOOTBALL_DATA_TOKEN` não dava para confirmar contra a API
  real se o campo existe na resposta de `/matches` — deixei opcional (`z.object({...}).optional()`)
  em vez de obrigatório, para não quebrar a primeira chamada real caso o campo realmente não
  exista lá (o que o próprio texto da nota já suspeitava, já que `mapMatches` nunca o lê).
- **`mapMatches` recebe `raw: unknown`, não `raw: FootballDataMatches`** como o texto literal da
  seção 6 diz. Esse tipo nunca é definido em lugar nenhum da spec, e a composição literal da
  seção 8 (`mapMatches(await fetchMatchweek(matchweek))`) só compila se `mapMatches` aceitar o
  que `fetchMatchweek` devolve — que a mesma seção 6 tipa como `Promise<unknown>`. Resolvi a
  favor da composição literal: `mapMatches` valida com `footballDataMatchesSchema` internamente
  (mesmo padrão de fronteira usado no resto do projeto) e continua "pura" no sentido que importa
  — sem rede, testável direto contra `JSON.parse(fixture)`.
- **`parseFeed` sempre devolve `teams: []`, e quem tagueia é `listPassages`, não `parseFeed`**.
  A spec declara `parseFeed` como síncrona ("Puro: XML cru -> passages"), mas `tagTeams` é
  assíncrona (lê `teams.json` do disco). Não dá para uma função síncrona chamar `await
  tagTeams(...)` como a tabela de mapeamento da seção 9 sugere linha a linha. Resolvido mantendo
  `parseFeed` síncrona e testável sem I/O (o que a spec pede explicitamente), e movendo a
  tagueação para `listPassages()` — que já é assíncrona e já é o lugar que agrega passages de
  todos os feeds antes de dedup/ordenar, então tagueá-los ali é uma etapa a mais no mesmo
  agregador, não um módulo novo.
- **Item sem time reconhecido: descartado**, decisão 2 já aprovada — implementado como um
  `.filter((passage) => passage.teams.length > 0)` em `listPassages()`, depois da tagueação.
- **`http.ts` expõe duas classes de erro (`HttpStatusError`, `HttpTimeoutError`) em vez de uma
  mensagem já formatada.** A spec só descreve o *resultado* esperado de cada fonte (a tabela de
  erro da seção 6, específica do football-data.org). Como `http.ts` é compartilhado pelas três
  fontes e cada uma precisa de uma mensagem diferente para o mesmo status (429 e 403 só fazem
  sentido nomeando "football-data.org"; a API-Football nunca lança), fazia mais sentido o módulo
  compartilhado expor o dado estruturado (status, headers, method, path) e cada cliente compor a
  frase certa — em vez de `http.ts` adivinhar de qual fonte veio a chamada.
- **`golden-rule.test.ts` ganhou uma pausa de 20s entre as 3 chamadas a `answer()` quando não há
  `LLM_CASSETTE`.** Não estava na spec. Descoberto depurando uma falha "invalid setup" que se
  repetia sempre na 3ª chamada, nunca na 1ª ou 2ª — nada a ver com o score do p07 estar perto do
  corte (o que a tarefa 00 documentou como a causa da variância *antiga*). Instrumentei a saída
  do `context` de cada run e vi: `run 3 context=[]` — busca vazia, não busca com score baixo. A
  causa real: esta tarefa passou a indexar o fixture na própria suíte (`indexPassages()` no
  `beforeAll`, decisão 2 da seção 12), somando **uma chamada de embedding a mais** por execução
  do arquivo. Isso empurra o total para 4 chamadas Voyage num minuto (index + 3 buscas), acima do
  limite de 3 req/min do tier gratuito sem cartão — o `runFanOut` com `Promise.allSettled` (spec
  §6) converte esse 429 em `context: []` silencioso em vez de propagar o erro, então o sintoma
  não parecia rate limit. A pausa evita isso numa execução real; é pulada quando `LLM_CASSETTE`
  está definido (replay não bate na API de verdade, e o cassette já foi gravado espaçando as
  chamadas manualmente).
- **`beforeAll` de `recall.test.ts` e `golden-rule.test.ts` ganhou timeout explícito de 30s.** O
  default do Vitest (alguns segundos) não é suficiente agora que o `beforeAll` também indexa o
  fixture (`embedAll` + `ensureCollection` + `insertPoints`), não só mede/consulta.

### Onde a implementação não seguiu a spec ao pé da letra, e por quê

Além dos dois pontos de resolução de ambiguidade acima (`mapMatches`, `parseFeed`/`tagTeams`),
que considero preencher lacunas e não desvios de comportamento pretendido: nenhum outro desvio
consciente. A regra de ouro na fronteira (`getFacts` só fala com as duas APIs de fato,
`listPassages` só com o RSS) está testada e de pé (`tests/sources/facts.test.ts`, caso de
isolamento de fonte).

### O que foi visto e não foi feito, por estar fora de escopo

Nada além do que a seção 17 já lista. Não toquei em `standings`, cadência/cache, deduplicação
entre execuções, outras competições, nem `tsconfig.json`. Não criei um segundo feed RSS (ponto
em aberto 1, adiado pela aprovação). Não busquei corpo completo de matéria nem fiz scraping.

### Testes

**Unidade** (`npm test`, sem rede/Docker): `tsc --noEmit` limpo, seguido de `vitest run` —
**76 testes, 13 arquivos, todos passando** (eram 32 depois da revisão da tarefa 00; a diferença
são os 6 arquivos novos em `tests/sources/` + `tests/ingestion/indexer.test.ts` + os testes de
compilação de `tests/setup.test.ts`).

**Integração** (`npm run test:integration`, Qdrant real via `docker compose up -d`):

- `tests/integration/vectorstore.test.ts` — **3/3 passando**, sem mudança de comportamento.
- `tests/integration/recall.test.ts` — **2/2 passando**. `recall@5 = 0.929`, idêntico ao número
  da tarefa 00 (fixture e modelo de embedding não mudaram, só onde/quando a coleção é montada) —
  confirma que mover a indexação para dentro do teste (decisão 2 da seção 12) não regrediu
  retrieval. O único miss continua sendo `e01` (apelido "alviverde" sem o nome do time), o mesmo
  caso adversarial já registrado na tarefa 00.
- `tests/integration/golden-rule.test.ts` — **passou, 3/3 execuções**, depois do ajuste de
  pausa descrito acima (sem ele, falhava de forma consistente na 3ª chamada por rate limit da
  Voyage, não por variância de retrieval).
- `tests/integration/live-sources.test.ts` — **não pôde ser confirmado passando**:
  `getFacts` falha (token placeholder rejeitado, `400`); `listPassages` passa (RSS real, 50
  itens brutos no feed gravado). Ver a seção de pendência acima.

**`LLM_CASSETTE`**: regravado por completo (`LLM_CASSETTE=record`), porque o prompt do
`extractEntity` mudou (usa `listTeams()`/`COMPETITION` em vez de `getFacts({})`). Seguido o
cuidado documentado na tarefa 00: cada tentativa de gravação foi feita **backup → tentativa → se
falhar (rate limit ou "invalid setup"), restaurar o backup e tentar de novo**, nunca gravando em
cima de uma tentativa parcial. `golden-rule.test.ts` e `recall.test.ts` foram gravados em
execuções separadas, espaçadas, para não competir pelo limite de 3 req/min da Voyage.
`LLM_CASSETTE=replay npm run test:integration` roda a suíte inteira (exceto `live-sources.test.ts`,
pulado por `describe.skipIf`) em **~1.2s**, 6 testes passando, 2 pulados. O arquivo
`tests/integration/__cassettes__/llm-calls.json` continua só com o header `content-type`
sobrevivendo à allowlist (confirmado por script depois da gravação).

`npm run sources` foi verificado sem `FOOTBALL_DATA_TOKEN` real: falha com a mensagem clara do
`loadEnv()` e código de saída 1 — não pôde ser verificado mostrando dado real, pela mesma
pendência de chave.

## Revisão
_A preencher — decisão do usuário, fora desta implementação._

## Testes
Além dos testes de unidade dos nós, dois que valem para o projeto inteiro (ver seção
"Implementação" acima para o resultado real):

- **`recall@k` no conjunto de avaliação** — a pergunta recupera o trecho que deveria?
  `recall@5 = 0.929`, medido contra o fixture indexado numa coleção própria (`camisa10-eval`).
- **Invariante da regra de ouro** — nenhum número na resposta final sem lastro nos fatos da API.
  3/3 execuções reais, mais o isolamento de fonte testado em `tests/sources/facts.test.ts`.
