import { db } from "../llm/db.js";
import "./whatsapp.db.js"; // garante que as tabelas existem antes de preparar os statements

export type WaMessageType = "text" | "audio" | "other";

export interface WaMessageRow {
  id: string;
  jid: string;
  from_me: number;
  sender_name: string | null;
  type: WaMessageType;
  text: string | null;
  transcript: string | null;
  media_path: string | null;
  media_mimetype: string | null;
  seen: number;
  created_at: number;
}

export interface WaContactRow {
  jid: string;
  name: string | null;
  updated_at: number;
  source?: "seen" | "saved";
  is_group?: number;
}

const stmts = {
  upsertContact: db.prepare(`
    INSERT INTO wa_contacts (jid, name, updated_at) VALUES (@jid, @name, @updated_at)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `),
  saveContact: db.prepare(`
    INSERT INTO wa_contacts (jid, name, updated_at, source) VALUES (@jid, @name, @updated_at, 'saved')
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, source = 'saved'
  `),
  // grupos são upsertados com o "subject" (nome do grupo) vindo do próprio
  // WhatsApp (groupMetadata), nunca do pushName de quem mandou a mensagem —
  // isso é o que diferencia esse upsert do upsertContact normal
  upsertGroupContact: db.prepare(`
    INSERT INTO wa_contacts (jid, name, updated_at, is_group) VALUES (@jid, @name, @updated_at, 1)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, is_group = 1
  `),
  // BUG corrigido aqui: era ON CONFLICT(id) DO NOTHING. Um mesmo id de
  // mensagem pode ser gravado duas vezes por dois caminhos diferentes: o
  // save explícito que sendText/sendAudio fazem na hora (whatsapp.service.ts)
  // e o eco que o próprio Baileys às vezes manda de volta como evento
  // "messages.upsert" pra mensagens que a gente mesmo enviou. Quando o eco
  // chegava primeiro — por exemplo, tentando baixar o áudio da própria
  // mensagem antes do CDN do WhatsApp propagar, e falhando — ele gravava a
  // linha com media_path NULL, e o DO NOTHING fazia o save de verdade (com
  // o media_path certo, que a gente já tinha em mãos) ser silenciosamente
  // ignorado. Resultado: mensagem aparecia na conversa mas sem áudio pra
  // tocar. Agora, não importa qual dos dois chega primeiro, o COALESCE
  // preenche esses campos com o que tiver de mais completo sem nunca
  // apagar um valor bom com um NULL que chegou depois.
  insertMessage: db.prepare(`
    INSERT INTO wa_messages
      (id, jid, from_me, sender_name, type, text, transcript, media_path, media_mimetype, seen, created_at)
    VALUES
      (@id, @jid, @from_me, @sender_name, @type, @text, @transcript, @media_path, @media_mimetype, @seen, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      text = COALESCE(wa_messages.text, excluded.text),
      transcript = COALESCE(wa_messages.transcript, excluded.transcript),
      media_path = COALESCE(wa_messages.media_path, excluded.media_path),
      media_mimetype = COALESCE(wa_messages.media_mimetype, excluded.media_mimetype)
  `),
  listRecent: db.prepare(`SELECT * FROM wa_messages ORDER BY created_at DESC LIMIT ?`),
  listUnread: db.prepare(
    `SELECT * FROM wa_messages WHERE seen = 0 AND from_me = 0 ORDER BY created_at ASC`
  ),
  // ORDER BY ... DESC LIMIT ? pega as N mensagens MAIS RECENTES (não as mais
  // antigas). listMessagesByJid() abaixo reverte pra ordem cronológica antes
  // de devolver — a query crua fica em ordem decrescente por causa do LIMIT.
  listByJid: db.prepare(`SELECT * FROM wa_messages WHERE jid = ? ORDER BY created_at DESC LIMIT ?`),
  markSeen: db.prepare(`UPDATE wa_messages SET seen = 1 WHERE id = ?`),
  markAllSeen: db.prepare(`UPDATE wa_messages SET seen = 1 WHERE seen = 0`),
  markSeenByJid: db.prepare(`UPDATE wa_messages SET seen = 1 WHERE jid = ? AND seen = 0`),
  getById: db.prepare(`SELECT * FROM wa_messages WHERE id = ?`),
  listContacts: db.prepare(`SELECT * FROM wa_contacts ORDER BY updated_at DESC`),
  getContactByJid: db.prepare(`SELECT * FROM wa_contacts WHERE jid = ?`),
  getSetting: db.prepare(`SELECT value FROM wa_settings WHERE key = ?`),
  upsertSetting: db.prepare(`
    INSERT INTO wa_settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  getContactAutopilot: db.prepare(`SELECT autopilot FROM wa_contacts WHERE jid = ?`),
  setContactAutopilot: db.prepare(`UPDATE wa_contacts SET autopilot = @autopilot WHERE jid = @jid`),
  getAudioOptOut: db.prepare(`SELECT audio_opt_out FROM wa_contacts WHERE jid = ?`),
  setAudioOptOut: db.prepare(`UPDATE wa_contacts SET audio_opt_out = @audio_opt_out WHERE jid = @jid`),
  insertBareContact: db.prepare(`
    INSERT INTO wa_contacts (jid, name, updated_at, is_group) VALUES (@jid, NULL, @updated_at, @is_group)
  `),
};

// só atualiza o nome quando vier um pushName de verdade — evita sobrescrever
// um contato já nomeado com null nas mensagens enviadas por nós mesmos
export function upsertContact(jid: string, name: string | null): void {
  if (!name) return;
  stmts.upsertContact.run({ jid, name, updated_at: Date.now() });
}

// grava/atualiza o nome de um GRUPO — chamado tanto na sincronização de
// grupos ao conectar quanto toda vez que chega mensagem de um grupo ainda
// não conhecido. Nunca sobrescreve com null: se o subject vier vazio (grupo
// sem nome, raro) mantém o que já tinha.
export function upsertGroupContact(jid: string, name: string | null): void {
  if (!name) return;
  stmts.upsertGroupContact.run({ jid, name, updated_at: Date.now() });
}

// memoriza um contato explicitamente (nome dado pelo usuário + número),
// diferente do upsertContact que só roda automaticamente quando chega
// mensagem de alguém — aqui a Ley grava mesmo sem nunca ter recebido nada
// dessa pessoa.
//
// BUG corrigido aqui: a função só disparava o INSERT/UPSERT e retornava
// void, sem checar se a escrita de fato "pegou". O better-sqlite3 é
// síncrono e lança em erro real de SQL, mas não existia nenhuma
// confirmação de que a linha ficou gravada com os valores certos — então
// um erro silencioso (ex.: exceção engolida em algum try/catch mais acima,
// ou a call nem sendo aguardada por quem chama) fazia o fluxo achar que
// salvou quando não salvou. Agora a função sempre relê a linha pelo jid
// logo depois de gravar e só retorna normalmente se o que está no banco
// bate com o que foi pedido — senão lança um erro explícito.
export function saveContact(name: string, jid: string): WaContactRow {
  const now = Date.now();
  const info = stmts.saveContact.run({ jid, name, updated_at: now });

  if (info.changes !== 1) {
    throw new Error(
      `saveContact: INSERT/UPDATE não afetou nenhuma linha (jid=${jid}, name=${name}, changes=${info.changes})`
    );
  }

  const persisted = stmts.getContactByJid.get(jid) as WaContactRow | undefined;

  if (!persisted || persisted.name !== name || persisted.source !== "saved") {
    throw new Error(
      `saveContact: verificação pós-escrita falhou — o que está no banco (${JSON.stringify(
        persisted
      )}) não bate com o que foi pedido (jid=${jid}, name=${name})`
    );
  }

  return persisted;
}

export function saveMessage(row: Omit<WaMessageRow, "seen"> & { seen?: number }): void {
  stmts.insertMessage.run({ ...row, seen: row.seen ?? (row.from_me ? 1 : 0) });
}

export function listRecentMessages(limit = 100): WaMessageRow[] {
  return stmts.listRecent.all(limit) as WaMessageRow[];
}

export function listUnreadMessages(): WaMessageRow[] {
  return stmts.listUnread.all() as WaMessageRow[];
}

export function listMessagesByJid(jid: string, limit = 100): WaMessageRow[] {
  // a query já vem em DESC (mais recentes primeiro) por causa do LIMIT — aqui
  // devolvemos em ordem cronológica normal (mais antiga -> mais recente), que
  // é o que quem consome isso (autopilot, histórico) espera.
  return (stmts.listByJid.all(jid, limit) as WaMessageRow[]).reverse();
}

export function markMessageSeen(id: string): boolean {
  const info = stmts.markSeen.run(id);
  return info.changes > 0;
}

export function markAllSeen(): number {
  const info = stmts.markAllSeen.run();
  return info.changes;
}

// marca como visto tudo que veio de um jid específico — usado pela aba de
// Notificações quando o dono abre/clica num aviso, pra sumir só aquele
// contato/grupo da lista (sem marcar as outras conversas como lidas também).
export function markSeenByJid(jid: string): number {
  const info = stmts.markSeenByJid.run(jid);
  return info.changes;
}

export function getMessageById(id: string): WaMessageRow | undefined {
  return stmts.getById.get(id) as WaMessageRow | undefined;
}

export function listContacts(): WaContactRow[] {
  return stmts.listContacts.all() as WaContactRow[];
}

// busca reversa: dado o jid (quem mandou), acha o contato memorizado/visto —
// usado pelo fluxo de "tem mensagem não lida"/"toca o áudio de fulano" pra
// mostrar o nome da pessoa em vez do jid cru.
export function getContactByJid(jid: string): WaContactRow | undefined {
  return stmts.getContactByJid.get(jid) as WaContactRow | undefined;
}

// busca tolerante por nome: ignora acentuação/caixa, palavras de conexão
// soltas ("o", "a", "grupo", "da", "do") e ordem das palavras. O volume de
// contatos de um número pessoal é pequeno, então filtrar em JS é mais simples
// e mais correto que tentar replicar tudo isso dentro do LIKE do SQLite.
//
// BUG corrigido aqui: a versão antiga só fazia
// `normalize(nomeDoContato).includes(normalizedQuery)` — ou seja, exigia que
// o NOME gravado contivesse a busca inteira. Isso quebrava sempre que a
// query vinha com palavras extras que os fluxos de chat (send-text-flow,
// open-conversation-flow) não removem, ex: usuário fala "manda uma mensagem
// pro grupo Familia Buscape" e o texto que sobra pra buscar é literalmente
// "o grupo Familia Buscape" — como o nome real do grupo é só "Família
// Buscapé", "familia buscape" NUNCA contém "o grupo familia buscape", e a
// busca falhava mesmo com o nome certo digitado (o usuário podia até achar
// que era coisa de acento, mas o normalize() já tratava acento — o problema
// era a direção da comparação + as palavras extras).
export function findContactByName(query: string): WaContactRow | null {
  const normalizedQuery = stripFillerWords(normalize(query));
  if (!normalizedQuery) return null;

  const rows = listContacts();

  // 1) match exato (já sem acento/caixa/palavras de conexão)
  const exact = rows.find((r) => stripFillerWords(normalize(r.name ?? "")) === normalizedQuery);
  if (exact) return exact;

  // 2) um contém o outro por completo (cobre tanto busca curta -> nome
  //    completo quanto o inverso, quando ainda sobrou alguma palavra extra
  //    de um dos lados)
  const partial = rows.find((r) => {
    const name = stripFillerWords(normalize(r.name ?? ""));
    if (!name) return false;
    return name.includes(normalizedQuery) || normalizedQuery.includes(name);
  });
  if (partial) return partial;

  // 3) todas as palavras "significativas" da busca aparecem no nome, em
  //    qualquer ordem — cobre erro de digitação na ordem das palavras ou
  //    alguma palavra de conexão que o passo 1/2 não previu. Entre vários
  //    candidatos, fica com o nome mais curto (mais específico) pra evitar
  //    pegar um contato que só coincidentemente contém uma das palavras.
  const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 1);
  if (queryWords.length === 0) return null;

  const candidates = rows.filter((r) => {
    const name = stripFillerWords(normalize(r.name ?? ""));
    if (!name) return false;
    return queryWords.every((w) => name.includes(w));
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.name ?? "").length - (b.name ?? "").length);
  return candidates[0];
}

// remove palavras de conexão comuns em pedidos falados/digitados ("o grupo",
// "a", "do", "da", "de") que não fazem parte do nome de verdade do contato/
// grupo no WhatsApp — sem isso elas atrapalham tanto o match exato quanto o
// includes() nos dois sentidos.
const FILLER_WORDS = new Set(["o", "a", "os", "as", "grupo", "grupinho", "do", "da", "de", "dos", "das"]);

function stripFillerWords(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .join(" ")
    .trim();
}

// config genérica do módulo WhatsApp (hoje só o toggle global do autopilot)
export function getWaSetting(key: string): string | null {
  const row = stmts.getSetting.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setWaSetting(key: string, value: string): void {
  stmts.upsertSetting.run({ key, value });
}

// override de autopilot de um contato/grupo específico: null = segue o
// padrão global, 1 = força ligado, 0 = força desligado (mute)
export function getContactAutopilot(jid: string): 0 | 1 | null {
  const row = stmts.getContactAutopilot.get(jid) as { autopilot: number | null } | undefined;
  return (row?.autopilot ?? null) as 0 | 1 | null;
}

export function setContactAutopilot(jid: string, value: 0 | 1 | null): void {
  const exists = stmts.getContactByJid.get(jid);
  if (!exists) {
    // permite mutar/ligar autopilot pra alguém que a Ley ainda não viu/salvou
    // — cria um registro mínimo antes de aplicar a config
    stmts.insertBareContact.run({ jid, updated_at: Date.now(), is_group: jid.endsWith("@g.us") ? 1 : 0 });
  }
  stmts.setContactAutopilot.run({ jid, autopilot: value });
}

// lembra se esse contato/grupo já pediu explicitamente pra não receber áudio
// ("não consigo ouvir áudio", "manda por texto") — usado pelo autopilot pra
// nunca mais mandar áudio automático pra esse jid depois disso.
export function getAudioOptOut(jid: string): boolean {
  const row = stmts.getAudioOptOut.get(jid) as { audio_opt_out: number } | undefined;
  return (row?.audio_opt_out ?? 0) === 1;
}

export function setAudioOptOut(jid: string, value: boolean): void {
  const exists = stmts.getContactByJid.get(jid);
  if (!exists) {
    stmts.insertBareContact.run({ jid, updated_at: Date.now(), is_group: jid.endsWith("@g.us") ? 1 : 0 });
  }
  stmts.setAudioOptOut.run({ jid, audio_opt_out: value ? 1 : 0 });
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
