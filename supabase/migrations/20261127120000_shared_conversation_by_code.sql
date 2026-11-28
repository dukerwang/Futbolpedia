-- A shared conversation is read by its share code and no other way. This adds the read function the
-- app calls (services/dossierCache.ts, getSharedConversation); the next migration drops the policy
-- that let anyone list the table.
--
-- Order: apply this one BEFORE publishing the app that calls the function. It only adds, so the
-- published app keeps working. Apply 20261127120100 AFTER publishing, never with this one.
create or replace function public.get_shared_conversation(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select conversation_data
  from public.shared_conversations
  where share_code = upper(p_code)
$$;

revoke all on function public.get_shared_conversation(text) from public;
grant execute on function public.get_shared_conversation(text) to anon, authenticated, service_role;

-- PostgREST learns about the function at once.
notify pgrst, 'reload schema';
