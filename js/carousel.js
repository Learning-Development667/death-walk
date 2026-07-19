/* =====================================================================
   Death March — identity/avatar carousel  (standalone, framework-free)
   ---------------------------------------------------------------------
   Coverflow/rolodex: cards are absolutely stacked at centre, then pushed
   out and resized by layout(). Only 3 are ever visible (centre + 1 each
   side); the rest are opacity:0. Wraps infinitely. One source of truth:
   `this.index`.

   Adapted for Death March's TALL OVAL CAMEO art (transparent corners,
   faces upper-middle): each avatar takes an optional per-image focal
   point and zoom so faces crop in cleanly. See carousel.css.

   ---------------------------------------------------------------------
   USAGE
   ---------------------------------------------------------------------
     <link rel="stylesheet" href="carousel.css">
     <div id="pick"></div>
     <script src="carousel.js"></script>
     <script>
       const carousel = new DMCarousel({
         mount: '#pick',
         avatars: [
           // focus: [x, y] as % (or CSS keywords). Default [50,30] = upper-middle.
           { name: 'Grimwald', src: 'img/grimwald.png', focus: [50, 26] },
           { name: 'Vael',     src: 'img/vael.png',     focus: [50, 32], scale: 1.08 },
           { name: 'Orin',     src: 'img/orin.png' },          // uses the default focus
           { name: 'New Recruit' },                            // no src → initial placeholder
         ],
         startName: 'Vael',                 // or startIndex: 1
         onChange: (a, i) => console.log('centre:', a.name),
         onSelect: (a, i) => console.log('confirmed:', a.name),  // tap the centred cameo / Enter
       });
       // Programmatic control: carousel.go(1), carousel.setIndex(0),
       // carousel.setIndexByName('Orin'), carousel.current()
     </script>
   ===================================================================== */
(function (global) {
  'use strict';

  function focusToken(v) {
    if (v == null) return null;
    return typeof v === 'number' ? v + '%' : String(v);
  }

  function DMCarousel(opts) {
    opts = opts || {};
    this.mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
    if (!this.mount) throw new Error('DMCarousel: mount element not found');

    this.avatars = (opts.avatars || []).slice();
    this.onSelect = opts.onSelect || function () {};
    this.onChange = opts.onChange || function () {};
    this.showArrows = opts.arrows !== false;
    this.swipeThreshold = opts.swipeThreshold || 40;

    this.sizes = Object.assign({ active: 120, near: 80, far: 60 }, opts.sizes || {});
    this.offsets = Object.assign({ near: 120, far: 150 }, opts.offsets || {});

    this.index = 0;
    this.cards = [];
    this._touchX = null;

    this._build();

    var start = opts.startIndex || 0;
    if (opts.startName) {
      var si = this._indexOfName(opts.startName);
      if (si >= 0) start = si;
    }
    this.setIndex(start, true);
    this._entry();
  }

  DMCarousel.prototype._build = function () {
    var self = this;
    this.mount.classList.add('dm-carousel');
    this.mount.innerHTML = '';

    this.track = document.createElement('div');
    this.track.className = 'dm-track';
    this.track.setAttribute('role', 'listbox');
    this.track.tabIndex = 0;
    this.mount.appendChild(this.track);

    this.avatars.forEach(function (a, i) {
      self.track.appendChild(self._buildCard(a, i));
    });

    if (this.showArrows) {
      this.mount.appendChild(this._arrow('left', '‹', -1));
      this.mount.appendChild(this._arrow('right', '›', 1));
    }

    this.track.addEventListener('touchstart', function (e) {
      self._touchX = e.changedTouches[0].clientX;
    }, { passive: true });
    this.track.addEventListener('touchend', function (e) {
      if (self._touchX == null) return;
      var dx = e.changedTouches[0].clientX - self._touchX;
      self._touchX = null;
      if (Math.abs(dx) < self.swipeThreshold) return;
      self.go(dx < 0 ? 1 : -1);
    }, { passive: true });

    var downX = null;
    this.track.addEventListener('mousedown', function (e) { downX = e.clientX; });
    window.addEventListener('mouseup', function (e) {
      if (downX == null) return;
      var dx = e.clientX - downX; downX = null;
      if (Math.abs(dx) >= self.swipeThreshold) self.go(dx < 0 ? 1 : -1);
    });

    this.track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); self.go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); self.go(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); self._confirm(); }
    });
  };

  DMCarousel.prototype._arrow = function (side, glyph, delta) {
    var self = this;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dm-arrow dm-arrow--' + side;
    btn.setAttribute('aria-label', side === 'left' ? 'Previous' : 'Next');
    btn.textContent = glyph;
    btn.addEventListener('click', function () { self.go(delta); });
    return btn;
  };

  DMCarousel.prototype._buildCard = function (a, i) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'dm-card';
    card.setAttribute('role', 'option');
    card.dataset.index = String(i);

    var inner = document.createElement('div'); inner.className = 'dm-card-inner';
    var ring = document.createElement('div'); ring.className = 'dm-ring';
    var frame = document.createElement('div'); frame.className = 'dm-frame';

    if (a.src) {
      var img = document.createElement('img');
      img.className = 'dm-photo';
      img.src = a.src;
      img.alt = a.name || '';
      img.draggable = false;

      var fx = focusToken(a.focus && a.focus[0]);
      var fy = focusToken(a.focus && a.focus[1]);
      if (fx) img.style.setProperty('--dm-focus-x', fx);
      if (fy) img.style.setProperty('--dm-focus-y', fy);

      if (a.scale && a.scale !== 1) {
        img.style.transform = 'scale(' + a.scale + ')';
        img.style.transformOrigin = (fx || '50%') + ' ' + (fy || '30%');
      }
      frame.appendChild(img);
    } else {
      var ph = document.createElement('span');
      ph.className = 'dm-photo dm-photo--placeholder';
      ph.textContent = (a.name || '?').charAt(0).toUpperCase();
      frame.appendChild(ph);
    }

    ring.appendChild(frame);
    inner.appendChild(ring);

    if (a.name) {
      var name = document.createElement('span');
      name.className = 'dm-name';
      name.textContent = a.name;
      inner.appendChild(name);
    }
    card.appendChild(inner);

    card.addEventListener('click', function () {
      if (i === self.index) self._confirm();
      else self.setIndex(i);
    });

    this.cards.push(card);
    return card;
  };

  DMCarousel.prototype.layout = function () {
    var self = this;
    var n = this.cards.length;
    this.cards.forEach(function (card, i) {
      var off = ((i - self.index) % n + n) % n;
      if (off > n / 2) off -= n;
      var abs = Math.abs(off);

      var x, opacity, z, w;
      if (off === 0)      { x = 0;                          opacity = 1;   z = 30; w = self.sizes.active; }
      else if (abs === 1) { x = off * self.offsets.near;    opacity = 0.5; z = 20; w = self.sizes.near; }
      else                { x = (off > 0 ? 1 : -1) * self.offsets.far; opacity = 0; z = 10; w = self.sizes.far; }

      card.style.transform = 'translate(-50%, -50%) translateX(' + x + 'px)';
      card.style.opacity = opacity;
      card.style.zIndex = z;
      card.classList.toggle('is-active', off === 0);

      var frame = card.querySelector('.dm-frame');
      if (frame) frame.style.width = w + 'px';
      var ph = card.querySelector('.dm-photo--placeholder');
      if (ph) ph.style.fontSize = Math.round(w * 0.42) + 'px';
    });
  };

  DMCarousel.prototype._entry = function () {
    var self = this;
    this.cards.forEach(function (card) {
      var inner = card.firstChild;
      var delay = Math.abs(Number(card.dataset.index) - self.index) * 150;
      inner.style.animation = 'none';
      void inner.offsetWidth;
      inner.style.animation = 'dmCardIn 500ms ease-out both';
      inner.style.animationDelay = delay + 'ms';
    });
  };

  DMCarousel.prototype._indexOfName = function (name) {
    for (var i = 0; i < this.avatars.length; i++) {
      if (this.avatars[i] && this.avatars[i].name === name) return i;
    }
    return -1;
  };

  DMCarousel.prototype._confirm = function () {
    this.onSelect(this.avatars[this.index], this.index);
  };

  DMCarousel.prototype.setIndex = function (i, silent) {
    var n = this.cards.length;
    if (!n) return;
    this.index = ((i % n) + n) % n;
    this.layout();
    if (!silent) this.onChange(this.avatars[this.index], this.index);
  };
  DMCarousel.prototype.go = function (delta) { this.setIndex(this.index + delta); };
  DMCarousel.prototype.setIndexByName = function (name) {
    var i = this._indexOfName(name);
    if (i >= 0) this.setIndex(i);
  };
  DMCarousel.prototype.current = function () { return this.avatars[this.index]; };
  DMCarousel.prototype.currentIndex = function () { return this.index; };

  global.DMCarousel = DMCarousel;
  if (typeof module !== 'undefined' && module.exports) module.exports = DMCarousel;

})(typeof window !== 'undefined' ? window : this);
