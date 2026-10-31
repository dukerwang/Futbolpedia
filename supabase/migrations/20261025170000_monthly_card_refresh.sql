-- Shared current cards now hold their rating for 30 days (CARD_REFRESH_DAYS in
-- services/dossierCards.ts) instead of 7. Same function as 20261025130000_dossier_refresh_window
-- with refresh_days raised; change both together.
--
-- The weekly Latest Update refresh (services/latestUpdateRefresh.ts) rewrites the shared card
-- with the same evaluation date, which the "same dated card" rule already lets through, so it
-- needs no exception here.

create or replace function public.enforce_dossier_refresh_window()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  calibration_epoch constant timestamptz := '2026-10-20 21:15:00+00';
  refresh_days constant integer := 30;
  consensus_people constant integer := 3;
  old_prime boolean;
  old_date date;
  target_slug text;
begin
  if new.player_slug like '%--rev-%' then
    return new;
  end if;

  -- Archive rows never change.
  if old.player_slug like '%--%' then
    return null;
  end if;

  if old.updated_at < calibration_epoch then
    return new;
  end if;

  old_prime := public.dossier_is_prime(old.player_data);
  old_date := public.dossier_eval_date(old.player_data, old.updated_at);
  if old_date is null then
    return new;
  end if;

  if not old_prime then
    if now() >= (old_date + refresh_days)::timestamp at time zone 'utc' then
      return new; -- refresh window is over
    end if;
    if public.dossier_eval_date(new.player_data, coalesce(new.updated_at, now())) = old_date then
      return new; -- the same dated card
    end if;
  end if;

  -- Locked: allow only on challenge consensus against this card.
  target_slug := regexp_replace(old.player_slug, '^prime-', '') || '--' ||
    case when old_prime then coalesce(old.player_data->'version'->>'type', 'prime') else 'current' end ||
    '--' || old_date::text;

  if exists (
    select 1
    from (
      select d.key, r.client_id,
        sign(case when jsonb_typeof(d.value) = 'number' then (d.value::text)::numeric end) as direction
      from public.dossier_revisions r
      cross join lateral jsonb_each(
        case when jsonb_typeof(r.deltas) = 'object' then r.deltas else '{}'::jsonb end
      ) d
      where r.card_slug = target_slug
    ) votes
    where votes.direction <> 0
    group by votes.key, votes.direction
    having count(distinct votes.client_id) >= consensus_people
  ) then
    return new;
  end if;

  return null;
end;
$$;
