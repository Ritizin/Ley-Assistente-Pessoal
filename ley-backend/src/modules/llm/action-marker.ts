// Convenção compartilhada entre os fluxos de chat (save-contact, block-contact,
// create-group, task) e o frontend (GeneratedContent.tsx): quando uma resposta
// é resultado de uma AÇÃO DE VERDADE (algo foi criado/editado/bloqueado no
// banco, não só uma resposta de texto), ela vem prefixada com esse marcador.
// O frontend detecta, extrai o rótulo e renderiza um selinho tipo
// "✓ Tarefa criada" antes do texto normal — igual ao "Editou 2 arquivos" que
// aparece nas respostas do Claude quando ele usa uma ferramenta.
const MARKER_PREFIX = "\u27e6ACTION:";
const MARKER_SUFFIX = "\u27e7";

export function withAction(label: string, reply: string): string {
  return `${MARKER_PREFIX}${label}${MARKER_SUFFIX}${reply}`;
}

// usado ao montar o histórico que vai pro modelo (Groq) — o marcador é só
// pro frontend desenhar o selinho, o modelo não precisa (nem deve) ver essa
// sintaxe interna nas mensagens passadas de novo como contexto.
const MARKER_RE = /^\u27e6ACTION:[^\u27e7]+\u27e7/;

export function stripActionMarker(text: string): string {
  return text.replace(MARKER_RE, "");
}
