-- ════════════════════════════════════════════════════════════════════
--  Tropa Club — v113
--
--  ЩО ЦЕ ВИПРАВЛЯЄ
--  Помилка «Nevirnyi PIN» при зміні кольору папки була моя. Я вписав
--  PIN у нові функції жорстко, узявши старий восьмизначний із довідника,
--  а ти вводиш інший. Тепер PIN у нових функціях НЕ записаний узагалі:
--  вони питають у check_pin — тієї самої функції, яка пускає тебе в
--  режим організатора. Отже розійтися вони більше не можуть, і при
--  зміні PIN правити треба буде тільки одне місце, як і раніше.
--
--  ЯК ВИКОНУВАТИ
--   • кожен блок — у НОВІЙ чистій вкладці (кнопка «+»)
--   • на вікно «Potential issues detected» → Run without RLS
--   • «Success. No rows returned» — це успіх
--
--  Якщо блоки з supabase-v110.sql ти ВЖЕ виконував — БЛОК 1 і БЛОК 3
--  звідти пропусти, вони нічого не змінять. Обов'язковий тут — БЛОК А.
-- ════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────
--  БЛОК А — замінити чотири функції. Обов'язковий.
-- ─────────────────────────────────────────────────────────────────

drop function if exists public.save_album_meta(text, text, text, text, text);
drop function if exists public.save_album_group(text, text, int, text);
drop function if exists public.save_useful_sheet(text, text, text, int, text);
drop function if exists public.delete_useful_sheet(text, text);

create or replace function public.save_album_meta(p_folder_id text, p_group_id text, p_ink text, p_tile text, p_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.check_pin(p_pin) then raise exception 'Nevirnyi PIN'; end if;
  insert into public.album_meta (folder_id, group_id, ink, tile, updated_at)
  values (p_folder_id, p_group_id, p_ink, p_tile, now())
  on conflict (folder_id) do update
    set group_id = excluded.group_id, ink = excluded.ink,
        tile = excluded.tile, updated_at = now();
end; $$;

create or replace function public.save_album_group(p_id text, p_title text, p_sort int, p_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.check_pin(p_pin) then raise exception 'Nevirnyi PIN'; end if;
  insert into public.album_groups (id, title, sort) values (p_id, p_title, p_sort)
  on conflict (id) do update set title = excluded.title, sort = excluded.sort;
end; $$;

create or replace function public.save_useful_sheet(p_id text, p_url text, p_title text, p_sort int, p_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.check_pin(p_pin) then raise exception 'Nevirnyi PIN'; end if;
  insert into public.useful_sheets (id, url, title, sort) values (p_id, p_url, p_title, p_sort)
  on conflict (id) do update set url = excluded.url, title = excluded.title, sort = excluded.sort;
end; $$;

create or replace function public.delete_useful_sheet(p_id text, p_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.check_pin(p_pin) then raise exception 'Nevirnyi PIN'; end if;
  delete from public.useful_sheets where id = p_id;
end; $$;


-- ─────────────────────────────────────────────────────────────────
--  БЛОК Б — перевірка. Має показати «функцій 4».
--  Якщо 0 — БЛОК А не виконався, далі не йди.
-- ─────────────────────────────────────────────────────────────────

select 'функцій' as що, count(*)::text as скільки
from pg_proc
where proname in ('save_album_meta','save_album_group','save_useful_sheet','delete_useful_sheet');
