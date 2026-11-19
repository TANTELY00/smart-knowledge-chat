import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { MarkdownResponse } from "@/components/markdown-response";
import { askAgent, ingestDocument, listSources, saveCorrection } from "@/lib/rag.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Test RAG CashOffice" },
      { name: "description", content: "Agent RAG : indexez vos documents dans Supabase avec Gemma et posez des questions sourcées." },
      { property: "og:title", content: "Test RAG CashOffice" },
      { property: "og:description", content: "Agent RAG : indexez vos documents dans Supabase avec Gemma et posez des questions sourcées." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Msg = { role: "user" | "assistant"; content: string; steps?: string[]; sources?: { source: string; similarity: number }[]; question?: string; corrected?: boolean };

function Index() {
  const [sources, setSources] = useState<{ source: string; chunks: number }[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busyIngest, setBusyIngest] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [thinking, setThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = () => listSources().then(setSources).catch((e) => setStatus(String(e.message ?? e)));
  useEffect(() => { refresh(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, thinking]);

  const onFile = async (f: File) => {
    setName(f.name);
    setText("");
    setOcrNote("");
    setReadingFile(true);
    try {
      if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
        setStatus("Lecture du PDF et recherche des images…");
        const { extractPdfContent } = await import("@/lib/pdf-ocr");
        const result = await extractPdfContent(f, (progress) => {
          if (progress.phase === "ocr-init") {
            setStatus("Initialisation de l’OCR français + anglais…");
          } else if (progress.phase === "ocr") {
            const percent = typeof progress.progress === "number" && progress.progress > 0
              ? ` · ${Math.round(progress.progress * 100)} %`
              : "";
            setStatus(`OCR · page ${progress.page}/${progress.pageCount}${progress.image ? ` · image ${progress.image}/${progress.imagesOnPage}` : ""}${percent}`);
          } else {
            setStatus(`Lecture du PDF · page ${progress.page}/${progress.pageCount}`);
          }
        });
        setText(result.text);
        if (!result.text.trim()) {
          setStatus(`Aucun texte lisible trouvé dans ce PDF, y compris dans ses ${result.imageCount} image(s).`);
          return;
        }
        const note = result.imageCount
          ? `${result.ocrCharacterCount} caractères OCR reconnus dans ${result.imagesWithText}/${result.imageCount} image(s)`
          : "aucune image détectée";
        setOcrNote(result.imageCount ? note : "");
        setStatus(`PDF prêt · ${result.pageCount} page(s) · ${note}. Cliquez sur Indexer.`);
      } else {
        const content = await f.text();
        setText(content);
        setStatus(content.trim() ? "Document prêt. Cliquez sur Indexer." : "Ce document est vide.");
      }
    } catch (e: any) {
      setText("");
      setStatus("Erreur de lecture/OCR : " + (e.message ?? String(e)));
    } finally {
      setReadingFile(false);
    }
  };

  const ingest = async () => {
    setBusyIngest(true); setStatus("Découpage et vectorisation du texte et de l’OCR…");
    try {
      const r = await ingestDocument({ data: { source: name || "document", text } });
      setStatus(`✓ ${r.chunks} fragments indexés${ocrNote ? ` · ${ocrNote}` : ""}`);
      setText(""); setName(""); setOcrNote(""); refresh();
    } catch (e: any) { setStatus(e.message ?? String(e)); }
    setBusyIngest(false);
  };

  const ask = async () => {
    if (!q.trim()) return;
    const next = [...msgs, { role: "user" as const, content: q }];
    setMsgs(next); setQ(""); setThinking(true);
    try {
      const r = await askAgent({ data: { messages: next.map(({ role, content }) => ({ role, content })) } });
      setMsgs([...next, { role: "assistant", content: r.answer, steps: r.steps, sources: r.sources, question: q }]);
    } catch (e: any) {
      setMsgs([...next, { role: "assistant", content: "⚠ " + (e.message ?? String(e)) }]);
    }
    setThinking(false);
  };

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveEdit = async (i: number) => {
    const m = msgs[i];
    if (!m?.question || !draft.trim()) return;
    setSaving(true); setSaveError(null);
    try {
      await saveCorrection({ data: { question: m.question!, bonne_reponse: draft } });
      setMsgs(msgs.map((x, j) => (j === i ? { ...x, content: draft, corrected: true } : x)));
      setEditing(null);
    } catch (e: any) { setSaveError(e.message ?? String(e)); }
    setSaving(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="px-4 pt-5 sm:px-8">
        <div className="mx-auto max-w-6xl px-5 py-5 sm:px-8 sm:py-6">
          <h1 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            Test RAG <span className="text-primary">CashOffice</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Agent de recherche · Gemma · réponses sourcées
          </p>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-8 p-4 sm:p-8 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="font-display text-xl font-semibold">Ajouter un document</h2>
            <input type="file" accept=".pdf,.txt,.md,.csv,.json,.html" className="mt-4 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la source"
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder="…ou collez du texte ici"
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
            <button onClick={ingest} disabled={busyIngest || readingFile || !text.trim()}
              className="mt-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
              {readingFile ? "Lecture et OCR…" : busyIngest ? "Indexation…" : "Indexer"}
            </button>
            {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
          </section>
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="font-display text-xl font-semibold">Sources</h2>
            {sources.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Aucun document indexé.</p> : (
              <ul className="mt-3 space-y-1 text-sm">
                {sources.map((s) => (
                  <li key={s.source} className="flex justify-between border-b border-border py-1 last:border-0">
                    <span className="truncate">{s.source}</span><span className="font-mono text-xs text-muted-foreground">{s.chunks}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
        <section className="flex min-h-[70vh] flex-col rounded-lg border border-border bg-card">
          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            {msgs.length === 0 && <p className="mt-20 text-center font-display text-2xl text-muted-foreground">Posez une question sur vos documents.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "ml-auto max-w-[80%] rounded-lg bg-primary px-4 py-3 text-primary-foreground" : "max-w-[90%]"}>
                {m.role === "assistant" && editing === i ? (
                  <div className="space-y-2">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} aria-label="Bonne réponse"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit(i)} disabled={saving || !draft.trim()}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
                        {saving ? "Enregistrement…" : "Enregistrer"}
                      </button>
                      <button onClick={() => { setEditing(null); setSaveError(null); }}
                        className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent">Annuler</button>
                    </div>
                    {saveError && <p className="text-xs text-destructive">{saveError}</p>}
                  </div>
                ) : m.role === "assistant" ? (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1"><MarkdownResponse content={m.content} /></div>
                    {m.question && (
                      <button onClick={() => { setEditing(i); setDraft(m.content); setSaveError(null); }}
                        title="Corriger cette réponse" aria-label="Modifier la réponse"
                        className="shrink-0 rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                        ✎ Modifier
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                )}
                {m.corrected && <p className="mt-2 text-xs text-primary">✓ Réponse corrigée enregistrée dans la base de connaissance</p>}
                {m.steps && m.steps.length > 0 && (
                  <p className="mt-2 font-mono text-xs text-muted-foreground">🔎 {m.steps.map((s) => `« ${s} »`).join(" · ")}</p>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.sources.map((s) => (
                      <span key={s.source} className="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">{s.source} · {s.similarity.toFixed(2)}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {thinking && <p className="animate-pulse text-sm text-muted-foreground">L'agent cherche dans les documents…</p>}
            <div ref={endRef} />
          </div>
          <div className="flex items-center gap-2 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
            <span>Modèle IA :</span>
            <span className="rounded-md border border-input bg-background px-2 py-1 text-foreground">Ollama · gemma4:e4b (159.195.68.117)</span>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2 p-4">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Votre question…"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <button disabled={thinking} className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">Envoyer</button>
          </form>
        </section>
      </main>
    </div>
  );
}
