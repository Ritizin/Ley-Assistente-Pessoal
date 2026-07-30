# Ley — Frontend

Interface React (Vite + TypeScript + Tailwind CSS) para a Ley API, no tema **Dark Navy / Azul Elétrico**.

## Como rodar

```bash
npm install
npm run dev
```

O app sobe em `http://localhost:5173`. O backend precisa estar rodando em `http://localhost:3000`
(rotas REST) e `ws://localhost:3000/ws` (WebSocket).

## Estrutura

```
src/
  components/
    Sidebar.tsx     -> navegação lateral (Chat / Tarefas / Logs)
    ChatTab.tsx      -> chat com POST /api/chat, histórico e conversationId no localStorage
    TasksTab.tsx     -> to-do list com GET/POST/PATCH /api/tasks
    LogsTab.tsx      -> terminal visual alimentado pelo WebSocket
  hooks/
    useLeyWebSocket.ts -> conexão única ao ws://localhost:3000/ws, com reconexão automática
  App.tsx
  main.tsx
  index.css
```

## Notas

- O `conversationId` da conversa é salvo em `localStorage` (`ley:conversationId`), então o chat
  continua de onde parou mesmo depois de recarregar a página.
- O histórico visual das mensagens também fica salvo (`ley:chatHistory`) para não perder o contexto
  visual ao dar refresh.
- O WebSocket tenta reconectar automaticamente a cada 3s se a conexão cair, e isso aparece
  logado na aba "Logs do Servidor".
- Ajuste o parsing de eventos em `useLeyWebSocket.ts` (`onmessage`) caso o formato exato dos
  eventos emitidos pelo backend (`channel`, `type`, `log`, `level`) seja diferente do esperado.
