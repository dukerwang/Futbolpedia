-- "Public read" let anyone with the publishable key list every shared conversation, Gaffa club
-- context included. Without it the table can't be selected from a browser; one conversation is read
-- by its code through get_shared_conversation (20261127120000). Sharing still inserts directly.
--
-- Order: apply AFTER the app that calls the function is published. The app before it selects from
-- the table, so applying this first stops every shared link from opening.
drop policy if exists "Public read" on public.shared_conversations;
