# myjira

Cliente mínimo de Jira (estilo Linear): sprint actual, backlog y detalle de issues.

```bash
cp .env.example .env   # opcional: fija JIRA_BASE_URL
npm install
npm run dev            # web en http://localhost:5173, API en :3101
```

- `server/index.js`: proxy Express hacia Jira Cloud. Los tokens se quedan en el servidor.
- `web/`: React + React Query (Vite).

Producción local: `npm run build && npm start`, que sirve todo desde :3101.

## Login

Al entrar, la app pide email y [API token](https://id.atlassian.com/manage-profile/security/api-tokens) (y el sitio, si no está fijado con `JIRA_BASE_URL`). El servidor los valida contra Jira y guarda la sesión en `.sessions.json` (ignorado por git); el navegador solo tiene una cookie `httpOnly` con un id aleatorio.

Si `.env` tiene `JIRA_EMAIL` y `JIRA_API_TOKEN`, se usan cuando no hay sesión, sin formulario.
