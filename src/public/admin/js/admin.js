// ── Sidebar Toggle ──────────────────────────────────────────
document.getElementById('mobile-toggle')?.addEventListener('click', function () {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
});

document.getElementById('sidebar-overlay')?.addEventListener('click', function () {
  document.getElementById('sidebar').classList.remove('open');
  this.classList.remove('open');
});

// ── Modal Helpers ───────────────────────────────────────────
function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    // Focus trap: focus the first focusable element
    var focusable = modal.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
  }
}

function closeModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Close modal on backdrop click
document.querySelectorAll('.modal').forEach(function (modal) {
  modal.addEventListener('click', function (e) {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });
});

// Close modal on Escape
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(function (modal) {
      modal.classList.remove('active');
    });
  }
});

// ── Toast ───────────────────────────────────────────────────
function showToast(message, type) {
  var toast = document.getElementById('toast');
  if (!toast) return;

  toast.className = 'toast toast-' + (type || 'success') + ' show';
  toast.querySelector('.toast-icon').className =
    'toast-icon fas fa-' + (type === 'error' ? 'exclamation-circle' : 'check-circle');
  toast.querySelector('.toast-message').textContent = message;

  setTimeout(function () {
    toast.classList.remove('show');
  }, 3000);
}

/**
 * Show toast then reload after a short delay so the user sees the message.
 */
function toastAndReload(message, type) {
  showToast(message, type || 'success');
  setTimeout(function () { location.reload(); }, 1200);
}

// ── XSS-safe HTML helpers ───────────────────────────────────
/**
 * Escapes HTML entities in a string to prevent XSS when inserting into innerHTML.
 */
function esc(str) {
  if (str == null) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

// ── CSRF Token ─────────────────────────────────────────────
function getCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

// ── Admin Fetch Helper ──────────────────────────────────────
/**
 * Wrapper around fetch with standard JSON handling, CSRF token, and error display.
 */
function adminFetch(url, options) {
  var opts = Object.assign({
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': getCsrfToken()
    }
  }, options || {});

  // Ensure CSRF header is always present even if caller overrides headers
  if (opts.headers && !opts.headers['x-csrf-token']) {
    opts.headers['x-csrf-token'] = getCsrfToken();
  }

  return fetch(url, opts)
    .then(function (r) {
      if (!r.ok) {
        return r.json().then(function (d) {
          throw new Error(d.error || 'Request failed');
        });
      }
      return r.json();
    });
}
