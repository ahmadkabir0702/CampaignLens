-- =====================================================================
--  020 — Share of voice: skin cleansing configuration for the weekly run
--
--  Where each brand publishes, how it is named, and what the industry
--  searches are. Run after 019. Safe to re-run. To pause the weekly run
--  for this category: update sov_category_config set is_automated = false.
-- =====================================================================

begin;

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/LifebuoySriLanka', instagram_handle = 'lifebuoy.sl', tiktok_handle = 'lifebuoysrilankaofficial',
  terms = array['life\s?buoy', 'ලයිෆ්\s?බෝයි', 'லைஃப்\s?பாய்']::text[],
  hashtags = array['lifebuoy', 'lifebuoysrilanka', 'lifebuoysl']::text[],
  searches = array['lifebuoy soap', 'lifebuoy sri lanka', 'lifebuoy handwash']::text[],
  is_ambiguous = false, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Lifebuoy';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/LuxSriLanka', instagram_handle = 'lux.sl', tiktok_handle = 'luxsrilanka',
  terms = array['\blux\b', 'ලක්ස්', 'லக்ஸ்']::text[],
  hashtags = array['luxsrilanka', 'luxbodywash', 'luxsoap']::text[],
  searches = array['lux soap', 'lux body wash', 'lux sri lanka']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Lux';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/PearsSriLanka', instagram_handle = 'pearssrilanka', tiktok_handle = 'pears_srilanka',
  terms = array['\bpears\b', 'පෙයාර්ස්', 'பியர்ஸ்']::text[],
  hashtags = array['pearssrilanka', 'pearssoap']::text[],
  searches = array['pears soap', 'pears sri lanka']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Pears';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/calin.lk', instagram_handle = 'calin_pvt.ltd', tiktok_handle = 'calin.soap',
  terms = array['\bcalin\b', 'කැලින්', 'கலின்']::text[],
  hashtags = array['calinsoap', 'calin']::text[],
  searches = array['calin soap']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Calin';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/BabyCheramy', instagram_handle = 'babycheramy.sl', tiktok_handle = 'babycheramytv',
  terms = array['baby\s?cheramy', '\bcheramy\b', 'බේබි\s?චෙරමි', 'චෙරමි']::text[],
  hashtags = array['babycheramy']::text[],
  searches = array['baby cheramy soap', 'baby cheramy']::text[],
  is_ambiguous = false, page_scope = 'multi'
where category_id = 'skin_cleansing' and brand_name = 'Baby Cheramy';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/GoyaSriLanka', instagram_handle = 'goya_srilanka', tiktok_handle = 'goyasrilanka',
  terms = array['\bgoya\b', 'ගෝයා', 'கோயா']::text[],
  hashtags = array['goyasrilanka', 'goyasoap']::text[],
  searches = array['goya soap', 'goya sri lanka']::text[],
  is_ambiguous = true, page_scope = 'multi'
where category_id = 'skin_cleansing' and brand_name = 'Goya';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/VelvetSriLanka', instagram_handle = 'velvet.sl', tiktok_handle = 'velvet.soft_skin',
  terms = array['\bvelvet\b', 'වෙල්වට්', 'வெல்வெட்']::text[],
  hashtags = array['velvetsrilanka', 'velvetsoap']::text[],
  searches = array['velvet soap', 'velvet soap sri lanka']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Velvet';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/Championsoap', instagram_handle = 'champion.soap', tiktok_handle = 'championsoapsl',
  terms = array['\bchampion\b', 'චැම්පියන්']::text[],
  hashtags = array['championsoap']::text[],
  searches = array['champion soap']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Champion';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/DettolSriLanka', instagram_handle = 'dettol.srilanka', tiktok_handle = 'dettol_srilanka',
  terms = array['dettol', 'ඩෙටෝල්', 'டெட்டால்']::text[],
  hashtags = array['dettolsrilanka', 'dettol']::text[],
  searches = array['dettol soap', 'dettol sri lanka', 'dettol handwash']::text[],
  is_ambiguous = false, page_scope = 'multi'
where category_id = 'skin_cleansing' and brand_name = 'Dettol';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/profile.php?id=100064748286517', instagram_handle = 'swadeshi_khomba', tiktok_handle = 'swadeshikhomba',
  terms = array['khomba', 'kohomba', 'කොහොඹ', 'swadeshi', 'ස්වදේශි']::text[],
  hashtags = array['swadeshikhomba', 'khomba', 'khombasoap']::text[],
  searches = array['khomba soap', 'swadeshi khomba']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Khomba';

update sov_category_brands set
  facebook_url = 'https://www.facebook.com/RaniSandalwood', instagram_handle = 'ranisandalwood', tiktok_handle = 'ranisandalwood',
  terms = array['rani\s?sandalwood', '\brani\b', 'රනි', 'ராணி']::text[],
  hashtags = array['ranisandalwood']::text[],
  searches = array['rani sandalwood soap', 'rani soap']::text[],
  is_ambiguous = true, page_scope = 'core'
where category_id = 'skin_cleansing' and brand_name = 'Rani';

insert into sov_category_config (category_id, is_automated, scope_note, category_terms, other_products,
  searches, facebook_searches, instagram_searches, hashtags, other_brands, topics, window_days, credit_cap)
values ('skin_cleansing', true,
  'Personal skin cleansing: bar soap (beauty, germ protection, herbal, baby soap), body wash, shower gel, handwash and baby wash. Not laundry soap, dishwash, face wash, creams, lotions, talc, cologne, deodorant, shampoo, diapers, bathroom fittings, bath accessories, paper soap or soap-making supplies.',
  array['soap', 'sabon', 'saban', 'sabun', 'සබන්', 'සබං', 'சோப்', 'body\s?wash', 'shower\s?gel', 'බොඩි\s?වොෂ්', 'hand\s?wash', 'handwash', 'අත්\s?සේදීම', 'bath', 'shower', 'නාන', 'bar\b', 'germ', 'hygiene', 'wash', 'பாடி\s?வாஷ்', 'குளியல்']::text[],
  array['talc', 'powder', 'පවුඩර්', 'cologne', 'perfume', 'deo\b', 'deodorant', 'lotion', 'cream', 'shampoo', 'conditioner', 'toothpaste', 'tooth\s?paste', 'oil\b', 'antiseptic\s?liquid', 'disinfectant', 'surface', 'floor', 'laundry', 'detergent', 'sanitizer', 'sanitiser', 'face\s?wash', 'facewash', 'serum', 'sunscreen', 'diaper', 'wipes']::text[],
  array['soap sri lanka', 'body wash sri lanka', 'shower gel sri lanka', 'hand wash sri lanka', 'bathing soap sri lanka', 'beauty soap sri lanka', 'සබන්', 'නාන සබන්', 'බොඩි වොෂ්', 'soap eka', 'body wash eka', 'குளியல் சோப்பு', 'பாடி வாஷ்', 'best soap sri lanka', 'best body wash sri lanka', 'soap review sri lanka', 'body wash review sri lanka', 'හොඳම සබන්', 'hodama soap', 'hoda soap eka mokakda', 'මොන සබන්ද හොඳ', 'soap recommendation sri lanka', 'சிறந்த சோப்பு', 'whitening soap sri lanka', 'glowing skin soap sri lanka', 'සුදු වෙන්න සබන්', 'sudu wenna soap', 'හම සුදු කරන සබන්', 'kojic soap sri lanka', 'glutathione soap sri lanka', 'pimple soap sri lanka', 'කුරුලෑ වලට සබන්', 'kurulu walata soap', 'acne soap sri lanka', 'oily skin soap sri lanka', 'முகப்பரு சோப்பு', 'dry skin soap sri lanka', 'වියළි සමට සබන්', 'sensitive skin soap sri lanka', 'moisturizing body wash sri lanka', 'itchy skin soap sri lanka', 'body odor soap sri lanka', 'ඇඟ ගඳ', 'දහඩිය ගඳ නැති කරන්න', 'smell good all day sri lanka', 'long lasting fragrance body wash', 'antibacterial soap sri lanka', 'germ protection soap', 'handwash kids sri lanka', 'විෂබීජ නාශක සබන්', 'herbal soap sri lanka', 'ayurvedic soap sri lanka', 'natural soap sri lanka', 'කොහොඹ සබන්', 'කහ සබන්', 'සඳුන් සබන්', 'ආයුර්වේද සබන්', 'kohomba soap', 'kaha soap', 'sandalwood soap sri lanka', 'வேப்ப சோப்பு', 'மஞ்சள் சோப்பு', 'சந்தன சோப்பு', 'மூலிகை சோப்பு', 'goat milk soap sri lanka', 'charcoal soap sri lanka', 'rice soap sri lanka', 'aloe vera soap sri lanka', 'glycerin soap sri lanka', 'niacinamide body wash sri lanka', 'baby soap sri lanka', 'baby bath sri lanka', 'ළදරු සබන්', 'බබාට සබන්', 'baby wash sri lanka', 'shower routine sri lanka', 'body care routine sri lanka', 'skincare routine sri lanka', 'everything shower sri lanka', 'budget skincare sri lanka', 'bath routine sinhala', 'soap price sri lanka', 'සබන් මිල', 'soap price increase sri lanka', 'keells haul', 'cargills haul', 'daraz skincare haul', 'soap offer sri lanka', 'dove body wash sri lanka', 'nivea body wash sri lanka', 'palmolive sri lanka', 'korean body wash sri lanka', 'imported soap sri lanka', 'medimix soap sri lanka', 'himalaya soap sri lanka', 'spa ceylon body wash', 'nature''s secrets soap', 'siddhalepa soap', 'handmade soap sri lanka', 'organic soap sri lanka']::text[],
  array['සබන්', 'body wash sri lanka', 'soap sri lanka', 'නාන සබන්', 'හොඳම සබන්', 'best soap sri lanka', 'body wash review sri lanka', 'සුදු වෙන්න සබන්', 'whitening soap sri lanka', 'කුරුලෑ වලට සබන්', 'dry skin soap sri lanka', 'ඇඟ ගඳ නැති කරන්න', 'antibacterial soap sri lanka', 'කොහොඹ සබන්', 'කහ සබන්', 'herbal soap sri lanka', 'ආයුර්වේද සබන්', 'baby soap sri lanka', 'ළදරු සබන්', 'සබන් මිල', 'soap price sri lanka', 'handmade soap sri lanka', 'organic soap sri lanka']::text[],
  array['body wash sri lanka', 'soap sri lanka', 'best body wash sri lanka', 'soap review sri lanka', 'herbal soap sri lanka', 'ayurvedic soap sri lanka', 'shower routine sri lanka', 'body care routine sri lanka', 'skincare sri lanka', 'handmade soap sri lanka', 'spa ceylon body wash']::text[],
  array['srilankanskincare', 'skincaresrilanka', 'srilankabeauty', 'slskincare', 'skincaresl', 'srilankanbeauty', 'srilankanmom', 'සබන්', 'handmadesoapsrilanka', 'srilankanbrands']::text[],
  '{"Dove": {"pattern": "\\bdove\\b", "group": "Imported"}, "Nivea": {"pattern": "nivea", "group": "Imported"}, "Palmolive": {"pattern": "palmolive", "group": "Imported"}, "Medimix": {"pattern": "medimix", "group": "Imported"}, "Himalaya": {"pattern": "himalaya", "group": "Imported"}, "Spa Ceylon": {"pattern": "spa\\s?ceylon", "group": "Local herbal and home brand"}, "Nature''s Secrets": {"pattern": "nature''?s\\s?secret", "group": "Local herbal and home brand"}, "Siddhalepa": {"pattern": "siddhalepa", "group": "Local herbal and home brand"}, "Chandanalepa": {"pattern": "chandanalepa", "group": "Local herbal and home brand"}, "Shello": {"pattern": "shello", "group": "Local herbal and home brand"}, "Santoor": {"pattern": "santoor", "group": "Imported"}, "Cinthol": {"pattern": "cinthol", "group": "Imported"}, "Vaseline": {"pattern": "vaseline", "group": "Imported"}, "Sunlight": {"pattern": "\\bsunlight\\b", "group": "Laundry soap used on skin"}, "Sha Herbal (Magic Soap)": {"pattern": "sha\\s?herbal|shainisha|magic\\s?soap", "group": "Local herbal and home brand"}, "Thinu Soapy Co": {"pattern": "thinu\\s?soap", "group": "Local herbal and home brand"}, "Reviva": {"pattern": "\\breviva\\b", "group": "Local herbal and home brand"}, "Teashell": {"pattern": "teashell", "group": "Local herbal and home brand"}, "O''nelle": {"pattern": "o''?nelle", "group": "Local herbal and home brand"}, "Venivel": {"pattern": "venivel", "group": "Local herbal and home brand"}, "Safeguard": {"pattern": "safe\\s?guard", "group": "Imported"}, "Cetaphil": {"pattern": "cetaphil", "group": "Imported"}, "Johnson''s Baby": {"pattern": "johnson''?s\\s?baby", "group": "Imported"}}'::jsonb,
  '{"price/value": "Price and value", "fairness/whitening/glow": "Fairness and glow", "herbal/natural": "Herbal and natural", "softness/moisture": "Softness and moisture", "acne/pimples": "Acne and pimples", "fragrance": "Fragrance", "skin problems other": "Other skin problems", "freshness/odour": "Freshness and body odour", "ambassador/celebrity": "Ambassador or celebrity", "baby/gentle": "Gentle for babies", "pack/format": "Pack and format", "family/kids": "Family and kids", "germ protection/hygiene": "Germ protection"}'::jsonb,
  28, 1500)
on conflict (category_id) do update set
  is_automated = excluded.is_automated, scope_note = excluded.scope_note, category_terms = excluded.category_terms,
  other_products = excluded.other_products, searches = excluded.searches, facebook_searches = excluded.facebook_searches,
  instagram_searches = excluded.instagram_searches, hashtags = excluded.hashtags, other_brands = excluded.other_brands, topics = excluded.topics,
  window_days = excluded.window_days, credit_cap = excluded.credit_cap, updated_at = now();

commit;

select brand_name, tiktok_handle, array_length(terms, 1) as terms from sov_category_brands
 where category_id = 'skin_cleansing' order by sort_order;
