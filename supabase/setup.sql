-- À exécuter une fois dans Supabase > SQL Editor
-- Recherche plein texte PostgreSQL : aucun service d'IA externe n'est nécessaire pour l'indexation.
-- Attention : supprime l'ancienne table vectorielle (les documents devront être réindexés).
drop function if exists match_rag_documents(vector, int);
drop function if exists insert_document(text, vector, jsonb);
drop table if exists rag_documents;

create table rag_documents (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table rag_documents enable row level security;
create index rag_documents_fts_idx on rag_documents using gin (fts);

-- Accès via fonctions contrôlées (la clé publishable n'a pas d'accès direct à la table)
create or replace function insert_document(p_content text, p_metadata jsonb default '{}'::jsonb)
returns uuid language sql security definer set search_path = public as $$
  insert into rag_documents(content, metadata) values (p_content, p_metadata) returning id;
$$;

-- Recherche : tous les mots d'abord, sinon n'importe lequel (OR), classés par pertinence.
create or replace function match_rag_documents(query_text text, match_count int default 5)
returns table (id uuid, content text, metadata jsonb, similarity float)
language sql stable security definer set search_path = public as $$
  with q as (
    select websearch_to_tsquery('simple', query_text) as qa,
           nullif(array_to_string(tsvector_to_array(to_tsvector('simple', query_text)), ' | '), '')::tsquery as qo
  )
  select d.id, d.content, d.metadata,
         ts_rank_cd(d.fts, coalesce(q.qo, q.qa))::float as similarity
  from rag_documents d, q
  where d.fts @@ coalesce(q.qo, q.qa)
  order by (d.fts @@ q.qa) desc, ts_rank_cd(d.fts, coalesce(q.qo, q.qa)) desc
  limit least(match_count, 20);
$$;

create or replace function list_sources()
returns table (source text, chunks bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(metadata->>'source','(sans nom)'), count(*) from rag_documents group by 1 order by 1;
$$;

revoke all on function insert_document(text, jsonb), match_rag_documents(text, int), list_sources() from public;
grant execute on function insert_document(text, jsonb), match_rag_documents(text, int), list_sources() to anon, authenticated;
