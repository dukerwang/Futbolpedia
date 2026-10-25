-- Server-side guard for shared dossier cards. Mirrors the client rules in services/dossierCards.ts
-- (CARD_REFRESH_DAYS, isCardInRefreshWindow), services/dossierCache.ts (CALIBRATION_EPOCH_MS) and
-- services/dossierRevisions.ts (REVISION_CONSENSUS_USERS); change them together.
--
-- A blocked write is skipped silently (the BEFORE trigger returns NULL) rather than raising, so a
-- client that loses the race, or an older client, keeps working and the shared card stays put.
--
-- Rules for UPDATEs of player_profiles:
--   * Archive rows (slug "<player>--<edition>--<date>") are immutable. Shared revision copies
--     ("...--rev-<id>") are not archive rows and may change.
--   * Cards last written before the calibration epoch, or undated, may be replaced.
--   * A current card is the shared card for 7 days from its evaluation date; within that window
--     only a write of the same dated card (same evaluation date) goes through.
--   * A post-epoch dated prime card is frozen.
--   * Either lock lifts when 3 distinct people logged accepted challenges pushing the same rating
--     or attribute the same way against that card (dossier_revisions).

-- Valid, non-future YYYY-MM-DD from text, else NULL (never raises on bad input).
create or replace function public.dossier_parse_date(s text)
returns date
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  d date;
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  d := s::date;
  return case when d <= (now() at time zone 'utc')::date then d end;
exception when others then
  return null;
end;
$$;

-- Same rule as isPrimeCard: version type wins, else an edition marker in a legacy card's name.
create or replace function public.dossier_is_prime(card jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when card->'version'->>'type' is not null then card->'version'->>'type' <> 'current'
    else coalesce(card->'basicInfo'->>'name', '') ~* '\m(prime|peak)\M'
  end;
$$;

-- Same rule as getDossierEvaluationDate: a current card may fall back to when it was written;
-- a prime card never does.
create or replace function public.dossier_eval_date(card jsonb, written_at timestamptz)
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    public.dossier_parse_date(card->'version'->>'evaluationDate'),
    public.dossier_parse_date(card->>'evaluationDate'),
    case when not public.dossier_is_prime(card) then (written_at at time zone 'utc')::date end
  );
$$;

create or replace function public.enforce_dossier_refresh_window()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  calibration_epoch constant timestamptz := '2026-10-20 21:15:00+00';
  refresh_days constant integer := 7;
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

drop trigger if exists enforce_dossier_refresh_window on public.player_profiles;
create trigger enforce_dossier_refresh_window
  before update on public.player_profiles
  for each row execute function public.enforce_dossier_refresh_window();
