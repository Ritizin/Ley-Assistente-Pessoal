import { restoreStorageFromRemote, startPeriodicBackup } from "./core/storage-sync.js";
import { logger } from "./core/logger.js";

// Esse arquivo (não server.ts) é o entrypoint de verdade — ver package.json
// (scripts.dev e scripts.start). O motivo de existir: llm/db.ts abre o
// storage/ley.db assim que é IMPORTADO (efeito colateral no topo do
// módulo), então restaurar o backup depois que o server.ts (e tudo que ele
// importa) já carregou seria tarde demais — o arquivo local já teria sido
// criado vazio. Por isso o import do server.ts aqui é DINÂMICO: só acontece
// depois que restoreStorageFromRemote() já terminou.
async function main(): Promise<void> {
  await restoreStorageFromRemote();
  await import("./server.js");
  startPeriodicBackup();
}

// Sem o catch aqui, um erro em main() (ex: falha ao importar ./server.js)
// virava uma unhandledRejection silenciosa — mesmo problema de fundo do bug
// corrigido em server.ts: o processo "segue rodando" sem nunca ter chegado
// perto de abrir a porta, e o Render acha que é um crash comum quando na
// verdade nunca havia nada de pé.
main().catch((err) => {
  logger.error({ err }, "falha fatal no bootstrap — encerrando processo");
  process.exit(1);
});
