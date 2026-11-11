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