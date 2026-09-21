/**
 * links.js — link rules for creative platform fields.
 *
 * One file, used in two places so the rules can never drift apart:
 *   browser: <script src="/js/links.js"></script>  -> window.CLLinks
 *   server : require('./public/js/links.js')
 *
 * validate(field, raw) is synchronous and never touches the network. When a
 * link is a short or share link that might point at a valid post, it returns
 * { needsResolve: true } and the server follows the redirect, then calls
 * validate() again on where it landed.
 *
 * Why these rules exist. Each platform field feeds a matcher that extracts an
 * id from the URL, and a link it cannot parse fails SILENTLY: the creative
 * exists, looks fine, and never receives a single stat.
 *   Brand Say Facebook  needs the URL to end in a numeric id
 *   Brand Say TikTok    needs /video/{numeric id}
 *   Instagram collab    needs the real shortcode, which share links do not carry
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CLLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABEL = { ig: 'Instagram', fb: 'Facebook', tt: 'TikTok' };

  function parse(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s); } catch (e) { return null; }
  }

  function hostOf(u) { return u.hostname.toLowerCase().replace(/^(www|m|web|mobile)\./, ''); }

  // Which platform a URL actually belongs to, regardless of the field it was
  // pasted into. Used to catch an Instagram link sitting in the TikTok box.
  function platformOf(u) {
    var h = hostOf(u);
    if (h === 'instagram.com' || h === 'instagr.am') return 'ig';
    if (h === 'tiktok.com' || h === 'vt.tiktok.com' || h === 'vm.tiktok.com') return 'tt';
    if (h === 'facebook.com' || h === 'fb.watch' || h === 'fb.com') return 'fb';
    return null;
  }

  function fail(msg) { return { ok: false, error: msg }; }
  function resolveMe() { return { ok: false, needsResolve: true }; }
  function pass(url, id) { return { ok: true, url: url, id: id }; }

  // ---------------------------------------------------------------- Instagram
  function checkIg(u) {
    var p = u.pathname;
    var m = p.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
    if (m) return pass('https://www.instagram.com/reel/' + m[1] + '/', m[1]);

    if (/^\/share\//.test(p)) return resolveMe();
    if (/^\/p\//.test(p)) {
      return fail('This is a photo or carousel link. Only reels are tracked. '
        + 'If this is a reel, open it and copy the link from the Reels view.');
    }
    if (/^\/tv\//.test(p)) return fail('IGTV links are not tracked. Only reels are.');
    if (/^\/stories\//.test(p)) return fail('Stories expire and cannot be tracked. Use the reel link.');
    if (/^\/[^/]+\/?$/.test(p)) return fail('This is a profile link. Paste the link to the reel itself.');
    return fail('Not a reel link. It should look like instagram.com/reel/…');
  }

  // ------------------------------------------------------------------ TikTok
  function checkTt(u) {
    var h = hostOf(u);
    var p = u.pathname;

    // Short links carry no video id at all, which is exactly what the Brand
    // Say matcher needs. The server resolves them to the full URL.
    if (h === 'vt.tiktok.com' || h === 'vm.tiktok.com') return resolveMe();
    if (/^\/t\//.test(p)) return resolveMe();

    var m = p.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
    if (m) return pass('https://www.tiktok.com/@' + m[1] + '/video/' + m[2], m[2]);

    if (/^\/@[^/]+\/photo\//.test(p)) {
      return fail('This is a photo slideshow. Only video posts are tracked.');
    }
    if (/^\/@[^/]+\/?$/.test(p)) return fail('This is a profile link. Paste the link to the video itself.');
    if (/^\/@[^/]+\/live/.test(p) || /^\/live/.test(p)) return fail('Live streams cannot be tracked.');
    if (/^\/tag\//.test(p)) return fail('This is a hashtag page, not a video.');
    return fail('Not a TikTok video link. It should look like tiktok.com/@…/video/…');
  }

  // ---------------------------------------------------------------- Facebook
  function checkFb(u) {
    var h = hostOf(u);
    var p = u.pathname;

    if (h === 'fb.watch') return resolveMe();
    if (/^\/share\//.test(p)) return resolveMe();

    var m = p.match(/^\/reel\/(\d+)\/?$/);
    if (m) return pass('https://www.facebook.com/reel/' + m[1] + '/', m[1]);

    // /watch/?v=123 carries the id in the query string, which the Brand Say
    // matcher cannot read. Rewriting to /reel/ puts it at the end of the path.
    if (/^\/watch\/?$/.test(p) && /^\d+$/.test(u.searchParams.get('v') || '')) {
      var v = u.searchParams.get('v');
      return pass('https://www.facebook.com/reel/' + v + '/', v);
    }

    m = p.match(/^\/([^/]+)\/videos\/(?:[^/]+\/)?(\d+)\/?$/);
    if (m) return pass('https://www.facebook.com/' + m[1] + '/videos/' + m[2] + '/', m[2]);

    if (/pfbid/i.test(p)) {
      return fail('This post link has no numeric id and cannot be tracked. '
        + 'Open the video itself and copy that link instead.');
    }
    if (/^\/[^/]+\/posts\//.test(p)) {
      return fail('This is a post link. Click into the video and copy the video link instead.');
    }
    if (/profile\.php/.test(p)) return fail('This is a profile link. Paste the link to the video itself.');
    if (/^\/groups\//.test(p)) return fail('Group posts cannot be tracked.');
    if (/^\/photo/.test(p) || /\/photos\//.test(p)) return fail('This is a photo. Only videos are tracked.');
    return fail('Not a Facebook video link. It should look like facebook.com/reel/… or …/videos/…');
  }

  var CHECK = { ig: checkIg, tt: checkTt, fb: checkFb };

  /**
   * field: 'ig' | 'fb' | 'tt'
   * returns one of:
   *   { ok: true, url, id }          normalised URL and the id matchers use
   *   { ok: false, error }           show this under the field
   *   { ok: false, needsResolve }    server must follow the redirect first
   */
  function validate(field, raw) {
    if (!CHECK[field]) return fail('Unknown field.');
    var u = parse(raw);
    if (!u) return fail('That is not a valid link.');

    var actual = platformOf(u);
    if (!actual) return fail('This is not a ' + LABEL[field] + ' link.');
    if (actual !== field) {
      return fail('This is a ' + LABEL[actual] + ' link. Put it in the '
        + LABEL[actual] + ' field instead.');
    }
    return CHECK[field](u);
  }

  return { validate: validate, platformOf: function (raw) {
    var u = parse(raw); return u ? platformOf(u) : null;
  }, LABEL: LABEL };
});
