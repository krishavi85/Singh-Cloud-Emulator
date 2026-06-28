const content = document.querySelector('#shareContent');
const token = new URLSearchParams(location.search).get('token');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

if (!token) {
  content.textContent = 'No share token was provided.';
} else {
  fetch(`/api/platform/share/${encodeURIComponent(token)}`)
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Share could not be opened.');
      return body;
    })
    .then((body) => {
      content.innerHTML = `<h2>${escapeHtml(body.share.resourceType)}</h2><pre>${escapeHtml(JSON.stringify(body.resource, null, 2))}</pre><p>Expires: ${escapeHtml(body.share.expiresAt)}</p>`;
    })
    .catch((error) => { content.textContent = error.message; });
}
