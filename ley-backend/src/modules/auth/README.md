# Auth module

Este módulo fornece a base para login com Google no Ley usando um banco local SQLite como fallback, com caminho de evolução para PostgreSQL.

## Ambiente

Defina no .env:

- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/auth/google/callback
- JWT_SECRET=algum-segredo-forte

## Fluxo

1. Acesse /auth/google para iniciar o OAuth.
2. O callback salva o usuário no banco e devolve um JWT simples.
3. Use /auth/me com o header Authorization: Bearer <token> para validar.
