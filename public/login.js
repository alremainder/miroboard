// ---- tab switching ----
const tabs = document.querySelectorAll('.tab-btn');
const loginPanel = document.getElementById('login-panel');
const signupPanel = document.getElementById('signup-panel');
tabs.forEach(btn => btn.addEventListener('click', () => {
  tabs.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const mode = btn.dataset.mode;
  loginPanel.hidden = mode !== 'login';
  signupPanel.hidden = mode !== 'signup';
}));

async function postJson(url, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    // Network error or timeout - surface as a failed request instead of hanging forever.
    return { ok: false, status: 0, data: { error: e.name === 'AbortError' ? 'timeout' : 'network_error' } };
  } finally {
    clearTimeout(timer);
  }
}

// ---- login ----
document.getElementById('login-btn').addEventListener('click', async () => {
  const identifier = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!identifier || !password) { errEl.textContent = 'Please fill in both fields.'; return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const { ok, data } = await postJson('/api/auth/login', { identifier, password });
    if (!ok) {
      errEl.textContent = data.error === 'invalid_credentials' ? 'Incorrect username/email or password.' : 'Something went wrong. Try again.';
      return;
    }
    window.location.href = '/';
  } finally {
    btn.disabled = false; btn.textContent = 'Log in →';
  }
});
document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });

// ---- signup: step 1, send otp ----
let cooldownTimer = null;
async function sendOtp() {
  const email = document.getElementById('signup-email').value.trim();
  const errEl = document.getElementById('signup-email-error');
  errEl.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Enter a valid email address.'; return; }
  const btn = document.getElementById('send-otp-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const { ok, status, data } = await postJson('/api/auth/request-otp', { email });
    if (!ok) {
      if (status === 429) errEl.textContent = 'Please wait a bit before requesting another code.';
      else if (data.error === 'timeout') errEl.textContent = 'That took too long. Please try again.';
      else if (data.error === 'network_error') errEl.textContent = 'Network error — check your connection and try again.';
      else errEl.textContent = 'Could not send the code. Check the email and try again.';
      return;
    }
    document.getElementById('otp-email-label').textContent = email;
    document.getElementById('signup-step-email').classList.remove('active');
    document.getElementById('signup-step-otp').classList.add('active');
  } finally {
    btn.disabled = false; btn.textContent = 'Send code →';
  }
}
document.getElementById('send-otp-btn').addEventListener('click', sendOtp);
document.getElementById('resend-link').addEventListener('click', (e) => { e.preventDefault(); sendOtp(); });

// ---- signup: step 2, verify + create account ----
document.getElementById('create-account-btn').addEventListener('click', async () => {
  const email = document.getElementById('signup-email').value.trim();
  const otp = document.getElementById('otp-code').value.trim();
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const otpErr = document.getElementById('otp-error');
  const err = document.getElementById('signup-error');
  otpErr.textContent = ''; err.textContent = '';

  if (!otp || otp.length !== 6) { otpErr.textContent = 'Enter the 6-digit code.'; return; }
  if (!username || username.length < 3) { err.textContent = 'Username must be at least 3 characters.'; return; }
  if (!password || password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }

  const btn = document.getElementById('create-account-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const { ok, data } = await postJson('/api/auth/signup', { username, email, password, otp });
    if (!ok) {
      const messages = {
        otp_incorrect: 'That code is incorrect.',
        otp_expired: 'That code expired — request a new one.',
        otp_not_requested: 'Request a code first.',
        too_many_attempts: 'Too many attempts — request a new code.',
        email_taken: 'An account with that email already exists.',
        username_taken: 'That username is taken.',
        timeout: 'That took too long. Please try again.',
        network_error: 'Network error — check your connection and try again.',
      };
      (messages[data.error] ? otpErr : err).textContent = messages[data.error] || 'Something went wrong. Try again.';
      return;
    }
    window.location.href = '/';
  } finally {
    btn.disabled = false; btn.textContent = 'Create account →';
  }
});
