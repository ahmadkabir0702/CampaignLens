-- =====================================================================
--  009_creator_led.sql — brand-made content that a creator fronts
--
--  Brand Say and Others Say split on who produced the content. They do
--  not capture a third common case: content the brand made and owns,
--  built around a creator. It is not Others Say, because the brand
--  briefed, shot and published it. But it does not behave like ordinary
--  brand content either, which is the whole reason for tagging it.
--
--  A flag rather than a category, so it can be compared with and
--  without while everything that reads `type` keeps working.
--
--  Safe to run more than once.
-- =====================================================================

alter table creatives add column if not exists creator_led boolean;

comment on column creatives.creator_led is
  'Brand Say content led by or built around a creator. Null on Others Say, where the creator made it rather than fronted it.';

-- Nothing is assumed about what already exists. Null means nobody has
-- said, which is different from false.
