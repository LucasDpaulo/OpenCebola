-- Sessões próprias do Cebola. Tokens Supabase nunca são persistidos aqui e o
-- token opaco Cebola é armazenado somente como SHA-256 hexadecimal.

create table public.cebola_auth_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  active_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index cebola_auth_sessions_user_id_idx
  on public.cebola_auth_sessions (user_id);
create index cebola_auth_sessions_expiry_idx
  on public.cebola_auth_sessions (expires_at)
  where revoked_at is null;

alter table public.cebola_auth_sessions enable row level security;

-- Browser, inclusive autenticado, não acessa sessões. Somente a API com a
-- service role atravessa RLS.
revoke all on table public.cebola_auth_sessions from anon, authenticated;
grant select, insert, update, delete on table public.cebola_auth_sessions to service_role;

comment on table public.cebola_auth_sessions is
  'Sessões opacas da API: somente hash SHA-256, user, expiração e perfil ativo; nunca tokens Supabase.';
