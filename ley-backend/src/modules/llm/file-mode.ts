// src/modules/llm/file-mode.ts
//
// Ativa um "modo de geração de arquivos" quando o usuário manda um comando
// explícito no chat (ex: "/criar", "/gerar"). Nesse modo, injeta uma
// instrução extra no contexto mandado pro modelo pedindo pra ele formatar
// a resposta com blocos de código marcados com o caminho do arquivo
// (atributo path="..."), pra o frontend conseguir extrair cada bloco e
// oferecer download (card "Baixar" por arquivo + "Baixar tudo" em .zip).
//
// Importante: a IA só entra nesse modo quando o usuário explicitamente
// manda um desses comandos — não é uma decisão espontânea do modelo.

const FILE_COMMAND_PREFIXES = ["/criar", "/gerar", "/arquivo", "/gerar-arquivo"];

// pega pedido em linguagem natural: um verbo de criação ("cria", "gera",
// "faz", "monta"...) em qualquer lugar da frase, junto com "arquivo",
// "planilha", "script" ou uma extensão comum (.txt, .csv, .sql etc).
// Cobre casos como "cria um arquivo .txt com 10 senhas aleatórias" ou
// "gera uma planilha csv com clientes fictícios", sem precisar do "/".
const CREATE_VERB = /\b(cria|criar|crie|gera|gerar|gere|faz|fazer|monta|montar|monte|escreve|escrever|escreva)\b/i;
const FILE_NOUN =
  /\b(arquivo|arquivos|planilha|planilhas|script|scripts|documento|txt|csv|sql|json|env|py|js|ts|html|css|sh|yml|yaml|md)\b/i;

export interface FileCommandResult {
  isFileCommand: boolean;
  // mensagem sem o prefixo do comando (ex: "/criar um script de backup" -> "um script de backup")
  cleanMessage: string;
}

export function detectFileCommand(message: string): FileCommandResult {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  const prefix = FILE_COMMAND_PREFIXES.find((p) => lower.startsWith(p));
  if (prefix) {
    const cleanMessage = trimmed.slice(prefix.length).replace(/^[:\s-]+/, "").trim();
    return { isFileCommand: true, cleanMessage: cleanMessage || trimmed };
  }

  // sem "/", mas o pedido em si já é um pedido explícito de arquivo
  if (CREATE_VERB.test(lower) && FILE_NOUN.test(lower)) {
    return { isFileCommand: true, cleanMessage: trimmed };
  }

  return { isFileCommand: false, cleanMessage: message };
}

// instrução injetada no CONTEXTO da mensagem do usuário (mesmo mecanismo do
// taskContext já usado em chat.service.ts) só quando isFileCommand é true —
// não altera o system prompt/personalidade da Ley em nenhum outro momento.
export const FILE_MODE_INSTRUCTION = `

[SISTEMA - MODO DE GERAÇÃO DE ARQUIVOS ATIVADO]
O usuário pediu EXPLICITAMENTE pra você criar arquivo(s) (código, planilha em CSV, SQL, script, config, HTML etc). Formate a resposta seguindo essas regras à risca, mas mantendo seu jeito de falar no texto entre os blocos:

1. Para CADA arquivo a ser criado, use um bloco de código markdown com a linguagem e o caminho relativo do arquivo no atributo "path":
\`\`\`linguagem path="caminho/relativo/nome-do-arquivo.ext"
(conteúdo completo e funcional do arquivo aqui)
\`\`\`

2. Para comandos de terminal que o usuário precisa rodar (npm, git, bash etc), use um bloco separado SEM o atributo "path":
\`\`\`bash
comando aqui
\`\`\`

3. Depois de todos os blocos, escreva um resumo curto: o que foi feito em cada arquivo, em qual pasta do projeto salvar cada um, e o passo a passo de comandos pra aplicar.

4. Gere conteúdo real e completo pro que foi pedido, nunca um placeholder vazio.`;
