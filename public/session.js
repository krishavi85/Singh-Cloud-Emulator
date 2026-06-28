const originalFetch = window.fetch.bind(window);

window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 401 && location.pathname !== '/login') location.replace('/login');
  return response;
};

async function loadSession() {
  const response = await originalFetch('/api/auth/me', { headers: { Accept: 'application/json' } });
  if (!response.ok) return location.replace('/login');
  const body = await response.json();
  const label = document.querySelector('#currentUser');
  if (label) label.textContent = body.user.email;
}

const logoutButton = document.querySelector('#logoutButton');
if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await originalFetch('/api/auth/logout', { method: 'POST' });
    } finally {
      location.replace('/login');
    }
  });
}

loadSession().catch(() => location.replace('/login'));
