import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import { logger } from "../../core/logger.js";
import { wsHub } from "../../ws/hub.js";
import { getAccount, saveAccount, deleteAccount } from "./gmail.repository.js";

export type GmailStatus = "disconnected" | "connecting" | "connected" | "error";

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;

class GmailService {
  private client: ImapFlow | null = null;
  private transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
  private status: GmailStatus = "disconnected";
  private email: string | null = null;
  private stopping = false;

  getSnapshot(): { status: GmailStatus; email: string | null } {
    return { status: this.status, email: this.email };
  }

  // conecta com e-mail + senha de app (Gmail exige "senha de app" com verificação em 2 etapas ativa,
  // já que autenticação básica de IMAP/SMTP foi desativada pelo Google)
  async connect(email: string, appPassword: string): Promise<void> {
    await this.teardown();

    this.stopping = false;
    this.email = email;
    this.setStatus("connecting");

    try {
      this.client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: { user: email, pass: appPassword },
        logger: false,
      });

      this.client.on("error", (err) => {
        logger.error({ err }, "erro na conexão IMAP do Gmail");
      });

      await this.client.connect();

      this.transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user: email, pass: appPassword },
      });

      // salva criptografado pra reconectar sozinho no próximo boot do servidor
      saveAccount(email, appPassword);

      this.setStatus("connected");
      wsHub.broadcast("gmail", "connected", { email });
      logger.info({ email }, "Gmail conectado com sucesso");

      void this.watchInbox();
    } catch (err) {
      logger.error({ err }, "falha ao conectar ao Gmail");
      this.client = null;
      this.transporter = null;
      this.setStatus("error");
      wsHub.broadcast("gmail", "error", {
        message: "Falha ao conectar. Confira o e-mail e a senha de app do Gmail.",
      });
      throw err;
    }
  }

  // fica escutando novas mensagens via IMAP IDLE e avisa o painel em tempo real
  private async watchInbox(): Promise<void> {
    if (!this.client) return;

    try {
      const lock = await this.client.getMailboxLock("INBOX");
      lock.release();
    } catch (err) {
      logger.error({ err }, "falha ao abrir caixa de entrada do Gmail");
      return;
    }

    this.client.on("exists", () => {
      void this.notifyLatestEmail();
    });

    while (!this.stopping && this.client && this.status === "connected") {
      try {
        await this.client.idle();
      } catch (err) {
        if (this.stopping) break;
        logger.warn({ err }, "IDLE do Gmail caiu");
        this.setStatus("error");
        wsHub.broadcast("gmail", "error", { message: "Conexão com o Gmail caiu." });
        break;
      }
    }
  }

  private async notifyLatestEmail(): Promise<void> {
    if (!this.client) return;
    try {
      const lock = await this.client.getMailboxLock("INBOX");
      try {
        const message = await this.client.fetchOne("*", { envelope: true });
        if (message && message.envelope) {
          wsHub.broadcast("gmail", "new_email", {
            from: message.envelope.from?.[0]?.address ?? "desconhecido",
            subject: message.envelope.subject ?? "(sem assunto)",
            date: message.envelope.date ?? new Date().toISOString(),
          });
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.error({ err }, "falha ao buscar novo e-mail do Gmail");
    }
  }

  async sendEmail(to: string, subject: string, text: string): Promise<void> {
    if (!this.transporter || this.status !== "connected" || !this.email) {
      throw new Error("Gmail não está conectado");
    }
    await this.transporter.sendMail({ from: this.email, to, subject, text });
  }

  // encerra a sessão atual sem apagar a conta salva (usado antes de reconectar)
  private async teardown(): Promise<void> {
    this.stopping = true;
    try {
      await this.client?.logout();
    } catch {
      // ignora erro ao encerrar sessão já caída
    }
    this.client = null;
    this.transporter = null;
  }

  async disconnect(forget: boolean): Promise<void> {
    await this.teardown();
    this.email = null;
    this.setStatus("disconnected");

    if (forget) {
      deleteAccount();
      wsHub.broadcast("gmail", "disconnected", null);
    }
  }

  // chamado no boot do servidor: tenta reconectar com a conta salva, se houver
  async restoreFromStorage(): Promise<void> {
    const account = getAccount();
    if (!account) return;

    try {
      await this.connect(account.email, account.appPassword);
    } catch (err) {
      logger.error({ err }, "falha ao restaurar sessão salva do Gmail");
    }
  }

  private setStatus(status: GmailStatus): void {
    this.status = status;
    wsHub.broadcast("gmail", "status", { status, email: this.email });
  }
}

export const gmailService = new GmailService();
