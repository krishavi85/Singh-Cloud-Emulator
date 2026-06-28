const root = document.querySelector('#workbenchContent');
root.textContent = 'Loading platform workbench...';
fetch('/api/platform/capabilities')
  .then((response) => response.json())
  .then((body) => {
    root.textContent = JSON.stringify(body, null, 2);
  })
  .catch((error) => {
    root.textContent = error.message;
  });
