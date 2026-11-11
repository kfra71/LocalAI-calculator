# LocalAI-TCO by Dinova

**Dimensiona il tuo modo per l'AI locale e privata.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-LocalAI--TCO-2ea44f)](https://localai-tco.dinova.one/)

> Trova il vincolo che lega davvero — poi dimensiona lo stack locale e privato che ci sta.

Tre limiti determinano il minimo tecnico per un singolo modello testuale residente:
la memoria per la KV cache, il serving combinato prefill/decode e il tetto di
sessioni del runtime. Sono valutati in modo esplicito e uno o più possono legare — di
solito non il limite per cui le persone dimensionano. LocalAI-TCO li individua, li
prezza e confronta le alternative eleggibili che puoi davvero usare nel percorso
verso la AI locale e privata.

Solo frontend. Nessuna fase di build, nessun server, nessun database, nessun account, nessuna
telemetria. Tutto gira nella scheda del tuo browser e nulla di ciò che scrivi viene
trasmesso da nessuna parte.

**[Apri il calcolatore →](https://localai-tco.dinova.one/)**

## Funzionalità

- **Configurazione guidata** per la prima visita — forma dell'organico e modello, poi un
  risultato in tempo reale sul vincolo in pochi secondi. Riaprila in qualsiasi momento da
  **Configurazione guidata** nella testata.
- **Dimensiona le macchine** partendo dal tuo carico di lavoro reale, trattando utenti
  interattivi e agenti autonomi come i carichi strutturalmente diversi che sono.
- **Mostra quale vincolo lega** per ogni configurazione, così vedi quando stai per
  acquistare rispetto al limite sbagliato.
- **Confronta in modo trasparente**: hardware di proprietà, noleggio sovrano eleggibile e
  abbonamenti enterprise con API per token per gli agenti, segnalando le differenze di
  capacità e di servizio.
- **Segnala il proprio dominio**, e ti avvisa quando la tua installazione ha superato il
  modello.
- **Separa i dati misurati da quelli stimati.** Ogni profilo di hardware e di modello
  riporta un livello di confidenza, che compare nel report esportato. Le esecuzioni
  esatte modello/hardware in `data/profiles.json` sostituiscono le stime di banda
  (bandwidth) quando corrispondono.
- **Esporta un verbale di decisione** in Markdown e l'intero scenario in JSON, che puoi
  ricaricare in seguito.

## Perché esiste

La risposta onesta a *"dovremmo gestirlo in locale?"* è di solito una domanda di
dimensionamento con il vestito di una domanda di budget. La maggior parte dei confronti
che si trovano in internet sbaglia negli stessi tre modi:

1. **Dimensionano rispetto al vincolo sbagliato.** Acquistare rispetto a un limite che
   non lega è il modo in cui le organizzazioni finiscono con capacità che non usano mai
   — e il modo in cui mancano quello che li fermerà davvero sotto carico.
2. **Confrontano con la cosa sbagliata.** Se la tua ragione per andare in locale è la
   governance dei dati, un fornitore che non puoi verificare non è confrontabile a nessun
   prezzo. Rimane il noleggio dell'hardware da un fornitore sovrano, oppure
   l'abbonamento a un fornitore di cui ti fidi già per il tuo CRM.
3. **Dimenticano che l'hardware è la parte economica.** Il personale è di solito la voce
   di costo più grande, e non scompare quando noleggi invece di comprare — gestisci lo
   stesso software sull'hardware di qualcun altro.

Questo strumento rende esplicite le assunzioni. È uno stimatore di sensibilità direzionale,
non un preventivo d'acquisto; valida modello, runtime e hardware esatti prima dell'acquisto.

## Perché questo nome

**TCO** è *total cost of ownership*: il conto complessivo per far girare il carico di
lavoro, non solo l'hardware in fattura. **Local AI** è ciò per cui quel conto esiste —
inferenza che possiedi e gestisci invece di noleggiare a token. **LocalAI-TCO** è quindi
la domanda a cui questo strumento risponde: quanto costa possedere tutto, sull'orizzonte
considerato?

L'altra metà del nome è il vincolo che *lega*. Dei tre limiti che determinano il numero
di macchine, uno è di solito il vero soffitto, e dimensionare rispetto a quello sbagliato
è il modo in cui le organizzazioni finiscono con capacità che non usano mai. Trova prima
il vincolo che lega, poi dimensiona lo stack locale e privato che ci sta — quest'ordine
è tutto il punto.

## Struttura del progetto

```
index.html            punto d'ingresso
assets/styles.css     scritto a mano, nessun framework
src/engine.js         tutto il calcolo — funzioni pure, nessun import
src/io.js             export JSON e Markdown, import JSON
src/app.js            UI (React + htm via CDN, nessuna fase di build)
data/models.json      profili delle architetture dei modelli
data/hardware.json    catalogo dell'hardware e del noleggio
data/profiles.json    osservazioni esatte modello×hardware×runtime
data/defaults.json    valori iniziali, riferimenti di abbonamento, tabella dei settori
data/scenarios.json   preset della configurazione guidata (organico + carico + agenti)
data/benchmarks.json  storico delle esecuzioni misurate
data/schema/          schemi del catalogo e degli scenari salvati
tests/                controlli del motore e degli scenari
```

La separazione è voluta. **Aggiungere un modello, una macchina o un benchmark significa
modificare un solo file JSON**, non leggere l'applicazione.

## Come funziona

**Costo di un'ora.** Retribuzione annua lorda × coefficiente del datore di lavoro ÷ ore
lavorative, miscelata con una tariffa freelance in base alla quota di ore esternalizzate.

**Carico di lavoro.** Due popolazioni. Le persone lavorano in orario d'ufficio e
producono picchi violenti — il fattore di picco decresce come
`1 + k/√activePopulation`, dove la popolazione attiva pesa interamente gli sviluppatori e
in proporzione alla quota di concorrenza i ruoli occasionali, perché i picchi si
compensano con le persone che stanno effettivamente generando carico. Gli agenti autonomi
girano continuativamente con un profilo piatto e un tasso di hit della cache molto più
alto, perché ripetono gli stessi prompt a ogni ciclo. Ciascuno porta il proprio
fattore di picco, e il requisito di KV somma due lunghezze di contesto diverse.

**Modello.** Sei parametri di architettura, e tirano in direzioni diverse:

| Parametro | Cosa determina |
|---|---|
| Parametri totali | Quante GPU contengono i pesi |
| Parametri attivi | Quanto è veloce il decode — un MoE da 284B con 13B attivi occupa come un 284B e genera come un 13B |
| Byte per parametro | La precisione del checkpoint scelto. Le combinazioni hardware non supportate vengono escluse anziché convertite in silenzio |
| KV cache per token | Quante sessioni concorrenti entrano. Dipende dall'architettura dell'attenzione, non dalla dimensione |
| Token accettati per passo | Decoding speculativo: i pesi vengono letti una volta per passo, non per token |
| Rapporto prefill / decode | Perché l'input viene prezzato a una frazione dell'output pur costando molto meno di quella frazione |

**Dimensionamento.** KV e runtime sono limiti indipendenti. Prefill e decode condividono
il tempo dell'acceleratore, quindi il vincolo di serving combinato prefill/decode somma
i loro carichi normalizzati.
La raccomandazione aggiunge poi l'eventuale riserva di manutenzione configurata o N+1:

```
units = max(
  ceil(KV required ÷ KV per unit),             // memoria
  ceil(combined serving load ÷ util target),   // decode e prefill condividono il silicio
  ceil(sessions ÷ max concurrent per node)     // tetto del runtime
)
```

Il limite, o i limiti, che hanno prodotto il massimo sono quelli che legano. Tutto il resto ha
margine di capacità, e spendere denaro su margine di capacità è l'errore più comune
nell'intero esercizio.

**Costo.** CapEx, energia derivata dalla domanda alla tua tariffa e al tuo PUE, ore di
gestione alla tua tariffa oraria media, supporto, accantonamento esplicito per la
sostituzione e, opzionalmente, il margine derivante da capacità residua realmente
disponibile. I media (supporti di archiviazione) sono esclusi a meno che non venga fornito
separatamente un costo/profilo locale dei media misurato.

In breve: **un numero senza la sua configurazione non è riproducibile.** Ogni benchmark
registrato nel catalogo richiede la build del motore fissata, i flag esatti, la
concorrenza, se il traffico era sintetico o realistico e i modi di fallimento incontrati.

I livelli di confidenza fanno parte dei dati, non sono un'avvertenza:

| Livello | Significato |
|---|---|
| `measured` | Esecuzione di prima parte, build fissata, verificabile |
| `published` | Ricetta pubblica e riproducibile |
| `community` | Segnalazione non verificata; usata solo quando è attivo il suo profilo selezionato esplicitamente |
| `list-price` | Prezzo pubblicato dal fornitore |
| `aggregator` | Rilevatore di prezzi di terze parti, non il fornitore |
| `estimated` | Derivato da calcoli di bandwidth (banda) e memoria |
| `derived` / `kv-derived` | Calcolato da un'altra misurazione; verifica la derivazione e l'intervallo indicati |
| `template` | Un punto di partenza che sei tenuto a sostituire |

Anche le contraddizioni aperte vanno nei dati. Quando due esecuzioni non concordano,
registra perché — oppure risolvile quando le configurazioni non sono davvero confrontabili.
Il dato DeepSeek NVFP4-KV su Spark (~27,8 KB/token) e il dato community FP8-KV
(~10,6 KB/token) restano su voci di catalogo separate dopo quella risoluzione. Fai
come con i tuoi.

## Il catalogo dei modelli

Il catalogo copre la generazione pubblicata nel 2026. Ogni voce porta con sé il
checkpoint che misuri, la KV per token e le ricette in cui è stata provata:

| Modello | Checkpoint | KV per token | Ricette |
|---|---|---|---|
| Qwen3.6 35B-A3B | NVFP4, 22 GB | 11,58 KB (misurato su Spark) | 2× DGX Spark, DGX Station GB300 |
| Qwen3.8 27B | NVFP4, 21,9 GB | 32,8 KB FP8 (pubblicato da SGLang) | 2× DGX Spark, 2× RTX PRO 6000, DGX Station GB300 |
| Qwen3.8-Flash-Next | NVFP4, 132,7 GB con tabella PLE | 12,29 KB (derivato dalla configurazione) | 2× DGX Spark, 2× RTX PRO 6000, DGX Station GB300 |
| DeepSeek V4.1 Flash | misto MXFP4/MXFP8, 476 GiB | 1,67 KB (budget di boot log del deployment) | 4× B300 (derived dalle tabelle Dynamo a 8 GPU) |
| Nemotron 3.5 Super VL 120B-A12B | NVFP4, 75 GB | 4,1 KB (derivato dalla configurazione) | 1× B300 (derived dal report vendor) |
| GLM-5.3-Flash | NVFP4, 204,4 GB | 7,26 KB (derivato dal codice SGLang) | DGX Station GB300 |
| MiniMax M3.1-Flash | NVFP4, 252,4 GB | 33,75 KB NVFP4 / 60 KB FP8 (pubblicato) | 4× B300 |
| Muse Spark Open 816B-A42B | NVFP4, 533 GB | 33,84 KB (derivato dalla configurazione, cresce a contesto corto) | 4× B300 (derived dalla curva del vendor su 4× GB300) |

Quattro regole valgono per ogni ricetta, nuova o vecchia.

**La banda di decode è un aggregato di nodo, non una velocità per richiesta.** Molte
sweep pubblicano i tok/s per richiesta a ogni livello di concorrenza: 51,8 tok/s per
richiesta a C1 sulla coppia di DGX Spark di Qwen3.8 27B diventano 199,2 tok/s aggregati
a C8 e 310,4 a C32. Il calcolatore confronta l'aggregato con la domanda di token/s
dell'intero carico, quindi usare il numero per richiesta come aggregato sottovaluterebbe
la capacità di quasi un ordine di grandezza.

**Una ricetta misurata su una topologia diversa viene dichiarata, non riscritta.** Le
misure su una singola RTX PRO 6000 valgono come pavimento per scheda di un nodo con due
schede; le tabelle per GPU di B200 e GB200 sono mappate su B300 e dichiarate `derived`
nella nota del profilo.

**Le cifre per GPU non sono bande di decode.** I picchi pubblicati per GPU sommano
spesso input e output con prefisso in cache: usarli come banda di decode gonfierebbe
la capacità del nodo di quasi un ordine di grandezza. Quando la fonte pubblica un
aggregato di nodo per ogni livello di concorrenza — come la curva di Muse Spark Open,
1.910 tok/s aggregati a 16 richieste su 4× GB300 — la banda si costruisce su quel
numero, e non sulla cifra per GPU.

**Il costo della KV si prende dal deployment, non dalla scheda.** Il DeepSeek V4.1
costa 1,67 KB per token di contesto (la riga di budget del boot log: 1.670,75 B per
token), e un deployment con lo stesso checkpoint ma con i pesi scaricati in DRAM
ospite ne ha un altro: il numero che conta è quello del deployment che userai.

Nemotron 3 Bolt 74B-A9B non è in catalogo: il suo pacchetto da 24 GB è un GGUF a 2 bit
che questo strumento non sa dimensionare, e il catalogo hardware non ha uno SKU in quella
classe.

Il modello predefinito resta Qwen3.6 35B-A3B: è l'appliance flagship con la ricetta
pubblicata di riferimento, e il suo profilo MoE con 3B attivi tiene la KV a 11,58
KB/token. Qwen3.8 27B è più recente ma dense, e a parità di ingombro la sua KV per
token è quasi tre volte più pesante.

## Le configurazioni

Il calcolatore mette in fila questi nodi, ciascuno con la banda e il prezzo che
dichiarano:

| Configurazione | GPU | Memoria | Banda | Prezzo | Per cosa serve |
|---|---|---|---|---|---|
| 2× DGX Spark | 2 GB10 | 200 GB | 546 GB/s | $9.398 | appliance: un modello da 22-140 GB in NVFP4 |
| 4× DGX Spark (TP=4) | 4 GB10 | 400 GB | 1.092 GB/s | $18.796 | lo stesso modello con più concorrenza, o un checkpoint da 200-400 GB |
| 8× DGX Spark (TP=8) | 8 GB10 | 800 GB | 2.184 GB/s | $37.592 | checkpoint NVFP4 da 200-510 GB |
| DGX Station GB300 | 1 GB300 | 279 GB | 7.100 GB/s | $96.996 | l'appliance con HBM vero |
| 2× / 4× RTX PRO 6000 | 2-4 | 192-384 GB | 3.580-7.160 GB/s | $41.500-73.000 | nodi consumer per modelli fino a 200 GB |
| 8× RTX PRO 6000 | 8 | 768 GB | 14.320 GB/s | $146.000 | DeepSeek V4.1, MiniMax M3.1, Muse Spark Open in NVFP4 |
| 4× / 8× H200 | 4-8 | 564-1.128 GB | 19,2-38,4 TB/s | $175k-350k | la generazione precedente |
| 1× / 4× B300 | 1-4 | 288-1.152 GB | 8-32 TB/s | $83k-320k | datacenter Blackwell |

**I checkpoint NVFP4 e FP4 entrano nei calcoli solo dove il gate lo consente.** Su
Blackwell — Spark, RTX PRO 6000, B300 — i pesi restano nel loro ingombro reale: il
DeepSeek V4.1 è 510 GB, MiniMax M3.1 252 GB, Muse Spark Open 533 GB, e le stime
usano quelle cifre, non quelle del modello intero in FP8. Su Hopper non esistono
tensor core FP4: i checkpoint NVFP4 restano esclusi e chi ha una variante FP8 ricade
su FP8 con i pesi raddoppiati. È la differenza che decide quale hardware comprare.

Le configurazioni con TP=4 e TP=8 hanno una banda aggregata che cresce meno della
memoria, perché l'all-reduce attraversa il tessuto: per questo il prefill e
l'efficienza di quei nodi sono stimati, e dichiarati come stime. Vale la pena
saperlo quando guardi un totale: su un nodo Spark il **prefill**, non il decode,
detta il numero di unità, perché il prefill di una DGX Spark è un ordine di
grandezza sotto quello di un sistema con HBM. Dieci cluster da 8 Spark non sono
una scelta per un modello da 60 GB: sono il prezzo di un prefill che non scala.

Il nodo da 8× RTX PRO 6000 e quello da 8× DGX Spark esistono per i checkpoint
che altrove non entrano: DeepSeek V4.1 Flash (510 GB), MiniMax M3.1 (252 GB),
Muse Spark Open (533 GB). Per un modello da 22-140 GB sono dominate da nodi più
piccoli, e la tabella li mostra con la loro cifra perché il confronto spetti a te.

## Cosa questo strumento non vi dirà

Se il premio valga la pena di essere pagato. Lo stima sull'intervallo di evidenze
selezionato. Non stabilisce che modelli in abbonamento e modelli locali siano equivalenti
in qualità, latenza, contesto, strumenti o disponibilità. Se la governance dei dati
valga tanto per la tua organizzazione è una domanda sui tuoi contratti, sul tuo
regolatore e sulla tua propensione al rischio — e nessun foglio di calcolo vi risponde.

## Licenza

MIT. Vedi [LICENSE](LICENSE).

## Autore

**Juxhin Radhima**