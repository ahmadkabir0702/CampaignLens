// =====================================================================
//  motion.js — springs, gestures and press feedback
//
//  Campaign Lens loads plain scripts with no bundler, so there is no
//  Motion or Framer Motion to import. This is the small part of them we
//  actually need, written to the same rules:
//
//    a spring animates from the value on screen right now, not from the
//    value we last decided it should have;
//
//    re-targeting a spring mid-flight keeps its velocity, so grabbing a
//    moving panel and sending it the other way is continuous rather than
//    a cut;
//
//    the gesture's release velocity is handed to the spring, so there is
//    no seam between dragging and animating.
//
//  Everything here degrades to an instant set under prefers-reduced-motion.
//  Exposed as window.Motion.
// =====================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------
  //  Apple's two parameters, not the physics triplet
  //
  //  Apple replaced mass/stiffness/damping with damping ratio and
  //  response because those are the two a designer can actually reason
  //  about. Motion's spring API calls them bounce and duration. We take
  //  bounce + duration and convert, so the call sites read in the terms
  //  the design guidance uses.
  //
  //  bounce 0   -> damping ratio 1.0, critically damped, no overshoot
  //  bounce 0.2 -> damping ratio 0.8, the value Apple ships for sheets
  // ---------------------------------------------------------------
  //  These are deliberately short. The guidance's 0.3-0.4s response is
  //  for a phone sheet that fills the screen; a panel and a drawer on a
  //  dense desktop dashboard are looked at dozens of times an hour, and
  //  at that frequency anything you can sit and watch is in the way.
  const PRESETS = {
    // Move or reposition something. The default for everything that did
    // not arrive on the end of a gesture.
    move:   { bounce: 0,    duration: 0.22 },
    // A drawer or sheet.
    sheet:  { bounce: 0,    duration: 0.19 },
    // Settling back after a gesture the user abandoned. The only preset
    // with any overshoot at all, because it is the only one that always
    // follows a gesture that carried momentum.
    snap:   { bounce: 0.12, duration: 0.22 },
  };

  const reduced = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------
  //  One rAF loop for every spring
  //
  //  A spring per callback would mean a callback per spring per frame.
  //  They all advance on the same clock instead, which is also the only
  //  way two springs driving the same element stay in step.
  // ---------------------------------------------------------------
  const live = new Set();
  let frame = null, lastT = 0;

  function tick(now) {
    frame = null;
    const dt = lastT ? Math.min((now - lastT) / 1000, 1 / 20) : 1 / 60;
    lastT = now;
    for (const s of Array.from(live)) s._advance(dt);
    if (live.size) frame = requestAnimationFrame(tick);
    else lastT = 0;
  }
  function wake() {
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  class Spring {
    /**
     * @param {function():number} get  reads the CURRENT on-screen value
     * @param {function(number, number)} set  receives (value, velocity)
     */
    constructor(get, set, opts = {}) {
      const p = typeof opts.preset === 'string' ? PRESETS[opts.preset] : null;
      const bounce = opts.bounce !== undefined ? opts.bounce : (p ? p.bounce : 0);
      const duration = opts.duration !== undefined ? opts.duration : (p ? p.duration : 0.4);

      this._get = get;
      this._set = set;
      // Response is not a duration. It is how fast the value reaches the
      // target; the settle time falls out of the parameters.
      this.omega = (2 * Math.PI) / Math.max(duration, 0.05);
      this.zeta = Math.max(0, 1 - bounce);
      this.x = get();
      this.v = opts.velocity || 0;
      this.target = this.x;
      this.onRest = opts.onRest || null;
      this._resting = true;
    }

    /**
     * Point the spring somewhere new. This is the whole interruption
     * story: velocity is NOT reset, and x is re-read from the screen, so
     * a reversal mid-flight carries through instead of hitting a wall.
     */
    to(target, opts = {}) {
      this.target = target;
      this.x = this._get();                       // presentation value
      if (opts.velocity !== undefined) this.v = opts.velocity;
      if (opts.bounce !== undefined) this.zeta = Math.max(0, 1 - opts.bounce);
      if (opts.duration !== undefined) this.omega = (2 * Math.PI) / Math.max(opts.duration, 0.05);
      if (opts.onRest !== undefined) this.onRest = opts.onRest;

      // Reduced motion: no travel, but the end state still happens and
      // the rest callback still fires, so callers need no special case.
      if (reduced()) {
        this.x = target; this.v = 0; this._resting = true;
        live.delete(this);
        this._set(this.x, 0);
        if (this.onRest) this.onRest();
        return this;
      }
      this._resting = false;
      live.add(this);
      wake();
      return this;
    }

    /** Take over from a gesture: adopt its position and its velocity. */
    from(value, velocity) {
      this.x = value;
      this.v = velocity || 0;
      return this;
    }

    stop() {
      this.v = 0;
      this._resting = true;
      live.delete(this);
      return this;
    }

    _advance(dt) {
      const k = this.omega * this.omega;          // stiffness, unit mass
      const c = 2 * this.zeta * this.omega;       // damping
      // Substep so a long frame cannot make the integration explode. A
      // spring that blows up on a dropped frame is worse than no spring.
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = -k * (this.x - this.target) - c * this.v;
        this.v += a * h;
        this.x += this.v * h;
      }
      // Settle on BOTH position and velocity. Position alone stops a
      // spring at the exact moment it is moving fastest through centre.
      // The thresholds are sub-pixel, so the loop exits as soon as the
      // remaining motion stops being visible rather than burning frames
      // on a tail nobody can see.
      if (Math.abs(this.x - this.target) < 0.05 && Math.abs(this.v) < 0.5) {
        this.x = this.target; this.v = 0;
        this._resting = true;
        live.delete(this);
        this._set(this.x, 0);
        if (this.onRest) this.onRest();
        return;
      }
      this._set(this.x, this.v);
    }
  }

  // ---------------------------------------------------------------
  //  Momentum projection
  //
  //  Where the gesture is GOING, not where the finger left off. Snap to
  //  the target nearest the projected point and a flick throws the
  //  element instead of nudging it.
  //
  //  This is Apple's exponential-decay form from the Designing Fluid
  //  Interfaces sample code, not the textbook v^2/(2a): the textbook
  //  version projects much shorter and flicks feel weak.
  // ---------------------------------------------------------------
  function project(velocity, decelerationRate = 0.998) {
    return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
  }

  // ---------------------------------------------------------------
  //  Rubber-banding
  //
  //  Past a boundary the element keeps following, just less and less. A
  //  hard stop reads as frozen; resistance reads as "responsive, but
  //  there is nothing more here".
  // ---------------------------------------------------------------
  function rubberband(overshoot, dimension, constant = 0.55) {
    if (!dimension) return 0;
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  // ---------------------------------------------------------------
  //  Velocity tracking
  //
  //  The last two pointer events are too noisy to release on. A short
  //  history and a 60ms window gives a velocity that matches what the
  //  hand actually did.
  // ---------------------------------------------------------------
  class Tracker {
    constructor() { this.hist = []; }
    add(value) {
      const t = performance.now();
      this.hist.push({ value, t });
      while (this.hist.length > 8) this.hist.shift();
    }
    reset(value) { this.hist = []; this.add(value); }
    velocity() {
      const h = this.hist;
      if (h.length < 2) return 0;
      const last = h[h.length - 1];
      let first = h[0];
      for (let i = h.length - 1; i >= 0; i--) {
        if (last.t - h[i].t > 60) break;
        first = h[i];
      }
      const dt = (last.t - first.t) / 1000;
      if (dt <= 0) return 0;
      return (last.value - first.value) / dt;       // px per second
    }
  }

  // ---------------------------------------------------------------
  //  Press feedback
  //
  //  The press is where response is won or lost, so it is not left to
  //  :active. On iOS, :active does not fire on non-button elements
  //  without a touch listener, and these cards and tiles are divs.
  //  A pointerdown class is instant everywhere and gives CSS one hook.
  //
  //  Hysteresis: moving more than a few pixels means the pointer is
  //  scrolling or dragging, not pressing, so the press is released
  //  rather than held through the gesture.
  // ---------------------------------------------------------------
  const PRESS_SELECTOR = '[data-press]';
  const SLOP = 10;

  function installPress() {
    let el = null, sx = 0, sy = 0;

    const release = () => {
      if (el) el.classList.remove('is-pressed');
      el = null;
    };

    document.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const t = e.target.closest ? e.target.closest(PRESS_SELECTOR) : null;
      if (!t) return;
      el = t; sx = e.clientX; sy = e.clientY;
      el.classList.add('is-pressed');
    }, { passive: true });

    document.addEventListener('pointermove', (e) => {
      if (!el) return;
      if (Math.abs(e.clientX - sx) > SLOP || Math.abs(e.clientY - sy) > SLOP) release();
    }, { passive: true });

    document.addEventListener('pointerup', release, { passive: true });
    document.addEventListener('pointercancel', release, { passive: true });
    // A press that ends outside the window should not stay lit.
    window.addEventListener('blur', release);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPress);
  } else {
    installPress();
  }

  // ---------------------------------------------------------------
  //  Helpers the call sites use
  // ---------------------------------------------------------------

  /** Read an element's live translateY, in px, from the compositor. */
  function currentY(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    const m = new DOMMatrixReadOnly(t);
    return m.m42;
  }

  /**
   * Anchor a panel to the thing that opened it, so it emerges from
   * where it came from and returns the same way.
   */
  function anchorOrigin(panel, trigger) {
    if (!panel || !trigger) return;
    const p = panel.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    if (!p.width || !p.height) return;
    const x = ((t.left + t.width / 2) - p.left) / p.width * 100;
    const y = ((t.top + t.height / 2) - p.top) / p.height * 100;
    panel.style.transformOrigin =
      `${Math.max(-20, Math.min(120, x))}% ${Math.max(-20, Math.min(120, y))}%`;
  }

  window.Motion = {
    Spring, Tracker, PRESETS,
    spring: (get, set, opts) => new Spring(get, set, opts),
    project, rubberband, reduced, currentY, anchorOrigin,
  };
})();
