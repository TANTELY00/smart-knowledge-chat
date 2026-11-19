-- À exécuter une fois dans Supabase > SQL Editor (après setup.sql).
-- Table "chat" : réponses corrigées/validées par un humain, prioritaires pour l'IA.
create table if not exists public.chat (
  id uuid primary key default gen_random_uuid(),
  questions text not null,
  bonne_reponse text not null,
  fts tsvector generated always as (to_tsvector('simple', questions || ' ' || bonne_reponse)) stored,
  created_at timestamptz not null default now()
);
alter table public.chat enable row level security;
create index if not exists chat_fts_idx on public.chat using gin (fts);

create or replace function insert_chat(p_question text, p_reponse text)
returns uuid language sql security definer set search_path = public as $$
  insert into chat(questions, bonne_reponse) values (p_question, p_reponse) returning id;
$$;

create or replace function match_chat(query_text text, match_count int default 3)
returns table (id uuid, questions text, bonne_reponse text, similarity float)
language sql stable security definer set search_path = public as $$
  with q as (
    select websearch_to_tsquery('simple', query_text) as qa,
           nullif(array_to_string(tsvector_to_array(to_tsvector('simple', query_text)), ' | '), '')::tsquery as qo
  )
  select c.id, c.questions, c.bonne_reponse,
         ts_rank_cd(c.fts, coalesce(q.qo, q.qa))::float as similarity
  from chat c, q
  where c.fts @@ coalesce(q.qo, q.qa)
  order by (c.fts @@ q.qa) desc, ts_rank_cd(c.fts, coalesce(q.qo, q.qa)) desc, c.created_at desc
  limit least(match_count, 10);
$$;

revoke all on function insert_chat(text, text), match_chat(text, int) from public;
grant execute on function insert_chat(text, text), match_chat(text, int) to anon, authenticated;
