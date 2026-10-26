-- A prime card is frozen once published, but an explicit re-rating ("rerate prime <player>")
-- regenerates it from scratch and stamps the new card with rerateAt (ms). Such a card replaces
-- the frozen prime pointer and its archive row when its rerateAt is newer than the stored one's.
-- Same function as 20261025170000_monthly_card_refresh otherwise; change them together.

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

  -- A prime card re-rated from scratch replaces the frozen one, archive row included, so the
  -- old numbers can't come back under the same card key. Only a newer re-rating goes through.
  if public.dossier_is_prime(old.player_data)
    and coalesce(old.player_data->'version'->>'type', 'prime') = 'prime'
    and new.player_data->'version'->>'type' = 'prime'
    and jsonb_typeof(new.player_data->'rerateAt') = 'number'
    and (new.player_data->>'rerateAt')::numeric > (
      case
        when jsonb_typeof(old.player_data->'rerateAt') = 'number'
          then (old.player_data->>'rerateAt')::numeric
        else 0
      end
    )
  then
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
