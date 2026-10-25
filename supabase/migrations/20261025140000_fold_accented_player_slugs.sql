-- Player slugs used to delete accented letters ("João Pedro" -> joo-pedro), so typing the name
-- without accents ("joao pedro") never found the shared card. Slugs now fold accents
-- (joao-pedro). This copies every existing accented row to its folded slug. It only adds rows;
-- the legacy rows stay so old share links keep resolving.
--
-- Applied to the Futbolpedia project on 2026-10-25. Undo: delete the new_slug rows below.
with m(old_slug, new_slug) as (values
  ('aitana-bonmat','aitana-bonmati'),
  ('antnio-silva','antonio-silva'),
  ('chema-andrs','chema-andres'),
  ('eric-garca','eric-garcia'),
  ('estvo-willian','estevao-willian'),
  ('eusbio--prime--1966-07-28','eusebio--prime--1966-07-28'),
  ('gerard-piqu--prime--2015-06-06','gerard-pique--prime--2015-06-06'),
  ('joo-pedro','joao-pedro'),
  ('kylian-mbapp','kylian-mbappe'),
  ('marc-guhi','marc-guehi'),
  ('ousmane-dembl','ousmane-dembele'),
  ('pel--prime--1970-06-21','pele--prime--1970-06-21'),
  ('pep-chavarra','pep-chavarria'),
  ('prime-eusbio','prime-eusebio'),
  ('prime-gerard-piqu','prime-gerard-pique'),
  ('prime-pel','prime-pele'),
  ('prime-ronaldo-nazrio','prime-ronaldo-nazario'),
  ('ronaldo-nazrio--prime--1997-05-14','ronaldo-nazario--prime--1997-05-14'),
  ('tarik-muharemovi','tarik-muharemovic')
)
insert into public.player_profiles (player_slug, player_data, created_at, updated_at)
select m.new_slug, p.player_data, p.created_at, p.updated_at
from m join public.player_profiles p on p.player_slug = m.old_slug
on conflict (player_slug) do nothing;
