async function loadOperationsKeys() {
  try {
    const body = await window.operationsRequest('/api/platform/api-keys');
    document.querySelector('#apiKeyList').innerHTML = body.apiKeys.map((key) => window.operationsCard(
      key.name,
      key.revokedAt ? 'revoked' : key.environment,
      `${key.tokenHint} · ${(key.scopes || []).join(', ')}`,
      key.revokedAt ? '' : `<button data-revoke-service-key="${window.operationsEscape(key.id)}">Revoke</button>`
    )).join('') || '<p class="muted">No service keys.</p>';
  } catch (error) {
    document.querySelector('#apiKeyList').textContent = error.message;
  }
}

document.querySelector('#createApiKey').addEventListener('click', async () => {
  try {
    const scopes = document.querySelector('#apiKeyScopes').value.split(',').map((item) => item.trim()).filter(Boolean);
    const body = await window.operationsRequest('/api/platform/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: document.querySelector('#apiKeyName').value, scopes })
    });
    document.querySelector('#newApiKey').textContent = body.token;
    window.operationsNotify('Copy the new service key now. It will not be shown again.');
    await loadOperationsKeys();
  } catch (error) {
    window.operationsNotify(error.message);
  }
});

document.querySelector('#apiKeyList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-revoke-service-key]');
  if (!button) return;
  try {
    await window.operationsRequest(`/api/platform/api-keys/${encodeURIComponent(button.dataset.revokeServiceKey)}`, { method: 'DELETE', body: '{}' });
    window.operationsNotify('Service key revoked.');
    await loadOperationsKeys();
  } catch (error) {
    window.operationsNotify(error.message);
  }
});

loadOperationsKeys();
