<!-- cash:BEGIN -->
> [!IMPORTANT]
> This project is connected to [cash](https://cash.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on cash's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to . and show up in
> the editor, so keep the branch in a working state.

## What . manages

Rules outside this block are the project's own. Change the pieces below in
cash, not by hand. With the [cash MCP](https://mcp.cash.dev)
connected, `send_message` asks cash to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask cash to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI.** All model calls go to the user's own Ollama server (Gemma), never cash's AI gateway — the user requires independence from cash AI.
- **Connectors.** cash provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `cash_API_KEY`. When cash does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** cash manages them. Do not put secret values in the repo.
<!-- cash:END -->

- PDF extraction and OCR run in the browser through dynamically imported libraries; keep ingestion server functions independent of canvas and browser workers because the server runtime cannot execute them.

- Document retrieval uses Supabase PostgreSQL full-text search, because the user's Ollama server does not serve embeddings.
