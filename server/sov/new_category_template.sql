-- =====================================================================
--  Template: add a share of voice category to the monthly run
--
--  Copy this file, replace every <...>, run it in the Supabase SQL editor.
--  Nothing else changes: no code, no n8n edit. n8n checks every day and
--  starts the category from its run_day, because is_automated = true. To
--  try it at once, start a run by hand (docs/share-of-voice.md, "Run one
--  now").
--
--  A new category starts with auto_publish = false: its first run is saved
--  for review, not shown. Internal accounts see it in Campaign Lens under a
--  "Preview" banner. Publish it when it reads right, then set
--  auto_publish = true so later months go live on their own.
--
--  Patterns are JavaScript regular expressions, case-insensitive. Write
--  '\s?' for an optional space, '\b' for a word edge. In SQL strings a
--  single quote is written twice: 'nature''s'.
--
--  Example values below are for a hair care category. Delete them.
-- =====================================================================

begin;

-- 1. The category. category_id: lower case, underscores, never changes.
insert into sov_categories (category_id, name, sort_order)
values ('<hair_care>', '<Hair care>', <20>)
on conflict (category_id) do update set name = excluded.name, sort_order = excluded.sort_order;

-- 2. The brands. One row each, Unilever brands first.
--    brand_id: only for brands that exist in Campaign Lens
--              (select brand_id, name from brands). That link decides who
--              sees the category. Competitors: null.
--    facebook_url / instagram_handle / tiktok_handle: the brand's Sri Lanka
--              pages. Handles without '@'. Leave null if there is none.
--    terms:    every way people write the name, any script.
--    hashtags: the brand's own hashtags, without '#'.
--    searches: 2 to 4 phrases people would search for this brand here.
--    is_ambiguous: true when the name is also an ordinary word (Clear,
--              Dove, Velvet). It then only counts next to a category word
--              or the brand's own hashtag or handle.
--    page_scope: 'core' if the brand's page is all this category,
--              'multi' if it sells other things too (Dove sells soap and
--              shampoo; only posts naming the category count).
insert into sov_category_brands
  (category_id, brand_name, brand_id, owner, is_unilever, sort_order,
   facebook_url, instagram_handle, tiktok_handle, terms, hashtags, searches, is_ambiguous, page_scope)
values
  ('<hair_care>', '<Sunsilk>', '<sunsilk>', 'Unilever', true, 10,
   '<https://www.facebook.com/SunsilkSriLanka>', '<sunsilksl>', '<sunsilksrilanka>',
   array['<sunsilk>', '<සන්සිල්ක්>'], array['<sunsilksl>'], array['<sunsilk shampoo sri lanka>', '<sunsilk review>'],
   false, 'core'),
  ('<hair_care>', '<Competitor>', null, '<Owner company>', false, 20,
   null, '<handle>', '<handle>',
   array['<name>'], array[]::text[], array['<name shampoo sri lanka>'],
   false, 'multi')
on conflict (category_id, brand_name) do update set
  brand_id = excluded.brand_id, owner = excluded.owner, is_unilever = excluded.is_unilever, sort_order = excluded.sort_order,
  facebook_url = excluded.facebook_url, instagram_handle = excluded.instagram_handle, tiktok_handle = excluded.tiktok_handle,
  terms = excluded.terms, hashtags = excluded.hashtags, searches = excluded.searches,
  is_ambiguous = excluded.is_ambiguous, page_scope = excluded.page_scope;

-- 3. What the category is and what to search.
insert into sov_category_config
  (category_id, is_automated, scope_note, category_terms, other_products,
   searches, facebook_searches, instagram_searches, hashtags, other_brands, topics, window_days, credit_cap,
   cadence, run_day, auto_publish)
values ('<hair_care>', true,
  -- One or two sentences for the labeller: what is in, what is out.
  '<Shampoo, conditioner, hair oil and hair masks. Not hair dye, styling gels, combs or salon services.>',
  -- category_terms: words that show a text is about the category (any script).
  array['<shampoo>', '<ෂැම්පු>', '<conditioner>', '<hair\s?oil>', '<කොණ්ඩ>', '<hair\s?fall>', '<dandruff>'],
  -- other_products: things the same brand pages sell that are NOT this category.
  array['<soap>', '<body\s?wash>', '<lotion>', '<toothpaste>'],
  -- searches: industry searches (run on TikTok). Aim for 60 to 100, mixing English,
  -- Sinhala, Tamil and Singlish, and needs (hair fall, dandruff, frizz), price,
  -- reviews and routines. Each one costs about 1 to 3 credits a week.
  array['<shampoo sri lanka>', '<best shampoo sri lanka>', '<hair fall shampoo sri lanka>', '<ෂැම්පු>', '<කොණ්ඩය යන එක නවත්තන්න>'],
  -- facebook_searches / instagram_searches: the 10 to 25 strongest of the above.
  array['<shampoo sri lanka>', '<ෂැම්පු>'],
  array['<shampoo sri lanka>', '<hair care routine sri lanka>'],
  -- hashtags: Sri Lanka-specific ones only, without '#'.
  array['<srilankanhaircare>', '<haircaresl>'],
  -- other_brands: brands outside the tracker, for the earned conversation view.
  --   group is how they are coloured: Imported, Local herbal and home brand, or anything you choose.
  '{"<Pantene>": {"pattern": "<pantene>", "group": "Imported"},
    "<Kumarika>": {"pattern": "<kumarika>", "group": "Local herbal and home brand"}}'::jsonb,
  -- topics: themes to tag, code -> name shown in Campaign Lens. 8 to 14 works well.
  '{"<hair fall>": "<Hair fall>", "<dandruff>": "<Dandruff>", "<price/value>": "<Price and value>",
    "<fragrance>": "<Fragrance>", "<shine/smooth>": "<Shine and smoothness>", "<herbal/natural>": "<Herbal and natural>"}'::jsonb,
  28,     -- window_days: only used by a weekly category
  2500,   -- credit_cap: most credits one monthly run may use. The first run may use up to SOV_FIRST_RUN_CAP.
  'monthly', -- cadence: 'monthly' (the last full calendar month) or 'weekly'
  4,      -- run_day: the day of the month the run becomes due. Spread categories over the 3rd to the 6th.
  false)  -- auto_publish: false until the first run has been reviewed
on conflict (category_id) do update set
  is_automated = excluded.is_automated, scope_note = excluded.scope_note, category_terms = excluded.category_terms,
  other_products = excluded.other_products, searches = excluded.searches, facebook_searches = excluded.facebook_searches,
  instagram_searches = excluded.instagram_searches, hashtags = excluded.hashtags, other_brands = excluded.other_brands,
  topics = excluded.topics, window_days = excluded.window_days, credit_cap = excluded.credit_cap,
  cadence = excluded.cadence, run_day = excluded.run_day, updated_at = now();
  -- auto_publish is left as it is on re-run, so a reviewed category stays live.

commit;

-- Check: one row per brand, with handles.
select brand_name, brand_id, facebook_url is not null as fb, instagram_handle, tiktok_handle, cardinality(terms) as terms
  from sov_category_brands where category_id = '<hair_care>' order by sort_order;
