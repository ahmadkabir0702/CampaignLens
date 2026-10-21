/**
 * What an account may use, read from its flags in app_users.
 *
 * One place for the list, so the login, the server gates and the page
 * all agree on which sections exist. A flag that is missing (a column
 * not migrated yet) counts as allowed, matching the column default.
 *
 *   askLens      Ask Lens assistant            can_ask_lens
 *   addCreative  adding creatives              can_add_creative
 *   pretest      Pre-tests                     can_pretest
 *   media        Media Summary                 can_media      (021)
 *   creators     Creators                      can_creators   (021)
 *   sov          Share of voice                can_sov        (021)
 *   signoff      Campaign sign-off             can_signoff    (035)
 *   repurpose    Repurposing                   can_repurpose  (036)
 */
const { query } = require('../db');

const FLAGS = {
  askLens: 'can_ask_lens',
  addCreative: 'can_add_creative',
  pretest: 'can_pretest',
  media: 'can_media',
  creators: 'can_creators',
  sov: 'can_sov',
  signoff: 'can_signoff',
  repurpose: 'can_repurpose',
};

/** Everything allowed: used when an account's flags cannot be read. */
const ALL_ON = Object.fromEntries(Object.keys(FLAGS).map(k => [k, true]));

function fromRow(row) {
  const out = {};
  for (const [k, col] of Object.entries(FLAGS)) out[k] = !row || row[col] !== false;
  return out;
}

/** Read an account's flags. `select *` so it works before and after 021 is run. */
async function loadFeatures(username) {
  const { rows } = await query(`select * from app_users where username = $1`, [username]);
  return fromRow(rows[0]);
}

module.exports = { FLAGS, ALL_ON, fromRow, loadFeatures };
