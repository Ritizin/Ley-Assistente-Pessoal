// src/modules/llm/uploaded-files.ts
//
// Guarda, por conversa, o último arquivo que o usuário anexou no chat
// (/api/chat/upload) — usado pelo send-file-flow pra saber QUAL arquivo
// mandar quando o usuário pede "manda esse arquivo pra fulano" logo depois
// de anexar algo. Mesmo princípio dos outros estados em memória (*-flow.ts):
// app single-user local, não precisa persistir em disco.

export interface UploadedFileRef {
  path: string;
  filename: string;
  mimetype: string;
}

const lastUploaded = new Map<string, UploadedFileRef>();

export function setLastUploadedFile(conversationId: string, file: UploadedFileRef): void {
  lastUploaded.set(conversationId, file);
}

export function getLastUploadedFile(conversationId: string): UploadedFileRef | undefined {
  return lastUploaded.get(conversationId);
}

export function clearLastUploadedFile(conversationId: string): void {
  lastUploaded.delete(conversationId);
}
