async function loadOperationsOrganizations() {
  try {
    const body = await window.operationsRequest('/api/platform/organizations');
    document.querySelector('#organizationList').innerHTML = body.organizations.map((organization) => window.operationsCard(
      organization.name,
      organization.planId,
      `${organization.id} · ${organization.billingEmail || 'No billing email'}`,
      `<button data-copy-organization="${window.operationsEscape(organization.id)}">Copy ID</button>`
    )).join('') || '<p class="muted">No organizations.</p>';
  } catch (error) {
    document.querySelector('#organizationList').textContent = error.message;
  }
}

document.querySelector('#createOrganization').addEventListener('click', async () => {
  try {
    await window.operationsRequest('/api/platform/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: document.querySelector('#organizationName').value,
        billingEmail: document.querySelector('#organizationBillingEmail').value
      })
    });
    window.operationsNotify('Organization created.');
    await loadOperationsOrganizations();
  } catch (error) {
    window.operationsNotify(error.message);
  }
});

document.querySelector('#assignPlan').addEventListener('click', async () => {
  try {
    const organizationId = document.querySelector('#billingOrganization').value.trim();
    const body = await window.operationsRequest(`/api/platform/organizations/${encodeURIComponent(organizationId)}/subscription`, {
      method: 'POST',
      body: JSON.stringify({ planId: document.querySelector('#billingPlan').value })
    });
    document.querySelector('#billingOutput').textContent = JSON.stringify(body.subscription, null, 2);
    window.operationsNotify('Subscription updated.');
  } catch (error) {
    window.operationsNotify(error.message);
  }
});

document.querySelector('#sendTestEmail').addEventListener('click', async () => {
  try {
    const body = await window.operationsRequest('/api/platform/notifications/test-email', {
      method: 'POST',
      body: JSON.stringify({ recipient: document.querySelector('#testEmail').value })
    });
    document.querySelector('#billingOutput').textContent = JSON.stringify(body.notification, null, 2);
    window.operationsNotify('Notification request completed.');
  } catch (error) {
    window.operationsNotify(error.message);
  }
});

document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-organization]');
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.copyOrganization);
  window.operationsNotify('Organization ID copied.');
});

loadOperationsOrganizations();
window.operationsRequest('/api/platform/billing/status')
  .then((body) => { document.querySelector('#billingOutput').textContent = JSON.stringify(body.billing, null, 2); })
  .catch((error) => { document.querySelector('#billingOutput').textContent = error.message; });
